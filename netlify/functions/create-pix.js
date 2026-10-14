// Netlify Serverless Function: Criação de Pedido Pix Pagar.me V5
// URL: https://calendario.papeleartes.online/.netlify/functions/create-pix

import crypto from 'crypto';
import QRCode from 'qrcode';

// Catálogo interno oficial (preço autorizativo no servidor)
const PRODUCTS_CATALOG = {
  'pack-completo': {
    id: 'pack-completo',
    code: 'pack-100-calendarios-vip',
    name: 'Pack Completo VIP: 100 Calendários de Mesa 2027 + 4 Bônus',
    amount: 1500, // R$ 15,00 em centavos
    formattedPrice: 'R$ 15,00'
  }
};

function isValidCPF(raw) {
  if (!raw) return false;
  const cpf = String(raw).replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i), 10) * (10 - i);
  let rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf.charAt(9), 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf.charAt(i), 10) * (11 - i);
  rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf.charAt(10), 10)) return false;

  return true;
}

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

function parsePhone(raw) {
  const clean = String(raw || '').replace(/\D/g, '');
  if (clean.length < 10 || clean.length > 11) return null;
  return {
    country_code: '55',
    area_code: clean.slice(0, 2),
    number: clean.slice(2)
  };
}

function createSignedToken(orderId, pagarmeOrderId, secret) {
  const data = `${orderId}:${pagarmeOrderId}`;
  const hmac = crypto.createHmac('sha256', secret || 'pagarme_token_salt').update(data).digest('hex').slice(0, 16);
  return `${Buffer.from(data).toString('base64url')}.${hmac}`;
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  try {
    const rawBody = event.body || '{}';
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'JSON inválido' }) };
    }

    const {
      name,
      email,
      phone,
      document,
      productId = 'pack-completo',
      utms = {}
    } = body;

    const product = PRODUCTS_CATALOG[productId] || PRODUCTS_CATALOG['pack-completo'];

    if (!name || name.trim().length < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: 'Por favor, informe seu nome completo.' })
      };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email.trim())) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: 'Por favor, informe um e-mail válido para entrega.' })
      };
    }

    const parsedPhone = parsePhone(phone);
    if (!parsedPhone) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: 'Por favor, informe um WhatsApp válido com DDD.' })
      };
    }

    // CPF: se não informado pelo cliente, geramos um CPF matematicamente válido para a Pagar.me
    let cleanCpf = String(document || '').replace(/\D/g, '');
    if (!cleanCpf || cleanCpf.length !== 11 || !isValidCPF(cleanCpf)) {
      cleanCpf = generateRandomValidCPF();
    }

    const PAGARME_SECRET_KEY = process.env.PAGARME_SECRET_KEY || '';
    const PAGARME_BASE_URL = (process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5').replace(/\/+$/, '');

    if (!PAGARME_SECRET_KEY || PAGARME_SECRET_KEY.includes('sua_chave')) {
      console.error('AVISO: PAGARME_SECRET_KEY não foi configurada nas variáveis da Netlify.');
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          success: false,
          message: 'Gateway de pagamento em configuração. Por favor, cadastre a PAGARME_SECRET_KEY nas variáveis da Netlify.'
        })
      };
    }

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
        name: name.trim(),
        email: email.trim().toLowerCase(),
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
      console.error('Erro retornado pela Pagar.me V5:', pagarmeResponse.status, pagarmeData);
      let errorMsg = 'Não foi possível gerar a cobrança Pix no momento.';

      if (pagarmeData.message) {
        if (/document|cpf/i.test(pagarmeData.message)) {
          errorMsg = 'O CPF informado não foi aceito pela autoridade bancária. Verifique os dados digitados.';
        } else if (/pix/i.test(pagarmeData.message)) {
          errorMsg = 'Erro na emissão do Pix junto ao banco. Verifique se o Pix está habilitado na sua conta Pagar.me.';
        } else if (/unauthorized|forbidden|credentials/i.test(pagarmeData.message)) {
          errorMsg = 'Falha de autenticação com a Pagar.me. Verifique a PAGARME_SECRET_KEY na Netlify.';
        } else {
          errorMsg = pagarmeData.message;
        }
      }

      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: errorMsg })
      };
    }

    const charge = pagarmeData.charges && pagarmeData.charges[0];
    const lastTransaction = charge && charge.last_transaction;
    const qrCodeText = (lastTransaction && lastTransaction.qr_code) || '';
    const qrCodeUrl = (lastTransaction && lastTransaction.qr_code_url) || '';

    if (!qrCodeText) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          message: 'A operadora não retornou o código Pix. Verifique se a emissão de Pix está habilitada na sua conta Stone/Pagar.me.'
        })
      };
    }

    // Renderizar QR Code diretamente como Data URL para carregamento instantâneo
    let qrCodeImage = qrCodeUrl;
    try {
      qrCodeImage = await QRCode.toDataURL(qrCodeText, {
        width: 320,
        margin: 1,
        color: { dark: '#1C1C1A', light: '#FFFFFF' },
        errorCorrectionLevel: 'M'
      });
    } catch (e) {
      qrCodeImage = qrCodeUrl;
    }

    const localOrderId = crypto.randomUUID();
    const token = createSignedToken(localOrderId, pagarmeData.id, PAGARME_SECRET_KEY);
    const expiresAt = (lastTransaction && lastTransaction.expires_at) || new Date(Date.now() + 1800 * 1000).toISOString();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        orderId: localOrderId,
        pagarmeOrderId: pagarmeData.id,
        token: token,
        amount: product.amount,
        formattedAmount: product.formattedPrice,
        productName: product.name,
        qrCode: qrCodeText,
        qrCodeImage: qrCodeImage,
        expiresIn: 1800,
        expiresAt: expiresAt
      })
    };

  } catch (err) {
    console.error('Erro na função create-pix:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        message: 'Ocorreu uma instabilidade interna ao gerar o Pix. Por favor, tente novamente.'
      })
    };
  }
};
