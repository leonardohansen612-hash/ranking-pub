import { db, firebaseReady } from './_firebase.js';

export default async function handler(req,res) {
  if (!process.env.SETUP_KEY || req.query.key !== process.env.SETUP_KEY) {
    return res.status(403).json({ok:false,error:'SETUP_KEY inválida'});
  }

  if (!firebaseReady()) {
    return res.status(500).json({
      ok:false,
      error:'Firebase Admin não configurado na Vercel.'
    });
  }

  try {
    const ref = db().collection('system').doc('ranking-health');
    await ref.set({
      ok:true,
      source:'vercel',
      updatedAt:new Date().toISOString()
    }, {merge:true});

    const snap = await ref.get();

    return res.status(200).json({
      ok:true,
      firebase:'connected',
      document:snap.data()
    });
  } catch(e) {
    return res.status(500).json({
      ok:false,
      firebase:'error',
      error:e.message
    });
  }
}
