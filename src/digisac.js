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
  const msgTemplate = cfg.msg_text || 'Parabens {{nome}}! Login: {{login}} Senha: {{senha}}';
  const mediaType = cfg.msg_media_type || 'none';
  const mediaUrl = cfg.msg_media_url || '';
  const mediaCaption = cfg.msg_media_caption || '';

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const numberClean = phone.replace(/\D/g, '');

  // Criar/buscar contato — campo correto e "number" (nao "phone")
  const contactPayload = {
    number: numberClean,
    name: vars.nome || numberClean,
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

  if (!contactId) throw new Error('Digisac: contactId nao retornado');

  if (mediaType !== 'none' && mediaUrl) {
    try {
      await axios.post(`${baseUrl}/api/v1/messages`, {
        contactId, serviceId,
        type: mediaType,
        url: mediaUrl,
        text: buildMessage(mediaCaption, vars)
      }, { headers });
    } catch (e) {
      console.error('Digisac midia erro:', e.response?.data || e.message);
    }
  }

  try {
    await axios.post(`${baseUrl}/api/v1/messages`, {
      contactId, serviceId,
      type: 'text',
      text: buildMessage(msgTemplate, vars)
    }, { headers });
  } catch (e) {
    throw new Error(`Digisac mensagem: ${e.response?.data?.message || e.message}`);
  }
}

module.exports = { sendMessage };
