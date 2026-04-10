require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const { pool, initDB } = require('./database');
const { createOrRenewCustomer, getConfig, getPlanMaps } = require('./sigma');
const { sendMessage } = require('./digisac');
const { sendPurchaseEvent } = require('./facebook');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'secret', resave: false, saveUninitialized: false, cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.static(path.join(__dirname, '../public')));

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.post('/login', (req, res) => {
  const pass = process.env.ADMIN_PASSWORD || 'tq2024admin';
  if (req.body.password === pass) { req.session.loggedIn = true; res.redirect('/'); }
  else res.redirect('/login?error=1');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', auth, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.get('/api/config', auth, async (req, res) => {
  try {
    const cfg = await getConfig(pool);
    const maps = await getPlanMaps(pool);
    res.json({ cfg, maps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', auth, async (req, res) => {
  try {
    const { cfg, maps } = req.body;
    for (const [key, value] of Object.entries(cfg)) {
      await pool.query('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
    }
    await pool.query('DELETE FROM plan_maps');
    for (const map of maps) {
      if (map.braip_name && (map.sigma_package_id || map.skip_sigma)) {
        await pool.query(
          'INSERT INTO plan_maps (braip_name, sigma_package_id, skip_sigma, custom_msg) VALUES ($1, $2, $3, $4)',
          [map.braip_name, map.sigma_package_id, map.skip_sigma || false, map.custom_msg || '']
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activations', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM activations ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/activations/:id/resend', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM activations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'N/a' });
    const act = rows[0];
    const cfg = await getConfig(pool);
    await sendMessage({ cfg, phone: act.client_cel, vars: { nome: act.client_name, login: act.sigma_username || '', senha: act.sigma_password || '', plano: act.plan_name, email: act.client_email }, customMsg: act.custom_msg });
    await pool.query('UPDATE activations SET status=$1, error_msg=NULL WHERE id=$2', ['success', act.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sigma-plans', auth, async (req, res) => {
  try {
    const cfg = await getConfig(pool);
    const sigmaUrl = (cfg.sigma_url || 'https://telaquente.sigmab.pro/api').replace(/\/api$/, '');
    const token = cfg.sigma_token;
    if (!token) return res.status(400).json({ error: 'Token do Sigma nao configurado.' });
    const r = await axios.get(`${sigmaUrl}/api/webhook/package`, { headers: { Authorization: `Bearer ${token}` } });
    const plans = (r.data?.data || []).map(p => ({ id: p.id, name: p.name, duration: p.duration + ' ' + (p.duration_in || '') }));
    res.json({ plans });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.get('/api/braip-products', auth, async (req, res) => {
  try {
    const cfg = await getConfig(pool);
    const token = cfg.braip_token;
    if (!token) return res.status(400).json({ error: 'Token da Braip nao configurado.' });
    const r = await axios.get('https://api.braip.com/api/v2/products', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const raw = r.data?.data || r.data || [];
    const products = Array.isArray(raw) ? raw.map(p => ({ id: p.id || p.pro_id || '', name: p.name || p.pro_name || '', plans: (p.plans || p.offers || []).map(pl => ({ id: pl.id || pl.pla_id || '', name: pl.name || pl.pla_name || pl.title || '' })) })) : [];
    res.json({ products, raw_sample: JSON.stringify(raw).substring(0, 300) });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.get('/api/braip-plans', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT plan_name FROM activations WHERE plan_name IS NOT NULL AND plan_name != '' ORDER BY plan_name`);
    const maps = await getPlanMaps(pool);
    res.json({ plans: rows.map(r => r.plan_name), maps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// WEBHOOK BRAIP
app.post('/webhook/braip', async (req, res) => {
  res.json({ status: 'ok' });
  const body = req.body;
  console.log('[WEBHOOK] Recebido:', JSON.stringify(body).substring(0, 500));

  const transKey = body.trans_key;
  const transStatus = body.trans_status || '';
  if (!transStatus.toLowerCase().includes('aprovado') && transStatus.toLowerCase() !== 'approved') return;

  if (transKey) {
    const { rows } = await pool.query('SELECT id FROM activations WHERE trans_key = $1', [transKey]);
    if (rows.length) return;
  }

  const clientName = body.client_name || '';
  const clientEmail = body.client_email || '';
  const clientCel = body.client_cel || '';
  const clientDoc = body.client_document || body.client_doc || '';
  const planName = body.plan_name || '';
  const saleValue = body.sale_value || body.total || body.price || 0;

  // CAPI Facebook — dispara imediatamente para toda compra aprovada
  try {
    const cfg = await getConfig(pool);
    const fbToken = cfg.fb_access_token;
    const fbTestCode = cfg.fb_test_event_code || '';
    if (fbToken) {
      sendPurchaseEvent({
        accessToken: fbToken,
        clientName, clientEmail,
        clientPhone: clientCel,
        planName, transKey,
        value: saleValue,
        currency: 'BRL',
        testEventCode: fbTestCode || undefined
      }).catch(e => console.warn('[CAPI] Erro (nao critico):', e.message));
    }
  } catch (e) {
    console.warn('[CAPI] Erro ao buscar config:', e.message);
  }

  // Verificar se o plano tem skip_sigma
  const planMaps = await getPlanMaps(pool);
  const upper = planName.toUpperCase();
  const planMap = planMaps.find(m => upper.includes(m.braip_name.toUpperCase()));
  const skipSigma = planMap?.skip_sigma || false;
  const customMsg = planMap?.custom_msg || '';

  console.log('[WEBHOOK] Plano:', planName, '| skipSigma:', skipSigma);

  let username = '', password = '', errMsg = '';

  if (!skipSigma) {
    // ETAPA 1: Sigma
    try {
      const cfg = await getConfig(pool);
      const result = await createOrRenewCustomer({ cfg, planMaps, clientName, clientEmail, clientCel, clientDoc, planName });
      username = result.username;
      password = result.password;
      console.log('[WEBHOOK] Sigma OK Ã¢ÂÂ username:', username);
    } catch (e) {
      errMsg = 'Sigma: ' + e.message;
      console.error('[WEBHOOK] Sigma ERRO:', e.message);
      await pool.query(
        `INSERT INTO activations (trans_key, client_name, client_email, client_cel, plan_name, status, error_msg) VALUES ($1,$2,$3,$4,$5,'error',$6)`,
        [transKey, clientName, clientEmail, clientCel, planName, errMsg]
      );
      return;
    }
  }

  // ETAPA 2: Digisac
  try {
    const cfg = await getConfig(pool);
    await sendMessage({ cfg, phone: clientCel, vars: { nome: clientName, login: username, senha: password, plano: planName, email: clientEmail }, customMsg });
    console.log('[WEBHOOK] Digisac OK');
  } catch (e) {
    errMsg = 'WhatsApp: ' + e.message;
    console.warn('[WEBHOOK] Digisac aviso:', e.message);
  }

  const finalStatus = !errMsg ? 'success' : (skipSigma ? 'error' : 'success_sem_whatsapp');
  await pool.query(
    `INSERT INTO activations (trans_key, client_name, client_email, client_cel, plan_name, sigma_username, sigma_password, status, error_msg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [transKey, clientName, clientEmail, clientCel, planName, username || null, password || null, finalStatus, errMsg || null]
  );
  console.log('[WEBHOOK] Salvo com status:', finalStatus);
});

const PORT = process.env.PORT || 3000;
initDB().then(() => { app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)); });
