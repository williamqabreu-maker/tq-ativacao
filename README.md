# 🔥 Tela Quente — Painel de Ativação

Aplicação standalone para receber webhooks da Braip, criar/renovar clientes no Sigma e enviar mensagem via Digisac.

## Deploy no Railway

1. Suba o repositório no GitHub
2. No Railway, crie um novo projeto a partir do GitHub
3. Adicione um banco **PostgreSQL** no Railway
4. Configure as variáveis de ambiente:

```
DATABASE_URL=<gerado pelo Railway automaticamente>
SESSION_SECRET=qualquer_string_aleatoria
ADMIN_PASSWORD=sua_senha_do_painel
PORT=3000
```

## Webhook

Configure na Braip a URL:
```
https://seu-app.railway.app/webhook/braip
```

## Painel

Acesse `https://seu-app.railway.app` e entre com a senha configurada em `ADMIN_PASSWORD`.

## Funcionalidades

- Recebe webhook da Braip e responde imediatamente (sem timeout)
- Proteção contra duplicatas pela `trans_key`
- Cria ou renova cliente no Sigma automaticamente
- Mapeamento flexível de planos Braip → Sigma
- Envia mensagem personalizada + mídia via Digisac
- Histórico de ativações com reenvio de mensagem
- Painel web com login por senha
