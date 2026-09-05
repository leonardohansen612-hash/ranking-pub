import { fetchAndAggregateDate, fetchDebugDate, saoPauloToday } from './_ranking-core.js';
import {
  firebaseReady,
  saveDailySnapshotMonotonic,
  readDailySnapshot,
  acquireDailyRefreshLease,
  releaseDailyRefreshLease,
  recordSaiposAttempt
} from './_firebase.js';

function refreshIntervalMs() {
  const seconds = Math.max(
    60,
    Number(process.env.RANKING_REFRESH_SECONDS || 60)
  );
  return seconds * 1000;
}

function responseFromSnapshot(snapshot, extraStorage = {}) {
  return {
    updatedAt: snapshot?.updatedAt || null,
    lastSaiposAttemptAt: snapshot?.lastSaiposAttemptAt || null,
    lastSaiposSuccessAt: snapshot?.lastSaiposSuccessAt || null,
    ranking: snapshot?.ranking || [],
    stats: snapshot?.stats || {},
    warnings: snapshot?.warnings || [],
    storage: {
      source: 'firestore-cache',
      firebaseSaved: true,
      firebaseError: null,
      protectedSnapshot: true,
      ...extraStorage
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // A partir da V1.2 existe somente o ranking diário.
  const requestedPeriod = typeof req.query.period === 'string'
    ? req.query.period
    : 'today';

  if (requestedPeriod !== 'today') {
    return res.status(400).json({
      ok: false,
      period: requestedPeriod,
      error: 'Esta versão possui somente o ranking diário.'
    });
  }

  const today = saoPauloToday();

  // Diagnóstico temporário e somente leitura. Não grava nem altera o snapshot.
  if (String(req.query.debug || '') === '1') {
    try {
      const debug = await fetchDebugDate(today);
      return res.status(200).json({ ok:true, period:'today', debug:true, ...debug });
    } catch (e) {
      return res.status(500).json({ ok:false, period:'today', debug:true, date:today, error:e.message });
    }
  }

  try {
    if (!firebaseReady()) {
      const fresh = await fetchAndAggregateDate(today);

      return res.status(200).json({
        ok: true,
        period: 'today',
        date: today,
        updatedAt: new Date().toISOString(),
        lastSaiposAttemptAt: new Date().toISOString(),
        lastSaiposSuccessAt: new Date().toISOString(),
        ranking: fresh.ranking,
        stats: fresh.stats,
        warnings: fresh.warnings || [],
        storage: {
          source: 'saipos-direct',
          firebaseSaved: false,
          firebaseError: 'Firebase Admin não configurado',
          protectedSnapshot: false
        }
      });
    }

    const previous = await readDailySnapshot(today);

    const lease = await acquireDailyRefreshLease(today, {
      minIntervalMs: refreshIntervalMs(),
      leaseMs: 120000
    });

    // Se outra chamada já consultou recentemente ou está consultando,
    // devolvemos o snapshot estável imediatamente.
    if (!lease.acquired) {
      const latest = await readDailySnapshot(today) || previous;

      if (latest) {
        const payload = responseFromSnapshot(latest, {
          refreshReason: lease.reason
        });

        return res.status(200).json({
          ok: true,
          period: 'today',
          date: today,
          ...payload
        });
      }
    }

    let fresh = null;
    let saved = previous;
    let firebaseError = null;

    try {
      fresh = await fetchAndAggregateDate(today);
      saved = await saveDailySnapshotMonotonic(today, fresh);
    } catch (e) {
      firebaseError = e.message;

      try {
        await recordSaiposAttempt(today, { error: e.message });
      } catch {}
    } finally {
      try {
        await releaseDailyRefreshLease(today);
      } catch {}
    }

    if (!saved) {
      saved = await readDailySnapshot(today);
    }

    if (!saved) {
      throw new Error(firebaseError || 'Não foi possível obter o ranking do dia.');
    }

    return res.status(200).json({
      ok: true,
      period: 'today',
      date: today,
      updatedAt: saved.updatedAt || null,
      lastSaiposAttemptAt: saved.lastSaiposAttemptAt || null,
      lastSaiposSuccessAt: saved.lastSaiposSuccessAt || null,
      ranking: saved.ranking || [],
      stats: saved.stats || {},
      warnings: fresh?.warnings || saved.warnings || [],
      storage: {
        source: fresh ? 'saipos+firestore-monotonic' : 'firestore-fallback',
        firebaseSaved: Boolean(fresh && !firebaseError),
        firebaseError,
        protectedSnapshot: true,
        rankingChanged: Boolean(saved.changed),
        refreshReason: lease.reason
      }
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      period: 'today',
      date: today,
      error: e.message
    });
  }
}
