import { fetchAndAggregateDate } from './_ranking-core.js';
import { saveDailySnapshot, firebaseReady } from './_firebase.js';

function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

export default async function handler(req,res) {
  if (!process.env.SETUP_KEY || req.query.key !== process.env.SETUP_KEY) {
    return res.status(403).json({ok:false,error:'SETUP_KEY inválida'});
  }

  const date = String(req.query.date || '');
  if (!validDate(date)) {
    return res.status(400).json({ok:false,error:'Use date=YYYY-MM-DD'});
  }

  if (!firebaseReady()) {
    return res.status(500).json({
      ok:false,
      error:'Firebase Admin não configurado na Vercel.'
    });
  }

  try {
    const data = await fetchAndAggregateDate(date);
    const saved = await saveDailySnapshot(date, data);

    return res.status(200).json({
      ok:true,
      action:'backfill-and-save',
      date,
      rankingCount:data.ranking.length,
      top10:data.ranking.slice(0,10),
      stats:data.stats,
      warnings:data.warnings,
      firestore:{
        collection:'ranking_daily',
        document:date,
        month:saved.month,
        semester:saved.semester,
        year:saved.year
      }
    });
  } catch(e) {
    return res.status(500).json({
      ok:false,
      date,
      error:e.message
    });
  }
}
