import { fetchAndAggregateDate, mergeSnapshots, saoPauloToday } from './_ranking-core.js';
import {
  firebaseReady,
  saveDailySnapshot,
  readDailySnapshotsByMonth,
  readDailySnapshotsBySemester,
  readDailySnapshotsByYear,
  readAllDailySnapshots,
  periodMeta
} from './_firebase.js';

export default async function handler(req,res) {
  const period = ['today','month','semester','year','alltime'].includes(req.query.period)
    ? req.query.period
    : 'today';

  const today = saoPauloToday();

  try {
    if (period === 'today') {
      const data = await fetchAndAggregateDate(today);
      let firebaseSaved = false;
      let firebaseError = null;

      if (firebaseReady()) {
        try {
          await saveDailySnapshot(today, data);
          firebaseSaved = true;
        } catch(e) {
          firebaseError = e.message;
        }
      } else {
        firebaseError = 'Firebase Admin não configurado';
      }

      res.setHeader(
        'Cache-Control',
        's-maxage=20, stale-while-revalidate=60'
      );

      return res.status(200).json({
        ok:true,
        period:'today',
        updatedAt:new Date().toISOString(),
        ranking:data.ranking,
        stats:data.stats,
        warnings:data.warnings,
        storage:{
          source:'saipos',
          firebaseSaved,
          firebaseError
        }
      });
    }

    if (!firebaseReady()) {
      throw new Error('Firebase Admin não configurado na Vercel.');
    }

    const meta = periodMeta(today);
    let docs=[];

    if (period === 'month') {
      docs = await readDailySnapshotsByMonth(meta.month);
    } else if (period === 'semester') {
      docs = await readDailySnapshotsBySemester(meta.semester);
    } else if (period === 'year') {
      docs = await readDailySnapshotsByYear(meta.year);
    } else {
      docs = await readAllDailySnapshots();
    }

    const merged = mergeSnapshots(docs);

    res.setHeader(
      'Cache-Control',
      's-maxage=30, stale-while-revalidate=120'
    );

    return res.status(200).json({
      ok:true,
      period,
      updatedAt:new Date().toISOString(),
      ranking:merged.ranking,
      stats:merged.stats,
      warnings:merged.warnings,
      storage:{
        source:'firestore',
        snapshots:docs.length
      }
    });

  } catch(e) {
    return res.status(500).json({
      ok:false,
      period,
      error:e.message
    });
  }
}
