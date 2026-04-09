const axios = require('axios');

function buildMessage(template, vars) {
  return template
    .replace(/{{nome}}/g, vars.nome || '')
    .replace(/{{login}}/g, vars.login || '')
    .replace(/{{senha}}/g, vars.senha || '')
    .replace(/{{plano}}/g, vars.plano || '')
    .replace(/{{email}}/g, vars.email || '');
}

async function sendMessage({ cfg, phone, vars }) {
  const baseUrl = cfg.digisac_url?.replace(/\/$/, '');
  const token = cfg.digisac_token;
  const serviceId = cfg.digisac_service_id;
  const deptId = cfg.digisac_dept_id;
  const msgTemplate = cfg.msg_text || 'Parabéns {{nome}}! Login: {{login}} Senha: {{senha}}';
  const mediaType = cfg.msg_media_type || 'none';
  const mediaUrl = cfg.msg_media_url || '';
  const mediaCaption = cfg.msg_media_caption || '';

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const contactPayload = {
    phone: phone.replace(/\D/g, ''),
    serviceId,
    ...(deptId ? { departmentId: deptId } : {})
  };

  let contactId;
  try {
    const res = await axios.post(`${baseUrl}/api/v1/contacts`, contactPayload, { headers });
    contactId = res.data?.data?.id || res.data?.id;
  } catch (e) {
    throw new Error(`Digisac contato: ${e.response?.data?.message || e.message}`);
  }

  if (mediaType !== 'none' && mediaUrl) {
    await axios.post(`${baseUrl}/api/v1/messages`, {
      contactId, serviceId,
      type: mediaType === 'video' ? 'video' : 'image',
      url: mediaUrl,
      ...(mediaCaption ? { caption: mediaCaption } : {})
    }, { headers });
  }

  const text = buildMessage(msgTemplate, vars);
  await axios.post(`${baseUrl}/api/v1/messages`, {
    contactId, serviceId, type: 'text', text
  }, { headers });

  return true;
}

module.exports = { sendMessage };
