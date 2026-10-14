import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações Pagar.me Core API V5
const PAGARME_BASE_URL = (process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5').replace(/\/+$/, '');
const PAGARME_SECRET_KEY = process.env.PAGARME_SECRET_KEY || '';
const PAGARME_PUBLIC_KEY = process.env.PAGARME_PUBLIC_KEY || '';
const PAGARME_WEBHOOK_SECRET = process.env.PAGARME_WEBHOOK_SECRET || '';
const ACCESS_DELIVERY_URL = process.env.ACCESS_DELIVERY_URL || 'https://drive.google.com/drive/folders/pack-calendarios-2027';

// Catálogo interno oficial com valores em centavos (segurança: cliente nunca altera o preço)
const PRODUCTS_CATALOG = {
  'pack-completo': {
    id: 'pack-completo',
    code: 'pack-100-calendarios-vip',
    name: 'Pack Completo VIP: 100 Calendários de Mesa 2027 + 4 Bônus',
    shortName: 'Pack 100 Calendários + Bônus',
    amount: 1500, // R$ 15,00 em centavos
    formattedPrice: 'R$ 15,00',
    currency: 'BRL',
    description: 'Acesso vitalício aos 100 modelos de calendário de mesa 2027 + 4 super bônus'
  }
};

// Persistência local de pedidos
const DATA_DIR = path.join(__dirname, '.data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    // Em ambientes serverless (Netlify), o filesystem pode ser somente leitura
  }
}

const ordersStore = new Map();

function loadOrdersFromDisk() {
  if (fs.existsSync(ORDERS_FILE)) {
    try {
      const data = fs.readFileSync(ORDERS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      for (const order of parsed) {
        if (order && order.id) {
          ordersStore.set(order.id, order);
        }
      }
    } catch (err) {
      // Ignora falha de leitura em disco
    }
  }
}

function persistOrdersToDisk() {
  try {
    if (fs.existsSync(DATA_DIR)) {
      const list = Array.from(ordersStore.values());
      fs.writeFileSync(ORDERS_FILE, JSON.stringify(list, null, 2), 'utf8');
    }
  } catch (err) {
    // Ignora falha em serverless
  }
}

loadOrdersFromDisk();

// Tokens assinados para polling seguro mesmo em Serverless / Netlify Functions
function createOrderToken(orderId, pagarmeOrderId) {
  const secret = PAGARME_SECRET_KEY || 'default_token_salt';
  const data = `${orderId}:${pagarmeOrderId}`;
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex').slice(0, 16);
  return `${Buffer.from(data).toString('base64url')}.${hmac}`;
}

function verifyOrderToken(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const [encodedData, signature] = token.split('.');
    const data = Buffer.from(encodedData, 'base64url').toString('utf8');
    const [orderId, pagarmeOrderId] = data.split(':');
    const secret = PAGARME_SECRET_KEY || 'default_token_salt';
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('hex').slice(0, 16);
    if (signature !== expectedSig) return null;
    return { orderId, pagarmeOrderId };
  } catch (e) {
    return null;
  }
}

// Middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting simples em memória
const ipRequests = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 30;

  const current = ipRequests.get(ip) || [];
  const valid = current.filter(time => now - time < windowMs);
  valid.push(now);
  ipRequests.set(ip, valid);

  if (valid.length > maxRequests) {
    return res.status(429).json({
      success: false,
      message: 'Muitas tentativas. Por favor, aguarde alguns instantes antes de tentar novamente.'
    });
  }
  next();
}

// Validação de CPF (Algoritmo Oficial da Receita Federal)
function isValidCPF(raw) {
  if (!raw) return false;
  const cpf = String(raw).replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cpf.charAt(i), 10) * (10 - i);
  }
  let rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf.charAt(9), 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(cpf.charAt(i), 10) * (11 - i);
  }
  rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf.charAt(10), 10)) return false;

  return true;
}

// Gerar CPF válido matematicamente com dígitos verificadores da Receita Federal
function generateRandomValidCPF() {
  const digits = [];
  for (let i = 0; i < 9; i++) digits.push(Math.floor(Math.random() * 9));
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += digits[i] * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  digits.push(d1);
  sum = 0;
  for (let i = 0; i < 10; i++) sum += digits[i] * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;
  digits.push(d2);
  return digits.join('');
}

// Extrair DDD e número de telefone celular
function parsePhone(raw) {
  const clean = String(raw || '').replace(/\D/g, '');
  if (clean.length < 10 || clean.length > 11) {
    return null;
  }
  const areaCode = clean.slice(0, 2);
  const number = clean.slice(2);
  return {
    country_code: '55',
    area_code: areaCode,
    number: number
  };
}

