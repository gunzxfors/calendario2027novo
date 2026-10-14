// Netlify Serverless Function: Consulta de Status do Pedido Pix
// URL: https://calendario.papeleartes.online/.netlify/functions/order-status?token=...&orderId=...

import crypto from 'crypto';

function verifySignedToken(token, secret) {
  try {
    if (!token || !token.includes('.')) return null;
    const [encodedData, signature] = token.split('.');
    const data = Buffer.from(encodedData, 'base64url').toString('utf8');
    const [orderId, pagarmeOrderId] = data.split(':');
    const expectedSig = crypto.createHmac('sha256', secret || 'pagarme_token_salt').update(data).digest('hex').slice(0, 16);
    if (signature !== expectedSig) return null;
    return { orderId, pagarmeOrderId };
  } catch (e) {
    return null;
  }
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const token = params.token || '';
    const PAGARME_SECRET_KEY = process.env.PAGARME_SECRET_KEY || '';
    const PAGARME_BASE_URL = (process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5').replace(/\/+$/, '');
    const ACCESS_DELIVERY_URL = process.env.ACCESS_DELIVERY_URL || 'https://drive.google.com/drive/folders/pack-calendarios-2027';

    // Validar token assinado
    const payload = verifySignedToken(token, PAGARME_SECRET_KEY);
    if (!payload || !payload.pagarmeOrderId) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ success: false, message: 'Acesso não autorizado para consultar este pedido.' })
      };
    }

    const pagarmeOrderId = payload.pagarmeOrderId;

    // Consultar status real diretamente na API da Pagar.me V5
    const authHeader = 'Basic ' + Buffer.from(`${PAGARME_SECRET_KEY}:`).toString('base64');
    const checkRes = await fetch(`${PAGARME_BASE_URL}/orders/${pagarmeOrderId}`, {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });

    if (!checkRes.ok) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, status: 'pending', paid: false })
      };
    }

    const orderData = await checkRes.json();
    const remoteStatus = (orderData.status || '').toLowerCase();
    const isPaid = remoteStatus === 'paid' ||
      (Array.isArray(orderData.charges) && orderData.charges.some(c => (c.status || '').toLowerCase() === 'paid'));

    if (isPaid) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          status: 'paid',
          paid: true,
          productName: 'Pack 100 Calendários de Mesa 2027 + 4 Bônus',
          deliveryUrl: ACCESS_DELIVERY_URL
        })
      };
    }

    const isCanceled = remoteStatus === 'canceled' || remoteStatus === 'failed';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        status: isCanceled ? 'failed' : 'pending',
        paid: false
      })
    };

  } catch (err) {
    console.error('Erro na função order-status:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, message: 'Erro interno ao consultar status' })
    };
  }
};
