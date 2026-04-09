require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const { pool, initDB } = require('./database');
const { createOrRenewCustomer, getConfig, getPlanMaps } = require('./sigma');
const { sendMessage } = require('./digisac');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'tq-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === adminPass) { req.session.loggedIn = true; res.redirect('/'); }
  else res.redirect('/login?error=1');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', auth, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── API: Config ──────────────────────────────────────────────────────────────
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
      if (map.braip_name && map.sigma_package_id) {
        await pool.query('INSERT INTO plan_maps (braip_name, sigma_package_id) VALUES ($1, $2)', [map.braip_name, map.sigma_package_id]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Historico ───────────────────────────────────────────────────────────
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
    await sendMessage({ cfg, phone: act.client_cel, vars: { nome: act.client_name, login: act.sigma_username, senha: act.sigma_password, plano: act.plan_name, email: act.client_email } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Planos do Sigma ─────────────────────────────────────────────────────
app.get('/api/sigma-plans', auth, async (req, res) => {
  try {
    const cfg = await getConfig(pool);
    const sigmaUrl = (cfg.sigma_url || 'https://telaquente.sigmab.pro/api').replace(/\/api$/, '');
    const token = cfg.sigma_token;
    if (!token) return res.status(400).json({ error: 'Token do Sigma nao configurado. Salve as configuracoes primeiro.' });
    const r = await axios.get(`${sigmaUrl}/api/webhook/package`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const plans = (r.data?.data || []).map(p => ({
      id: p.id,
      name: p.name,
      duration: p.duration + ' ' + (p.duration_in || ''),
      price: p.price
    }));
    res.json({ plans });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ─── API: Planos da Braip ─────────────────────────────────────────────────────
app.get('/api/braip-plans', auth, async (req, res) => {
  try {
    // Busca os planos ja usados no historico de ativacoes
    const { rows } = await pool.query(
      `SELECT DISTINCT plan_name FROM activations WHERE plan_name IS NOT NULL AND plan_name != '' ORDER BY plan_name`
    );
    // Tambem retorna os mapeamentos existentes
    const maps = await getPlanMaps(pool);
    const historico = rows.map(r => r.plan_name);
    res.json({ plans: historico, maps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WEBHOOK BRAIP ────────────────────────────────────────────────────────────
app.post('/webhook/braip', async (req, res) => {
  res.json({ status: 'ok' });
  const body = req.body;
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
  try {
    const cfg = await getConfig(pool);
    const planMaps = await getPlanMaps(pool);
    const { username, password } = await createOrRenewCustomer({ cfg, planMaps, clientName, clientEmail, clientCel, clientDoc, planName });
    await sendMessage({ cfg, phone: clientCel, vars: { nome: clientName, login: username, senha: password, plano: planName, email: clientEmail } });
    await pool.query(
      `INSERT INTO activations (trans_key, client_name, client_email, client_cel, plan_name, sigma_username, sigma_password, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'success')`,
      [transKey, clientName, clientEmail, clientCel, planName, username, password]
    );
  } catch (e) {
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