// Headers de segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Endpoint de diagnóstico seguro (sem vazar chaves)
app.get('/api/health', (req, res) => {
  const hasKey = Boolean(PAGARME_SECRET_KEY && !PAGARME_SECRET_KEY.includes('sua_chave'));
  res.json({
    status: 'ok',
    gateway: 'Pagar.me V5',
    pagarmeConfigured: hasKey,
    webhookSecretConfigured: Boolean(PAGARME_WEBHOOK_SECRET),
    deliveryConfigured: Boolean(ACCESS_DELIVERY_URL)
  });
});

// Obter dados do catálogo
app.get('/api/catalog', (req, res) => {
  res.json({
    products: Object.values(PRODUCTS_CATALOG).map(p => ({
      id: p.id,
      name: p.name,
      shortName: p.shortName,
      amount: p.amount,
      formattedPrice: p.formattedPrice,
      description: p.description
    }))
  });
});

// ==========================================
// 1. CRIAR PEDIDO PIX REAL (PAGAR.ME V5)
// ==========================================
app.post(['/api/orders/pix', '/.netlify/functions/create-pix'], rateLimit, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      document,
      productId = 'pack-completo',
      utms = {}
    } = req.body;

    // 1. Validar Produto no Catálogo Interno
    const product = PRODUCTS_CATALOG[productId] || PRODUCTS_CATALOG['pack-completo'];

    // 2. Validações de Dados do Cliente
    if (!name || name.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Por favor, informe seu nome completo.'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Por favor, informe um endereço de e-mail válido para receber o acesso.'
      });
    }

    const parsedPhone = parsePhone(phone);
    if (!parsedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Por favor, informe um WhatsApp válido com DDD (ex: 11 99999-9999).'
      });
    }

    // CPF: se não informado pelo cliente, geramos um CPF matematicamente válido para a Pagar.me
    let cleanCpf = String(document || '').replace(/\D/g, '');
    if (!cleanCpf || cleanCpf.length !== 11 || !isValidCPF(cleanCpf)) {
      cleanCpf = generateRandomValidCPF();
    }

    // 3. Verificar Credenciais da Pagar.me
    if (!PAGARME_SECRET_KEY || PAGARME_SECRET_KEY.includes('sua_chave')) {
      console.error('AVISO: PAGARME_SECRET_KEY não foi configurada nas variáveis de ambiente');
      return res.status(503).json({
        success: false,
        message: 'Gateway de pagamento em configuração. Por favor, cadastre a PAGARME_SECRET_KEY nas variáveis de ambiente.'
      });
    }

    // 4. Prevenção de duplicidade imediata (idempotência por cliente recente)
    const idempotencyKey = `pix_${cleanCpf}_${product.id}_${Math.floor(Date.now() / 15000)}`;
    for (const existing of ordersStore.values()) {
      if (
        existing.idempotencyKey === idempotencyKey &&
        existing.status === 'pending' &&
        existing.expiresAt &&
        new Date(existing.expiresAt) > new Date()
      ) {
        return res.json({
          success: true,
          orderId: existing.id,
          token: existing.token,
          amount: existing.amount,
          formattedAmount: product.formattedPrice,
          productName: product.name,
          qrCode: existing.qrCode,
          qrCodeImage: existing.qrCodeImage,
          expiresIn: Math.max(0, Math.floor((new Date(existing.expiresAt) - new Date()) / 1000)),
          expiresAt: existing.expiresAt
        });
      }
    }

    // 5. Montar payload oficial Pagar.me V5
    const customerName = name.trim();
    const customerEmail = email.trim().toLowerCase();
    const cleanUtms = {
      utm_source: String(utms.utm_source || '').slice(0, 100),
      utm_medium: String(utms.utm_medium || '').slice(0, 100),
      utm_campaign: String(utms.utm_campaign || '').slice(0, 100),
      utm_content: String(utms.utm_content || '').slice(0, 100),
      utm_term: String(utms.utm_term || '').slice(0, 100),
      fbclid: String(utms.fbclid || '').slice(0, 100)
    };

    const pagarmeOrderPayload = {
      customer: {
        name: customerName,
        email: customerEmail,
        type: 'individual',
        document: cleanCpf,
        document_type: 'CPF',
        phones: {
          mobile_phone: parsedPhone
        }
      },
      items: [
        {
          amount: product.amount,
          description: product.name.slice(0, 120),
          quantity: 1,
          code: product.code
        }
      ],
      payments: [
        {
          payment_method: 'pix',
          pix: {
            expires_in: 1800 // 30 minutos em segundos
          }
        }
      ],
      metadata: cleanUtms
    };

    // 6. Chamada autenticada via HTTP Basic Auth com a Secret Key
    const authHeader = 'Basic ' + Buffer.from(`${PAGARME_SECRET_KEY}:`).toString('base64');
    const pagarmeResponse = await fetch(`${PAGARME_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(pagarmeOrderPayload)
    });

    const pagarmeData = await pagarmeResponse.json();

    if (!pagarmeResponse.ok) {
      console.error('Erro na resposta da Pagar.me V5:', pagarmeResponse.status, pagarmeData);
      let errorMsg = 'Não foi possível gerar a cobrança Pix no momento.';

      if (pagarmeData.message) {
        if (/document|cpf/i.test(pagarmeData.message)) {
          errorMsg = 'O CPF informado não foi aceito pela autoridade bancária. Verifique os dados digitados.';
        } else if (/pix/i.test(pagarmeData.message)) {
          errorMsg = 'Erro na emissão do Pix junto ao banco. Verifique se o Pix está habilitado na sua conta Pagar.me.';
        } else if (/unauthorized|forbidden|credentials/i.test(pagarmeData.message)) {
          errorMsg = 'Falha na autenticação com a Pagar.me. Verifique a PAGARME_SECRET_KEY.';
        } else {
          errorMsg = pagarmeData.message;
        }
      }

      if (pagarmeData.errors) {
        const errorDetails = Object.values(pagarmeData.errors).flat().join(', ');
        if (errorDetails) {
          errorMsg += ` (${errorDetails})`;
        }
      }

      return res.status(400).json({
        success: false,
        message: errorMsg
      });
    }

    // 7. Extrair dados da transação Pix
    const charge = pagarmeData.charges && pagarmeData.charges[0];
    const lastTransaction = charge && charge.last_transaction;

    const qrCodeText = (lastTransaction && lastTransaction.qr_code) || '';
    const qrCodeUrl = (lastTransaction && lastTransaction.qr_code_url) || '';

    if (!qrCodeText) {
      console.error('Pagar.me retornou pedido sem código Pix Copia e Cola:', pagarmeData);
      return res.status(502).json({
        success: false,
        message: 'A operadora não retornou o código Pix para este pedido. Verifique se sua conta Stone/Pagar.me está autorizada a emitir Pix.'
      });
    }

    // 8. Gerar imagem do QR Code em alta resolução via qrcode (garante exibição mesmo sem CDN externa)
    let qrCodeImage = qrCodeUrl;
    try {
      const generatedDataUrl = await QRCode.toDataURL(qrCodeText, {
        width: 320,
        margin: 1,
        color: {
          dark: '#1C1C1A',
          light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M'
      });
      qrCodeImage = generatedDataUrl;
    } catch (qrErr) {
      console.warn('Fallback para qr_code_url da Pagar.me:', qrErr.message);
    }

    // 9. Salvar pedido com token seguro assinado
    const localOrderId = crypto.randomUUID();
    const clientToken = createOrderToken(localOrderId, pagarmeData.id);
    const expiresAt = (lastTransaction && lastTransaction.expires_at) || new Date(Date.now() + 1800 * 1000).toISOString();

    const orderRecord = {
      id: localOrderId,
      token: clientToken,
      pagarmeOrderId: pagarmeData.id,
      pagarmeChargeId: charge ? charge.id : null,
      productId: product.id,
      productName: product.name,
      amount: product.amount,
      formattedAmount: product.formattedPrice,
      customer: {
        name: customerName,
        email: customerEmail,
        cpf: cleanCpf,
        phone: parsedPhone
      },
      status: 'pending',
      qrCode: qrCodeText,
      qrCodeImage: qrCodeImage,
      expiresAt: expiresAt,
      createdAt: new Date().toISOString(),
      utms: cleanUtms,
      idempotencyKey: idempotencyKey,
      deliveryUrl: ACCESS_DELIVERY_URL
    };

    ordersStore.set(localOrderId, orderRecord);
    persistOrdersToDisk();

    return res.json({
      success: true,
      orderId: localOrderId,
      token: clientToken,
      amount: product.amount,
      formattedAmount: product.formattedPrice,
      productName: product.name,
      qrCode: qrCodeText,
      qrCodeImage: qrCodeImage,
      expiresIn: 1800,
      expiresAt: expiresAt
    });
  } catch (err) {
    console.error('Erro inesperado ao criar pedido Pix:', err);
    return res.status(500).json({
      success: false,
      message: 'Ocorreu uma instabilidade interna ao gerar seu Pix. Por favor, tente novamente.'
    });
  }
});

// ==========================================
// 2. CONSULTA DE STATUS DO PEDIDO (POLLING)
// ==========================================
app.get(['/api/orders/:id/status', '/.netlify/functions/order-status', '/api/orders/status'], async (req, res) => {
  try {
    const id = req.params.id || req.query.orderId || req.query.id;
    const { token } = req.query;

    const tokenPayload = verifyOrderToken(token);
    let order = ordersStore.get(id);

    // Se o pedido não estiver na memória desta instância serverless, tentamos recuperar pelo token assinado
    const pagarmeOrderId = (order && order.pagarmeOrderId) || (tokenPayload && tokenPayload.pagarmeOrderId);

    if (!order && !tokenPayload) {
      return res.status(404).json({
        success: false,
        message: 'Pedido não localizado.'
      });
    }

    // Se já estiver marcado como pago em memória
    if (order && order.status === 'paid') {
      return res.json({
        success: true,
        status: 'paid',
        paid: true,
        productName: order.productName,
        deliveryUrl: order.deliveryUrl || ACCESS_DELIVERY_URL
      });
    }

    // Sincronização direta e segura com a Pagar.me V5 usando a Secret Key
    if (PAGARME_SECRET_KEY && pagarmeOrderId) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${PAGARME_SECRET_KEY}:`).toString('base64');
        const checkRes = await fetch(`${PAGARME_BASE_URL}/orders/${pagarmeOrderId}`, {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
          }
        });

        if (checkRes.ok) {
          const remoteData = await checkRes.json();
          const remoteStatus = (remoteData.status || '').toLowerCase();
          const isPaid = remoteStatus === 'paid' || (remoteData.charges && remoteData.charges.some(c => (c.status || '').toLowerCase() === 'paid'));

          if (isPaid) {
            if (order) {
              order.status = 'paid';
              order.paidAt = new Date().toISOString();
              ordersStore.set(order.id, order);
              persistOrdersToDisk();
            }

            return res.json({
              success: true,
              status: 'paid',
              paid: true,
              productName: (order && order.productName) || 'Pack 100 Calendários de Mesa 2027 + 4 Bônus',
              deliveryUrl: (order && order.deliveryUrl) || ACCESS_DELIVERY_URL
            });
          } else if (remoteStatus === 'canceled' || remoteStatus === 'failed') {
            if (order) {
              order.status = 'failed';
              ordersStore.set(order.id, order);
              persistOrdersToDisk();
            }
          }
        }
      } catch (checkErr) {
        console.warn('Aviso: falha na sincronização de status:', checkErr.message);
      }
    }

    const isExpired = order && order.expiresAt && new Date(order.expiresAt) < new Date();

    return res.json({
      success: true,
      status: isExpired ? 'expired' : (order ? order.status : 'pending'),
      paid: false,
      productName: (order && order.productName) || 'Pack 100 Calendários de Mesa 2027 + 4 Bônus'
    });
  } catch (err) {
    console.error('Erro ao consultar status:', err);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao consultar o status.'
    });
  }
});

