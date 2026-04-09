const axios = require('axios');

async function getConfig(pool) {
  const { rows } = await pool.query('SELECT key, value FROM config');
  const cfg = {};
  rows.forEach(r => cfg[r.key] = r.value);
  return cfg;
}

async function getPlanMaps(pool) {
  const { rows } = await pool.query('SELECT braip_name, sigma_package_id FROM plan_maps');
  return rows;
}

function resolvePackageId(planName, planMaps, defaultId) {
  const upper = (planName || '').toUpperCase();
  for (const map of planMaps) {
    if (upper.includes(map.braip_name.toUpperCase())) {
      return map.sigma_package_id;
    }
  }
  return defaultId;
}

async function createOrRenewCustomer({ cfg, planMaps, clientName, clientEmail, clientCel, clientDoc, planName }) {
  const token = cfg.sigma_token;
  const panelUrl = cfg.sigma_url || 'https://telaquente.sigmab.pro/api';
  const userId = cfg.sigma_user_id || 'BV4D3rLaqZ';
  const defaultPackageId = cfg.sigma_default_package || 'rlKWO3Wzo7';

  const packageId = resolvePackageId(planName, planMaps, defaultPackageId);

  const headers = { Authorization: `Bearer ${token}` };

  let clienteExiste = false;
  let clienteUsername = null;
  try {
    const res = await axios.get(`${panelUrl}/webhook/customer`, {
      headers,
      params: { note: clientDoc || clientEmail }
    });
    const data = res.data?.data || [];
    if (data.length > 0) {
      clienteExiste = true;
      clienteUsername = data[0].username;
    }
  } catch (e) {}

  let username, password;

  if (clienteExiste) {
    const res = await axios.post(`${panelUrl}/webhook/customer/renew`, {
      userId, username: clienteUsername, packageId
    }, { headers });
    username = res.data?.username || clienteUsername;
    password = res.data?.password || '';
  } else {
    const res = await axios.post(`${panelUrl}/webhook/customer/create`, {
      userId, packageId,
      username: '', password: '',
      name: clientName,
      email: clientEmail,
      whatsapp: clientCel,
      note: clientDoc || clientEmail
    }, { headers });
    username = res.data?.username || '';
    password = res.data?.password || '';
  }

  return { username, password, clienteExiste };
}

module.exports = { createOrRenewCustomer, getConfig, getPlanMaps };
