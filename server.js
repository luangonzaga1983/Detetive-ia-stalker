// Servidor local (rascunho). Requer Node 18+. Sem dependencias.
// Uso: node server.js  ->  abra http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- carrega o .env manualmente ---
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}

const PORT = process.env.PORT || 3000;
const PUBLIC_KEY = process.env.SIGILO_PUBLIC_KEY;
const SECRET_KEY = process.env.SIGILO_SECRET_KEY;
const DEFAULT_CPF = String(process.env.DEFAULT_CPF || '384.752.240-08').replace(/\D/g, ''); // documento padrao das cobrancas
const DEFAULT_NAME = process.env.DEFAULT_NAME || 'Cliente';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // ex: https://xxxx.ngrok-free.app
const GATEWAY = 'https://app.sigilopay.com.br/api/v1/gateway/pix/receive';

// Precos definidos AQUI (o navegador nunca decide o valor)
const PLANS = {
  single: { id: 'plan-single', name: 'Acesso Unico', price: 9.9 },
  lifetime: { id: 'plan-lifetime', name: 'Acesso Vitalicio', price: 37.9 },
};

// Pedidos em memoria (rascunho; no Next use um banco)
const orders = {};

function validCPF(c) {
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += parseInt(c[i]) * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== parseInt(c[t])) return false;
  }
  return true;
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('Corpo muito grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('JSON invalido')); }
    });
    req.on('error', reject);
  });
}

async function handleCreatePix(req, res) {
  if (!PUBLIC_KEY || !SECRET_KEY || PUBLIC_KEY.includes('COLE_')) {
    return send(res, 500, { error: 'Chaves do gateway nao configuradas no .env' });
  }
  if (!validCPF(DEFAULT_CPF)) {
    return send(res, 500, { error: 'DEFAULT_CPF ausente ou invalido no .env' });
  }
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  const plan = PLANS[body.plan];
  if (!plan) return send(res, 400, { error: 'Plano invalido.' });
  const phone = String(body.phone || '').replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 11) {
    return send(res, 400, { error: 'WhatsApp invalido.' });
  }
  // O cliente informa SO o telefone; nome, e-mail e CPF sao predefinidos (a API exige os campos).
  const cpf = DEFAULT_CPF;
  const name = DEFAULT_NAME;
  const email = phone + '@example.com';

  const identifier = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const payload = {
    identifier,
    amount: plan.price,
    client: { name, email, phone, document: cpf },
    products: [{ id: plan.id, name: plan.name, quantity: 1, price: plan.price }],
    metadata: { provider: 'Checkout', orderId: identifier },
  };
  if (PUBLIC_URL) payload.callbackUrl = PUBLIC_URL + '/api/webhook';
  else console.warn('[aviso] PUBLIC_URL vazio: sem webhook, o pagamento nao sera confirmado automaticamente.');

  try {
    const r = await fetch(GATEWAY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-public-key': PUBLIC_KEY,
        'x-secret-key': SECRET_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.pix || !data.pix.code) {
      console.error('[gateway erro]', r.status, JSON.stringify(data));
      return send(res, 502, { error: data.message || data.errorDescription || 'O gateway recusou a cobranca.' });
    }
    orders[identifier] = {
      status: 'PENDING',
      transactionId: data.transactionId,
      webhookToken: data.webhookToken || null, // fica SO no servidor
    };
    return send(res, 200, {
      identifier,
      code: data.pix.code,
      image: data.pix.image || null,
      expiresAt: data.pix.expiresAt || null,
    });
  } catch (e) {
    console.error('[erro ao chamar gateway]', e.message);
    return send(res, 502, { error: 'Falha ao falar com o gateway. Tente novamente.' });
  }
}

// Webhook: o formato exato do payload NAO foi verificado. Ele loga o corpo recebido.
async function handleWebhook(req, res) {
  let b;
  try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'invalido' }); }
  console.log('[webhook recebido]', JSON.stringify(b));

  const t = b.transaction || {};
  const identifier = t.identifier || b.identifier || (b.orderItems && b.orderItems.identifier);
  const status = String(t.status || b.status || b.event || '').toUpperCase();
  const token = b.token || b.webhookToken;
  const order = identifier && orders[identifier];

  if (!order) return send(res, 200, { ok: true }); // ignora desconhecidos
  // Sem token valido, ninguem (nem o comprador) consegue forjar "pago"
  if (!order.webhookToken || token !== order.webhookToken) {
    console.warn('[webhook] token ausente/invalido, ignorado');
    return send(res, 200, { ok: true });
  }
  if (status.includes('COMPLETED') || status.includes('PAID')) order.status = 'COMPLETED';
  return send(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/pix') return await handleCreatePix(req, res);
    if (req.method === 'POST' && url.pathname === '/api/webhook') return await handleWebhook(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
      const o = orders[decodeURIComponent(url.pathname.split('/').pop())];
      return send(res, 200, { status: o ? o.status : 'PENDING' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Erro interno' });
  }
});

server.listen(PORT, () => console.log('Rodando em http://localhost:' + PORT));