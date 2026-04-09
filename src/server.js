require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const axios = require('axios');
const { pool, initDB } = require('./database');
const { createOrRenewCustomer, getConfig, getPlanMaps } = require('./sigma');
const { sendMessage } = require('./digisac');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, '../public')));

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.post('/login', (req, res) => {
  const pass = process.env.ADMIN_PASSWORD || 'tq2024admin';
  if (req.body.password === pass) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', auth, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// Config
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
      await pool.query(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, value]
      );
    }
    await pool.query('DELETE FROM plan_maps');
    for (const map of maps) {
      if (map.braip_name && map.sigma_package_id) {
        await pool.query(
          'INSERT INTO plan_maps (braip_name, sigma_package_id) VALUES ($1, $2)',
          [map.braip_name, map.sigma_package_id]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Historico
app.get('/api/activations', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM activations ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reenviar
app.post('/api/activations/:id/resend', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM activations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'N/a' });
    const act = rows[0];
    const cfg = await getConfig(pool);
    await sendMessage({ cfg, phone: act.client_cel, vars: { nome: act.client_name, login: act.sigma_username, senha: act.sigma_password, plano: act.plan_name, email: act.client_email } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Planos Sigma
app.get('/api/sigma-plans', auth, async (req, res) => {
  try {
    const cfg = await getConfig(pool);
    const sigmaUrl = (cfg.sigma_url || 'https://telaquente.sigmab.pro/api').replace(/\/api$/, '');
    const token = cfg.sigma_token;
    if (!token) return res.status(400).json({ error: 'Token do Sigma nao configurado.' });
    const r = await axios.get(`${sigmaUrl}/api/webhook/package`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const plans = (r.data?.data || []).map(p => ({
      id: p.id, name: p.name,
      duration: p.duration + ' ' + (p.duration_in || '')
    }));
    res.json({ plans });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// Produtos Braip
app.get('/api/braip-products', auth, async (req, res) => {
  try {
    const cfg = await getConfig(pool);
    const token = cfg.braip_token;
    if (!token) return res.status(400).json({ error: 'Token da Braip nao configurado.' });
    const r = await axios.get('https://api.braip.com/api/v2/products', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const raw = r.data?.data || r.data || [];
    const products = Array.isArray(raw) ? raw.map(p => ({
      id: p.id || p.pro_id || '',
      name: p.name || p.pro_name || '',
      plans: (p.plans || p.offers || []).map(pl => ({
        id: pl.id || pl.pla_id || '',
        name: pl.name || pl.pla_name || pl.title || ''
      }))
    })) : [];
    res.json({ products, raw_sample: JSON.stringify(raw).substring(0, 300) });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// Planos Braip do historico
app.get('/api/braip-plans', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT plan_name FROM activations WHERE plan_name IS NOT NULL AND plan_name != '' ORDER BY plan_name`
    );
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

  if (!transStatus.toLowerCase().includes('aprovado') && transStatus.toLowerCase() !== 'approved') {
    console.log('[WEBHOOK] Ignorado — status:', transStatus);
    return;
  }

  if (transKey) {
    const { rows } = await pool.query('SELECT id FROM activations WHERE trans_key = $1', [transKey]);
    if (rows.length) {
      console.log('[WEBHOOK] Duplicado, ignorando trans_key:', transKey);
      return;
    }
  }

  const clientName = body.client_name || '';
  const clientEmail = body.client_email || '';
  const clientCel = body.client_cel || '';
  const clientDoc = body.client_document || body.client_doc || '';
  const planName = body.plan_name || '';

  console.log('[WEBHOOK] Processando:', { clientName, clientEmail, clientCel, planName });

  try {
    const cfg = await getConfig(pool);
    const planMaps = await getPlanMaps(pool);
    const { username, password } = await createOrRenewCustomer({ cfg, planMaps, clientName, clientEmail, clientCel, clientDoc, planName });
    console.log('[WEBHOOK] Sigma OK — username:', username);
    await sendMessage({ cfg, phone: clientCel, vars: { nome: clientName, login: username, senha: password, plano: planName, email: clientEmail } });
    console.log('[WEBHOOK] Digisac OK');
    await pool.query(
      `INSERT INTO activations (trans_key, client_name, client_email, client_cel, plan_name, sigma_username, sigma_password, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'success')`,
      [transKey, clientName, clientEmail, clientCel, planName, username, password]
    );
  } catch (e) {
    console.error('[WEBHOOK] ERRO:', e.message);
    await pool.query(
      `INSERT INTO activations (trans_key, client_name, client_email, client_cel, plan_name, status, error_msg) VALUES ($1,$2,$3,$4,$5,'error',$6)`,
      [transKey, clientName, clientEmail, clientCel, planName, e.message]
    );
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
