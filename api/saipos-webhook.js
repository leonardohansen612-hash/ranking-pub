import { getFirestore } from './_firebase.js';

function safeHeaders(headers = {}) {
  const out = {};
  const blocked = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.includes(String(k).toLowerCase())) out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      endpoint: 'saipos-webhook',
      ready: true,
      message: 'Endpoint pronto para receber POST.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const db = getFirestore();
    const now = new Date();

    const doc = {
      receivedAt: now.toISOString(),
      method: req.method,
      headers: safeHeaders(req.headers),
      query: req.query || {},
      body: req.body ?? null
    };

    const ref = await db.collection('saipos_webhook_events').add(doc);

    console.log('[SAIPOS WEBHOOK]', ref.id, JSON.stringify(doc.body));

    return res.status(200).json({
      ok: true,
      received: true,
      eventId: ref.id
    });
  } catch (e) {
    console.error('[SAIPOS WEBHOOK ERROR]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
