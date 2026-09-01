import { fetchAndAggregateDate, mergeSnapshots, saoPauloToday } from './_ranking-core.js';
import {
  firebaseReady,
  saveDailySnapshotMonotonic,
  readDailySnapshot,
  acquireDailyRefreshLease,
  releaseDailyRefreshLease,
  readDailySnapshotsByMonth,
  readDailySnapshotsBySemester,
  readDailySnapshotsByYear,
  readAllDailySnapshots,
  periodMeta
} from './_firebase.js';

const RANKING_START_DATE = process.env.RANKING_START_DATE || '2026-09-02';

function officialDocs(docs) {
  return (docs || []).filter(doc =>
    typeof doc?.date === 'string' && doc.date >= RANKING_START_DATE
  );
}

function refreshIntervalMs() {
  const seconds = Math.max(
    60,
    Number(process.env.RANKING_REFRESH_SECONDS || 300)
  );
  return seconds * 1000;
}

export default async function handler(req,res) {
  const period = ['today','month','quarter','semester','year','alltime'].includes(req.query.period)
    ? req.query.period
    : 'today';

  const realToday = saoPauloToday();

  const requestedDate = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
  const setupKey = process.env.SETUP_KEY || '';
  const canOverrideDate = Boolean(requestedDate) && validDate && setupKey && req.query.key === setupKey;

  if (requestedDate && !validDate) {
    return res.status(400).json({
      ok:false,
      period,
      error:'Data inválida. Use YYYY-MM-DD.'
    });
  }

  if (requestedDate && !canOverrideDate) {
    return res.status(403).json({
      ok:false,
      period,
      error:'Data de teste exige SETUP_KEY válida.'
    });
  }

  const today = canOverrideDate ? requestedDate : realToday;

  try {
    if (period === 'today') {
      res.setHeader('Cache-Control','no-store');

      // Sem Firebase, mantém fallback direto na Saipos.
      if (!firebaseReady()) {
        const fresh = await fetchAndAggregateDate(today);
        return res.status(200).json({
          ok:true,
          period:'today',
          date:today,
          simulatedDate:canOverrideDate,
          updatedAt:new Date().toISOString(),
          ranking:fresh.ranking,
          stats:fresh.stats,
          warnings:fresh.warnings || [],
          storage:{
            source:'saipos-direct',
            firebaseSaved:false,
            firebaseError:'Firebase Admin não configurado',
            protectedSnapshot:false
          }
        });
      }

      const previous = await readDailySnapshot(today);

      // A TV pode chamar a cada minuto, mas a Saipos só será varrida
      // quando o snapshot estiver velho. O restante lê o Firestore.
      const lease = await acquireDailyRefreshLease(today, {
        minIntervalMs: refreshIntervalMs(),
        leaseMs: 120000
      });

      if (!lease.acquired && previous) {
        return res.status(200).json({
          ok:true,
          period:'today',
          date:today,
          simulatedDate:canOverrideDate,
          updatedAt:previous.updatedAt || new Date().toISOString(),
          ranking:previous.ranking || [],
          stats:previous.stats || {},
          warnings:previous.warnings || [],
          storage:{
            source:'firestore-cache',
            firebaseSaved:true,
            firebaseError:null,
            protectedSnapshot:true,
            refreshReason:lease.reason
          }
        });
      }

      let fresh = null;
      let saved = previous;
      let firebaseError = null;

      try {
        fresh = await fetchAndAggregateDate(today);

        // SEMPRE faz merge monotônico no Firestore.
        // Não depende de warning para proteger o ranking.
        saved = await saveDailySnapshotMonotonic(today, fresh);
      } catch(e) {
        firebaseError = e.message;
      } finally {
        try {
          await releaseDailyRefreshLease(today);
        } catch {}
      }

      // Se a Saipos falhar totalmente mas já existe snapshot,
      // a TV continua mostrando o último estado confirmado.
      if (!saved && previous) saved = previous;

      if (!saved) {
        throw new Error(firebaseError || 'Não foi possível obter o ranking do dia.');
      }

      return res.status(200).json({
        ok:true,
        period:'today',
        date:today,
        simulatedDate:canOverrideDate,
        updatedAt:saved.updatedAt || new Date().toISOString(),
        ranking:saved.ranking || [],
        stats:saved.stats || {},
        warnings:fresh?.warnings || saved.warnings || [],
        storage:{
          source:fresh ? 'saipos+firestore-monotonic' : 'firestore-fallback',
          firebaseSaved:Boolean(fresh && !firebaseError),
          firebaseError,
          protectedSnapshot:true,
          refreshReason:lease.reason
        }
      });
    }

    if (!firebaseReady()) {
      throw new Error('Firebase Admin não configurado na Vercel.');
    }

    const meta = periodMeta(today);
    let docs=[];

    const requestedMonth = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    const validMonth = /^\d{4}-\d{2}$/.test(requestedMonth);

    if (period === 'month' && requestedMonth && !validMonth) {
      return res.status(400).json({
        ok:false,
        period,
        error:'Mês inválido. Use YYYY-MM.'
      });
    }

    if (period === 'month') {
      docs = await readDailySnapshotsByMonth(requestedMonth || meta.month);
    } else if (period === 'quarter') {
      const yearDocs = await readDailySnapshotsByYear(meta.year);
      const monthNum = Number(String(today).slice(5,7));
      const quarter = Math.floor((monthNum - 1) / 3) + 1;
      const firstMonth = (quarter - 1) * 3 + 1;
      const lastMonth = firstMonth + 2;

      docs = yearDocs.filter(doc => {
        const m = Number(String(doc?.date || '').slice(5,7));
        return m >= firstMonth && m <= lastMonth;
      });
    } else if (period === 'semester') {
      docs = await readDailySnapshotsBySemester(meta.semester);
    } else if (period === 'year') {
      docs = await readDailySnapshotsByYear(meta.year);
    } else {
      docs = await readAllDailySnapshots();
    }

    docs = officialDocs(docs);
    const merged = mergeSnapshots(docs);

    res.setHeader(
      'Cache-Control',
      's-maxage=30, stale-while-revalidate=120'
    );

    return res.status(200).json({
      ok:true,
      period,
      ...(period === 'month' ? { month: requestedMonth || meta.month } : {}),
      ...(period === 'quarter' ? {
        quarter: Math.floor((Number(String(today).slice(5,7)) - 1) / 3) + 1
      } : {}),
      rankingStartDate:RANKING_START_DATE,
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
