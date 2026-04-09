const axios = require('axios');

async function getConfig(pool) {
  const { rows } = await pool.query('SELECT key, value FROM config');
  const cfg = {};
  rows.forEach(r => cfg[r.key] = r.value);
  return cfg;
}

async function getPlanMaps(pool) {
  const { rows } = await pool.query('SELECT braip_name, sigma_package_id, skip_sigma, custom_msg FROM plan_maps');
  return rows;
}

function resolvePackageId(planName, planMaps, defaultId) {
  const upper = (planName || '').toUpperCase();
  for (const map of planMaps) {
    if (upper.includes(map.braip_name.toUpperCase())) return map.sigma_package_id;
  }
  return defaultId;
}

async function createOrRenewCustomer({ cfg, planMaps, clientName, clientEmail, clientCel, clientDoc, planName }) {
  const token = cfg.sigma_token;
  const panelUrl = cfg.sigma_url || 'https://telaquente.sigmab.pro/api';
  const userId = cfg.sigma_user_id || 'BV4D3rLaqZ';
  const defaultPackageId = cfg.sigma_default_package || 'rlKWO3Wzo7';
  const packageId = resolvePackageId(planName, planMaps, defaultPackageId);

  if (!token) throw new Error('Token do Sigma nao configurado no painel.');

  const headers = { Authorization: `Bearer ${token}` };

  let clienteExiste = false, clienteUsername = null;
  try {
    const res = await axios.get(`${panelUrl}/webhook/customer`, { headers, params: { note: clientDoc || clientEmail }, timeout: 15000 });
    const data = res.data?.data || [];
    if (data.length > 0) { clienteExiste = true; clienteUsername = data[0].username; }
  } catch (e) {
    console.error('Sigma busca cliente erro:', e.response?.data || e.message);
  }

  let username, password;
  try {
    if (clienteExiste) {
      const res = await axios.post(`${panelUrl}/webhook/customer/renew`, { userId, username: clienteUsername, packageId }, { headers, timeout: 15000 });
      username = res.data?.username || res.data?.data?.username || clienteUsername;
      password = res.data?.password || res.data?.data?.password || '';
    } else {
      const res = await axios.post(`${panelUrl}/webhook/customer/create`, { userId, packageId, username: '', password: '', name: clientName, email: clientEmail, whatsapp: clientCel, note: clientDoc || clientEmail }, { headers, timeout: 15000 });
      username = res.data?.username || res.data?.data?.username || '';
      password = res.data?.password || res.data?.data?.password || '';
    }
  } catch (e) {
    const errDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`Sigma erro ao ${clienteExiste ? 'renovar' : 'criar'} cliente: ${errDetail}`);
  }

  if (!username) throw new Error('Sigma retornou username vazio. Verifique token e packageId.');
  return { username, password, clienteExiste };
}

module.exports = { createOrRenewCustomer, getConfig, getPlanMaps };