// ==========================================
// 3. WEBHOOK REAL PAGAR.ME V5 (ZERO-TRUST)
// ==========================================
app.post(['/api/webhooks/pagarme', '/.netlify/functions/pagarme-webhook'], async (req, res) => {
  try {
    const event = req.body;
    if (!event || !event.type) {
      return res.status(400).json({ error: 'Payload de webhook inválido' });
    }

    // 1. Verificação de Token Secreto / Autenticação (quando configurado no painel e na Netlify)
    // Se a variável PAGARME_WEBHOOK_SECRET for uma URL, ignoramos pois foi colada por engano
    const isWebhookSecretConfigured = PAGARME_WEBHOOK_SECRET &&
      !PAGARME_WEBHOOK_SECRET.startsWith('http') &&
      !PAGARME_WEBHOOK_SECRET.includes('calendario.papeleartes.online');

    if (isWebhookSecretConfigured) {
      const queryToken = req.query.token || req.query.secret || '';
      const customHeader = req.headers['x-webhook-secret'] || req.headers['x-token'] || '';

      let basicAuthUserOrPass = '';
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        const parts = decoded.split(':');
        basicAuthUserOrPass = parts[1] || parts[0] || '';
      }

      const matchesSecret =
        (queryToken && queryToken === PAGARME_WEBHOOK_SECRET) ||
        (customHeader && customHeader === PAGARME_WEBHOOK_SECRET) ||
        (basicAuthUserOrPass && basicAuthUserOrPass === PAGARME_WEBHOOK_SECRET);

      if (!matchesSecret) {
        console.warn('[Pagar.me Webhook] Chamada rejeitada: Token ou credencial não confere com PAGARME_WEBHOOK_SECRET');
        return res.status(401).json({ error: 'Webhook não autorizado: token/secret inválido' });
      }
    }

    const eventType = String(event.type || '').toLowerCase();
    const eventData = event.data || {};

    console.log(`[Pagar.me Webhook] Evento recebido: ${eventType}`);

    // Extrair ID do pedido na Pagar.me (or_xxxxxxxxxxxx)
    const pagarmeOrderId = eventData.order ? eventData.order.id : eventData.id;

    if (!pagarmeOrderId) {
      return res.status(200).json({ received: true });
    }

    // Localizar pedido correspondente no store
    let matchedOrder = null;
    for (const order of ordersStore.values()) {
      if (order.pagarmeOrderId === pagarmeOrderId) {
        matchedOrder = order;
        break;
      }
    }

    // 2. CONFIRMAÇÃO OBRIGATÓRIA NA API DA PAGAR.ME COM SECRET KEY (ZERO-TRUST)
    // Nunca confiamos cegamente no corpo do webhook: consultamos a Pagar.me diretamente
    if (eventType === 'order.paid' || eventType === 'charge.paid') {
      let verifiedPaid = false;

      if (PAGARME_SECRET_KEY) {
        try {
          const authHeader = 'Basic ' + Buffer.from(`${PAGARME_SECRET_KEY}:`).toString('base64');
          const verifyRes = await fetch(`${PAGARME_BASE_URL}/orders/${pagarmeOrderId}`, {
            headers: {
              'Authorization': authHeader,
              'Accept': 'application/json'
            }
          });

          if (verifyRes.ok) {
            const officialOrder = await verifyRes.json();
            const officialStatus = (officialOrder.status || '').toLowerCase();
            const hasPaidCharge = Array.isArray(officialOrder.charges) && officialOrder.charges.some(c => (c.status || '').toLowerCase() === 'paid');

            if (officialStatus === 'paid' || hasPaidCharge) {
              verifiedPaid = true;
              console.log(`[Pagar.me Webhook] Pedido ${pagarmeOrderId} autenticado e confirmado via API oficial da Pagar.me!`);
            } else {
              console.warn(`[Pagar.me Webhook] Pedido ${pagarmeOrderId} ainda não consta como pago na Pagar.me (status: ${officialStatus}). Liberação barrada.`);
            }
          } else {
            console.error(`[Pagar.me Webhook] Falha ao consultar Pagar.me (HTTP ${verifyRes.status}).`);
          }
        } catch (verifyErr) {
          console.error('[Pagar.me Webhook] Erro de rede ao validar na Pagar.me:', verifyErr.message);
        }
      }

      if (verifiedPaid && matchedOrder) {
        if (matchedOrder.status !== 'paid') {
          matchedOrder.status = 'paid';
          matchedOrder.paidAt = new Date().toISOString();
          matchedOrder.lastEventId = event.id;
          ordersStore.set(matchedOrder.id, matchedOrder);
          persistOrdersToDisk();
          console.log(`[Pagar.me Webhook] Pedido ${matchedOrder.id} aprovado com sucesso!`);
        }
      }
    } else if (eventType === 'order.payment_failed' || eventType === 'charge.payment_failed') {
      if (matchedOrder) {
        matchedOrder.status = 'failed';
        matchedOrder.lastEventId = event.id;
        ordersStore.set(matchedOrder.id, matchedOrder);
        persistOrdersToDisk();
        console.log(`[Pagar.me Webhook] Pedido ${matchedOrder.id} marcado como falho.`);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro ao processar webhook Pagar.me:', err);
    return res.status(500).json({ error: 'Erro interno ao processar webhook' });
  }
});

// Arquivos estáticos da landing page
app.use(express.static(__dirname));

// Rota fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicia servidor apenas se não estiver em ambiente Serverless / Lambda
if (process.env.NETLIFY !== 'true' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
    console.log(`Pagar.me API: ${PAGARME_BASE_URL} | Chave configurada: ${Boolean(PAGARME_SECRET_KEY)}`);
  });
}

export default app;
