import { fetchAndAggregateDate, mergeSnapshots, saoPauloToday } from './_ranking-core.js';
import {
  firebaseReady,
  saveDailySnapshot,
  readDailySnapshot,
  readDailySnapshotsByMonth,
  readDailySnapshotsBySemester,
  readDailySnapshotsByYear,
  readAllDailySnapshots,
  periodMeta
} from './_firebase.js';

const RANKING_START_DATE = process.env.RANKING_START_DATE || '2026-09-02';

function number(v) {
  return Number(v || 0);
}

function mergeSameDayBest(previous, fresh) {
  if (!previous) return fresh;

  const rank = new Map();

  for (const person of (previous.ranking || [])) {
    if (!person?.key) continue;
    rank.set(person.key, {
      key: person.key,
      name: person.name,
      cups: number(person.cups),
      beers: { ...(person.beers || {}) }
    });
  }

  for (const person of (fresh.ranking || [])) {
    if (!person?.key) continue;

    const old = rank.get(person.key);

    if (!old) {
      rank.set(person.key, {
        key: person.key,
        name: person.name,
        cups: number(person.cups),
        beers: { ...(person.beers || {}) }
      });
      continue;
    }

    // Em uma leitura parcial da Saipos nunca reduzimos o que já foi
    // confirmado anteriormente no mesmo dia.
    old.name = person.name || old.name;
    old.cups = Math.max(number(old.cups), number(person.cups));

    for (const [beer, qty] of Object.entries(person.beers || {})) {
      old.beers[beer] = Math.max(number(old.beers[beer]), number(qty));
    }

    rank.set(person.key, old);
  }

  return {
    date: fresh.date || previous.date,
    ranking: [...rank.values()]
      .sort((a,b) => b.cups - a.cups || a.name.localeCompare(b.name,'pt-BR')),
    stats: {
      sales: Math.max(number(previous.stats?.sales), number(fresh.stats?.sales)),
      saleGroups: Math.max(number(previous.stats?.saleGroups), number(fresh.stats?.saleGroups)),
      matchedItems: Math.max(number(previous.stats?.matchedItems), number(fresh.stats?.matchedItems)),
      beerCups: Math.max(number(previous.stats?.beerCups), number(fresh.stats?.beerCups)),
      days: 1
    },
    warnings: fresh.warnings || []
  };
}

function officialDocs(docs) {
  return (docs || []).filter(doc =>
    typeof doc?.date === 'string' && doc.date >= RANKING_START_DATE
  );
}

export default async function handler(req,res) {
  const period = ['today','month','quarter','semester','year','alltime'].includes(req.query.period)
    ? req.query.period
    : 'today';

  const realToday = saoPauloToday();

  // Permite simular outra data somente com a SETUP_KEY.
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
      const fresh = await fetchAndAggregateDate(today);

      let data = fresh;
      let firebaseSaved = false;
      let firebaseError = null;
      let protectedSnapshot = false;
      let source = 'saipos';

      if (firebaseReady()) {
        try {
          const previous = await readDailySnapshot(today);
          const hasSaiposWarnings = Array.isArray(fresh.warnings) && fresh.warnings.length > 0;

          if (hasSaiposWarnings && previous) {
            // A Saipos respondeu parcialmente. Junta a leitura nova ao melhor
            // snapshot já confirmado do mesmo dia, sem deixar um 504 apagar
            // clientes/copos que já estavam salvos.
            data = mergeSameDayBest(previous, fresh);
            protectedSnapshot = true;
            source = 'saipos+firestore-protection';
          }

          await saveDailySnapshot(today, data);
          firebaseSaved = true;
        } catch(e) {
          firebaseError = e.message;
        }
      } else {
        firebaseError = 'Firebase Admin não configurado';
      }

      res.setHeader('Cache-Control','no-store');

      return res.status(200).json({
        ok:true,
        period:'today',
        date:today,
        simulatedDate:canOverrideDate,
        updatedAt:new Date().toISOString(),
        ranking:data.ranking,
        stats:data.stats,
        warnings:fresh.warnings || [],
        storage:{
          source,
          firebaseSaved,
          firebaseError,
          protectedSnapshot
        }
      });
    }

    if (!firebaseReady()) {
      throw new Error('Firebase Admin não configurado na Vercel.');
    }

    const meta = periodMeta(today);
    let docs=[];

    // Permite testar um mês específico no Firestore.
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

    // A competição oficial começa em 02/09/2026.
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
