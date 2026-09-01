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
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
    });
  }
  return admin.firestore();
}

function safeHeaders(headers = {}) {
  const out = {};
  const blocked = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.includes(String(key).toLowerCase())) out[key] = value;
  }
  return out;
}

async function saveEvent(db, data) {
  const ref = await db.collection('saipos_webhook_events').add(data);
  return ref.id;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const db = getDb();
    const action = String(req.query?.action || '').toLowerCase();

    // GET normal: status do receptor
    if (req.method === 'GET' && !action) {
      return res.status(200).json({
        ok: true,
        endpoint: 'saipos-webhook',
        ready: true,
        tools: {
          selfTest: '/api/saipos-webhook?action=selftest',
          recentEvents: '/api/saipos-webhook?action=recent'
        }
      });
    }

    // GET ?action=selftest: simula um evento e grava no Firestore
    if (req.method === 'GET' && action === 'selftest') {
      const now = new Date().toISOString();
      const eventId = await saveEvent(db, {
        receivedAt: now,
        source: 'selftest',
        method: 'GET',
        body: {
          type: 'TEX_WEBHOOK_SELF_TEST',
          message: 'Teste interno Render -> Firestore',
          createdAt: now
        }
      });

      return res.status(200).json({
        ok: true,
        selfTest: true,
        saved: true,
        eventId,
        message: 'Auto-teste gravado no Firestore.'
      });
    }

    // GET ?action=recent: lista os últimos eventos
    if (req.method === 'GET' && action === 'recent') {
      const snap = await db.collection('saipos_webhook_events')
        .orderBy('receivedAt', 'desc')
        .limit(20)
        .get();

      const events = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      return res.status(200).json({
        ok: true,
        count: events.length,
        events
      });
    }

    // POST: recebe webhook real
    if (req.method === 'POST') {
      const now = new Date().toISOString();
      const eventId = await saveEvent(db, {
        receivedAt: now,
        source: 'saipos',
        method: req.method,
        headers: safeHeaders(req.headers),
        query: req.query || {},
        body: req.body ?? null
      });

      console.log('[SAIPOS WEBHOOK]', eventId, JSON.stringify(req.body ?? null));

      return res.status(200).json({
        ok: true,
        received: true,
        eventId
      });
    }

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  } catch (error) {
    console.error('[SAIPOS WEBHOOK ERROR]', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
