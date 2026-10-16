// Versao Vercel do server.js: tudo em um arquivo. Rotas via vercel.json (rewrites).
const crypto = require('crypto');

const GATEWAY = 'https://app.sigilopay.com.br/api/v1/gateway/pix/receive';
const PLANS = {
  single: { id: 'plan-single', name: 'Acesso Unico', price: 9.9 },
  lifetime: { id: 'plan-lifetime', name: 'Acesso Vitalicio', price: 14.9 },
};

function validCPF(c) {
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += parseInt(c[i]) * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== parseInt(c[t])) return false;
  }
  return true;
}

// Pedidos precisam de armazenamento externo (memoria nao persiste na Vercel)
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis nao configurado');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
const saveOrder = (id, o) => redis(['SET', 'order:' + id, JSON.stringify(o), 'EX', '86400']);
const getOrder = async (id) => { const v = await redis(['GET', 'order:' + id]); return v ? JSON.parse(v) : null; };
const clean = (s) => String(s || '').replace(/[^a-zA-Z0-9]/g, '');
const parseBody = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});

async function createPix(req, res) {
  const PUBLIC_KEY = process.env.SIGILO_PUBLIC_KEY;
  const SECRET_KEY = process.env.SIGILO_SECRET_KEY;
  const CPF = String(process.env.DEFAULT_CPF || '').replace(/\D/g, '');
  const NAME = process.env.DEFAULT_NAME || 'Cliente - instahack';
  const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

  if (!PUBLIC_KEY || !SECRET_KEY) return res.status(500).json({ error: 'Chaves do gateway nao configuradas na Vercel' });
  if (!validCPF(CPF)) return res.status(500).json({ error: 'DEFAULT_CPF ausente ou invalido nas variaveis de ambiente' });

  const body = parseBody(req);
  const plan = PLANS[body.plan];
  if (!plan) return res.status(400).json({ error: 'Plano invalido.' });
  const phone = String(body.phone || '').replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 11) return res.status(400).json({ error: 'WhatsApp invalido.' });

  const identifier = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const payload = {
    identifier,
    amount: plan.price,
    client: { name: NAME, email: phone + '@example.com', phone, document: CPF },
    products: [{ id: plan.id, name: plan.name, quantity: 1, price: plan.price }],
    metadata: { provider: 'Checkout', orderId: identifier },
  };
  if (PUBLIC_URL) payload.callbackUrl = PUBLIC_URL + '/api/webhook';
  else console.warn('[aviso] PUBLIC_URL vazio: sem webhook.');

  try {
    const r = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-public-key': PUBLIC_KEY, 'x-secret-key': SECRET_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.pix || !data.pix.code) {
      console.error('[gateway erro]', r.status, JSON.stringify(data));
      return res.status(502).json({ error: data.message || data.errorDescription || 'O gateway recusou a cobranca.' });
    }
    await saveOrder(identifier, { status: 'PENDING', transactionId: data.transactionId, webhookToken: data.webhookToken || null });
    return res.status(200).json({ identifier, code: data.pix.code, image: data.pix.image || null, expiresAt: data.pix.expiresAt || null });
  } catch (e) {
    console.error('[erro em /api/pix]', e.message);
    return res.status(502).json({ error: 'Falha ao gerar o Pix. Tente novamente.' });
  }
}

async function webhook(req, res) {
  const b = parseBody(req);
  console.log('[webhook recebido]', JSON.stringify(b));
  const t = b.transaction || {};
  const identifier = clean(t.identifier || b.identifier || (b.orderItems && b.orderItems.identifier));
  const status = String(t.status || b.status || b.event || '').toUpperCase();
  const token = b.token || b.webhookToken;
  try {
    const order = identifier && (await getOrder(identifier));
    if (!order) return res.status(200).json({ ok: true });
    if (!order.webhookToken || token !== order.webhookToken) {
      console.warn('[webhook] token ausente/invalido, ignorado');
      return res.status(200).json({ ok: true });
    }
    if (status.includes('COMPLETED') || status.includes('PAID')) { order.status = 'COMPLETED'; await saveOrder(identifier, order); }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook erro]', e.message);
    return res.status(500).json({ error: 'erro interno' });
  }
}

async function status(req, res) {
  try {
    const id = clean(req.query.id);
    const o = id ? await getOrder(id) : null;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ status: o ? o.status : 'PENDING' });
  } catch (e) {
    console.error('[status]', e.message);
    return res.status(200).json({ status: 'PENDING' });
  }
}

module.exports = async (req, res) => {
  const r = req.query.r;
  if (r === 'pix' && req.method === 'POST') return createPix(req, res);
  if (r === 'webhook' && req.method === 'POST') return webhook(req, res);
  if (r === 'status' && req.method === 'GET') return status(req, res);
  return res.status(404).json({ error: 'Not found' });
};
