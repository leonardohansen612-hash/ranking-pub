import admin from 'firebase-admin';

function getDb() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase Admin não configurado no ambiente.');
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
  }

  return admin.firestore();
}

function safeHeaders(headers = {}) {
  const out = {};
  const blocked = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.includes(String(key).toLowerCase())) {
      out[key] = value;
    }
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
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const db = getDb();

    const doc = {
      receivedAt: new Date().toISOString(),
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
  } catch (error) {
    console.error('[SAIPOS WEBHOOK ERROR]', error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
