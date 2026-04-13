const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const PIXEL_ID = '760559930372047';
const API_VERSION = 'v19.0';
const CAPI_URL = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`;

// Estado global do job em andamento
let uploadJob = {
  running: false,
  total: 0,
  sent: 0,
  errors: 0,
  batches_total: 0,
  batches_done: 0,
  started_at: null,
  finished_at: null,
  last_error: ''
};

function hash(value) {
  if (!value || String(value).trim() === '' || String(value) === 'nan') return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  let p = String(phone).replace(/\D/g, '');
  if (!p.startsWith('55') && p.length <= 11) p = '55' + p;
  return p;
}

function normalizeZip(zip) {
  if (!zip) return undefined;
  let z = String(zip).split('.')[0].replace(/\D/g, '');
  return z.padStart(8, '0');
}

function removeAccents(str) {
  if (!str) return '';
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function splitName(fullName) {
  if (!fullName) return { fn: undefined, ln: undefined };
  const parts = String(fullName).trim().split(/\s+/);
  return {
    fn: parts[0] || undefined,
    ln: parts.slice(1).join(' ') || undefined
  };
}

function buildEvent(row, index) {
  const { fn, ln } = splitName(row.fn || row.name || row.nome || '');
  const phone = normalizePhone(row.phone || row.telefone || row.celular || '');
  const email = row.email || '';
  const zip = normalizeZip(row.zip || row.cep || '');
  const city = row.ct || row.city || row.cidade || '';
  const state = row.st || row.state || row.estado || '';
  const value = parseFloat(row.value || row.valor || 0) || 0;
  const eventTime = Math.floor(Date.now() / 1000);
  const eventId = `upload_${index}_${eventTime}`;

  const userData = {
    em: hash(email),
    ph: hash(phone),
    fn: hash(removeAccents(fn)),
    ln: hash(removeAccents(ln)),
    zip: hash(zip),
    ct: hash(removeAccents(city)),
    st: hash(removeAccents(state)),
    country: 'br'
  };

  // Remover campos undefined
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  return {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      currency: 'BRL',
      value: value,
      content_name: 'Comprador',
      content_type: 'product'
    }
  };
}

async function sendBatch(events, accessToken, testEventCode) {
  const payload = {
    data: events,
    ...(testEventCode ? { test_event_code: testEventCode } : {})
  };
  const res = await axios.post(CAPI_URL, payload, {
    params: { access_token: accessToken },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });
  return res.data?.events_received || 0;
}

async function processUpload(rows, accessToken, testEventCode) {
  const BATCH_SIZE = 1000;
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE));
  }

  uploadJob.running = true;
  uploadJob.total = rows.length;
  uploadJob.sent = 0;
  uploadJob.errors = 0;
  uploadJob.batches_total = batches.length;
  uploadJob.batches_done = 0;
  uploadJob.started_at = new Date().toISOString();
  uploadJob.finished_at = null;
  uploadJob.last_error = '';

  let globalIndex = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const events = batch.map((row, i) => buildEvent(row, globalIndex + i));
    globalIndex += batch.length;

    try {
      const received = await sendBatch(events, accessToken, testEventCode);
      uploadJob.sent += batch.length;
      uploadJob.batches_done = b + 1;
      console.log(`[UPLOAD] Lote ${b + 1}/${batches.length} — ${uploadJob.sent}/${uploadJob.total} enviados`);
    } catch (e) {
      uploadJob.errors += batch.length;
      uploadJob.batches_done = b + 1;
      uploadJob.last_error = e.response?.data?.error?.message || e.message;
      console.error(`[UPLOAD] Lote ${b + 1} erro:`, uploadJob.last_error);
    }

    // Pequena pausa entre lotes para não sobrecarregar
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  uploadJob.running = false;
  uploadJob.finished_at = new Date().toISOString();
  console.log(`[UPLOAD] Concluído — ${uploadJob.sent} enviados, ${uploadJob.errors} erros`);
}

function registerUploadRoutes(app, auth, getConfig) {
  // Status do job
  app.get('/api/upload-status', auth, (req, res) => {
    res.json(uploadJob);
  });

  // Upload e disparo
  app.post('/api/upload-capi', auth, upload.single('file'), async (req, res) => {
    if (uploadJob.running) {
      return res.status(400).json({ error: 'Já existe um upload em andamento.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' });

    try {
      // Ler o arquivo
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length) return res.status(400).json({ error: 'Planilha vazia.' });

      const cfg = await getConfig();
      const fbToken = cfg.fb_access_token;
      const fbTestCode = cfg.fb_test_event_code || '';

      if (!fbToken) return res.status(400).json({ error: 'Token da CAPI não configurado.' });

      // Responder imediatamente e processar em background
      res.json({ ok: true, total: rows.length, batches: Math.ceil(rows.length / 1000) });

      // Processar em background
      processUpload(rows, fbToken, fbTestCode || undefined).catch(console.error);

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerUploadRoutes };
