// Netlify Serverless Function: Pagar.me V5 Webhook Handler
// URL: https://calendario.papeleartes.online/.netlify/functions/pagarme-webhook

export const handler = async (event) => {
  // Configurar CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-secret, x-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Método não permitido. Utilize POST.' })
    };
  }

  try {
    const rawBody = event.body || '{}';
    let webhookData;
    try {
      webhookData = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error('[Pagar.me Webhook] JSON inválido:', parseErr.message);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Payload JSON inválido' }) };
    }

    const PAGARME_SECRET_KEY = process.env.PAGARME_SECRET_KEY || '';
    const PAGARME_BASE_URL = (process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5').replace(/\/+$/, '');
    const PAGARME_WEBHOOK_SECRET = process.env.PAGARME_WEBHOOK_SECRET || '';

    // 1. Verificação Opcional de Token Secreto / Autenticação
    // Se a variável PAGARME_WEBHOOK_SECRET for uma URL, ignoramos pois foi colada por engano
    const isWebhookSecretConfigured = PAGARME_WEBHOOK_SECRET &&
      !PAGARME_WEBHOOK_SECRET.startsWith('http') &&
      !PAGARME_WEBHOOK_SECRET.includes('calendario.papeleartes.online');

    if (isWebhookSecretConfigured) {
      const queryParams = event.queryStringParameters || {};
      const queryToken = queryParams.token || queryParams.secret || '';
      const customHeader = event.headers['x-webhook-secret'] || event.headers['x-token'] || '';

      let basicAuthCredential = '';
      const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
      if (authHeader.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        const parts = decoded.split(':');
        basicAuthCredential = parts[1] || parts[0] || '';
      }

      const matches =
        (queryToken && queryToken === PAGARME_WEBHOOK_SECRET) ||
        (customHeader && customHeader === PAGARME_WEBHOOK_SECRET) ||
        (basicAuthCredential && basicAuthCredential === PAGARME_WEBHOOK_SECRET);

      if (!matches) {
        console.warn('[Pagar.me Webhook] Token secreto não confere com PAGARME_WEBHOOK_SECRET');
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Não autorizado: token de webhook inválido' })
        };
      }
    }

    const eventType = String(webhookData.type || '').toLowerCase();
    const eventPayload = webhookData.data || {};
    const pagarmeOrderId = eventPayload.order ? eventPayload.order.id : eventPayload.id;

    console.log(`[Pagar.me Webhook] Evento: ${eventType} | Pedido: ${pagarmeOrderId}`);

    if (!pagarmeOrderId) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, message: 'Evento recebido sem ID de pedido' })
      };
    }

    // 2. CONFIRMAÇÃO OBRIGATÓRIA NA API PAGAR.ME V5 (ZERO-TRUST)
    // Nunca liberamos acesso apenas pelo corpo recebido no webhook.
    // Consultamos diretamente os servidores da Pagar.me com a Secret Key:
    let isOfficiallyPaid = false;
    let orderDetails = null;

    if (PAGARME_SECRET_KEY) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${PAGARME_SECRET_KEY}:`).toString('base64');
        const checkRes = await fetch(`${PAGARME_BASE_URL}/orders/${pagarmeOrderId}`, {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
          }
        });

        if (checkRes.ok) {
          orderDetails = await checkRes.json();
          const remoteStatus = (orderDetails.status || '').toLowerCase();
          const hasPaidCharge = Array.isArray(orderDetails.charges) &&
            orderDetails.charges.some(c => (c.status || '').toLowerCase() === 'paid');

          if (remoteStatus === 'paid' || hasPaidCharge) {
            isOfficiallyPaid = true;
            console.log(`[Pagar.me Webhook] SUCESSO: Pedido ${pagarmeOrderId} confirmado como PAGO diretamente na API Pagar.me!`);
          } else {
            console.warn(`[Pagar.me Webhook] AVISO: Pedido ${pagarmeOrderId} tem status oficial '${remoteStatus}'. Pagamento não confirmado.`);
          }
        } else {
          console.error(`[Pagar.me Webhook] Erro ao consultar API Pagar.me (HTTP ${checkRes.status}).`);
        }
      } catch (apiErr) {
        console.error('[Pagar.me Webhook] Erro de rede ao conectar à API da Pagar.me:', apiErr.message);
      }
    } else {
      console.error('[Pagar.me Webhook] ERRO CRÍTICO: PAGARME_SECRET_KEY não configurada na Netlify.');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        received: true,
        orderId: pagarmeOrderId,
        eventType: eventType,
        verifiedPaid: isOfficiallyPaid
      })
    };

  } catch (err) {
    console.error('[Pagar.me Webhook] Erro interno:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erro interno ao processar notificação do webhook' })
    };
  }
};
