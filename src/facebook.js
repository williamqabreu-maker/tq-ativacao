const axios = require('axios');
const crypto = require('crypto');

const PIXEL_ID = '760559930372047';
const API_VERSION = 'v19.0';
const CAPI_URL = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`;

function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  // Remove tudo exceto dígitos, garante código do país
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('55') && p.length <= 11) p = '55' + p;
  return p;
}

function normalizeName(name) {
  if (!name) return {};
  const parts = name.trim().toLowerCase().split(/\s+/);
  return {
    fn: parts[0] || undefined,
    ln: parts.slice(1).join(' ') || undefined
  };
}

async function sendPurchaseEvent({ accessToken, clientName, clientEmail, clientPhone, planName, transKey, value, currency, testEventCode }) {
  const eventTime = Math.floor(Date.now() / 1000);
  const eventId = `braip_${transKey || Date.now()}`;

  const { fn, ln } = normalizeName(clientName);
  const phoneNorm = normalizePhone(clientPhone);

  const userData = {
    em: hash(clientEmail),
    ph: hash(phoneNorm),
    fn: hash(fn),
    ln: hash(ln),
    country: hash('br'),
  };

  // Remover campos undefined
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  const eventData = {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      currency: currency || 'BRL',
      value: parseFloat(value) || 0,
      content_name: planName || '',
      content_type: 'product',
    }
  };

  const payload = {
    data: [eventData],
    ...(testEventCode ? { test_event_code: testEventCode } : {})
  };

  try {
    const res = await axios.post(CAPI_URL, payload, {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log('[CAPI] Purchase enviado — event_id:', eventId, '| fbc_matched:', res.data?.events_received);
    return { ok: true, events_received: res.data?.events_received };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('[CAPI] Erro:', errMsg);
    throw new Error(`CAPI: ${errMsg}`);
  }
}

module.exports = { sendPurchaseEvent };
