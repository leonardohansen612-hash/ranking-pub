import { db, firebaseReady } from './_firebase.js';

function nowIso() {
  return new Date().toISOString();
}

function eventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeHeaders(headers = {}) {
  const blocked = new Set([
    'authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
    'proxy-authorization'
  ]);

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => !blocked.has(String(key).toLowerCase()))
      .map(([key, value]) => [key, value])
  );
}

function bodyFrom(req) {
  if (req.body === undefined || req.body === null) return null;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return req.body;
}

export async function saiposWebhookPost(req, res) {
  const id = eventId();
  const receivedAt = nowIso();
  const payload = bodyFrom(req);

  const event = {
    id,
    receivedAt,
    method: req.method,
    path: req.originalUrl || req.url,
    query: req.query || {},
    headers: safeHeaders(req.headers || {}),
    payload
  };

  // O log é proposital: permite enxergar o payload real no Render sem
  // alterar o ranking nem depender de nenhuma interpretação prévia.
  console.log(`[SAIPOS_WEBHOOK] ${JSON.stringify(event)}`);

  let firebaseSaved = false;
  let firebaseError = null;

  try {
    if (firebaseReady()) {
      await db().collection('saipos_webhook_events').doc(id).set(event, { merge: false });
      firebaseSaved = true;
    }
  } catch (error) {
    firebaseError = error?.message || String(error);
    console.error(`[SAIPOS_WEBHOOK_FIREBASE_ERROR] ${firebaseError}`);
  }

  // Webhook deve receber 2xx mesmo se o armazenamento diagnóstico falhar.
  return res.status(200).json({
    ok: true,
    received: true,
    eventId: id,
    receivedAt,
    firebaseSaved,
    firebaseError
  });
}

export function saiposWebhookStatus(_req, res) {
  return res.status(200).json({
    ok: true,
    endpoint: '/api/saipos-webhook',
    accepts: 'POST',
    purpose: 'captura diagnostica de eventos Saipos',
    firebaseConfigured: firebaseReady(),
    timestamp: nowIso()
  });
}
