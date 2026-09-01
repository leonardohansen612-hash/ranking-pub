import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function privateKey() {
  const raw = process.env.FIREBASE_PRIVATE_KEY;
  if (!raw) return null;
  return raw.replace(/\\n/g, '\n');
}

export function firebaseReady() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );
}

function app() {
  if (!firebaseReady()) {
    throw new Error(
      'Firebase Admin não configurado. Verifique FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY.'
    );
  }

  if (getApps().length) return getApps()[0];

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey()
    })
  });
}

export function db() {
  return getFirestore(app());
}

export function periodMeta(date) {
  const [year, monthNum] = String(date).split('-').map(Number);
  const month = `${year}-${String(monthNum).padStart(2,'0')}`;
  const semester = `${year}-S${monthNum <= 6 ? 1 : 2}`;
  return { year, month, semester };
}

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRanking(ranking=[]) {
  return [...ranking]
    .filter(p => p?.key)
    .map(p => ({
      key: p.key,
      name: p.name,
      cups: num(p.cups),
      beers: { ...(p.beers || {}) }
    }))
    .sort((a,b) => b.cups - a.cups || a.name.localeCompare(b.name,'pt-BR'));
}

function mergeMonotonic(previous, fresh) {
  const rank = new Map();

  for (const person of normalizeRanking(previous?.ranking || [])) {
    rank.set(person.key, {
      ...person,
      beers: { ...(person.beers || {}) }
    });
  }

  for (const person of normalizeRanking(fresh?.ranking || [])) {
    const old = rank.get(person.key);

    if (!old) {
      rank.set(person.key, {
        ...person,
        beers: { ...(person.beers || {}) }
      });
      continue;
    }

    old.name = person.name || old.name;
    old.cups = Math.max(num(old.cups), num(person.cups));

    for (const [beer, qty] of Object.entries(person.beers || {})) {
      old.beers[beer] = Math.max(num(old.beers[beer]), num(qty));
    }

    rank.set(person.key, old);
  }

  return [...rank.values()]
    .sort((a,b) => b.cups - a.cups || a.name.localeCompare(b.name,'pt-BR'));
}

function rankingSignature(ranking=[]) {
  return JSON.stringify(
    normalizeRanking(ranking).map(p => ({
      key: p.key,
      name: p.name,
      cups: p.cups,
      beers: Object.fromEntries(
        Object.entries(p.beers || {}).sort(([a],[b]) => a.localeCompare(b,'pt-BR'))
      )
    }))
  );
}


// Compatibilidade com api/backfill.js.
// O backfill continua podendo gravar snapshots históricos diretamente.
export async function saveDailySnapshot(date, payload) {
  const meta = periodMeta(date);
  const ref = db().collection('ranking_daily').doc(date);

  const doc = {
    date,
    ...meta,
    status: 'snapshot',
    ranking: payload.ranking || [],
    stats: payload.stats || {},
    warnings: payload.warnings || [],
    source: 'saipos',
    updatedAt: new Date().toISOString()
  };

  await ref.set(doc, { merge:false });
  return doc;
}

export async function saveDailySnapshotMonotonic(date, fresh) {
  const firestore = db();
  const ref = firestore.collection('ranking_daily').doc(date);
  const nowIso = new Date().toISOString();

  return firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const previous = snap.exists ? snap.data() : null;
    const ranking = mergeMonotonic(previous, fresh);

    const changed = rankingSignature(previous?.ranking || []) !== rankingSignature(ranking);

    const meta = periodMeta(date);
    const doc = {
      date,
      ...meta,
      status: 'snapshot',
      ranking,
      stats: {
        sales: Math.max(num(previous?.stats?.sales), num(fresh?.stats?.sales)),
        saleGroups: Math.max(num(previous?.stats?.saleGroups), num(fresh?.stats?.saleGroups)),
        matchedItems: Math.max(num(previous?.stats?.matchedItems), num(fresh?.stats?.matchedItems)),
        beerCups: Math.max(num(previous?.stats?.beerCups), num(fresh?.stats?.beerCups)),
        days: 1
      },
      warnings: fresh?.warnings || [],
      source: 'saipos-monotonic',
      // updatedAt representa mudança REAL no ranking.
      updatedAt: changed
        ? nowIso
        : (previous?.updatedAt || nowIso),
      lastSaiposAttemptAt: nowIso,
      lastSaiposSuccessAt: nowIso
    };

    tx.set(ref, doc, { merge:false });

    return {
      ...doc,
      changed
    };
  });
}

export async function recordSaiposAttempt(date, { error=null } = {}) {
  const ref = db().collection('ranking_daily').doc(date);
  await ref.set({
    lastSaiposAttemptAt: new Date().toISOString(),
    ...(error ? { lastSaiposError: error } : {})
  }, { merge:true });
}

export async function readDailySnapshot(date) {
  const snap = await db().collection('ranking_daily').doc(date).get();
  if (!snap.exists) return null;
  return { id:snap.id, ...snap.data() };
}

// Controle separado do ranking:
// - minIntervalMs limita a frequência de consulta à Saipos
// - leaseMs impede duas consultas simultâneas
export async function acquireDailyRefreshLease(
  date,
  { minIntervalMs = 60000, leaseMs = 120000 } = {}
) {
  const firestore = db();
  const leaseRef = firestore.collection('ranking_refresh').doc(date);
  const now = Date.now();

  return firestore.runTransaction(async tx => {
    const snap = await tx.get(leaseRef);
    const data = snap.exists ? snap.data() : {};

    const lastAttemptAt = Date.parse(data?.lastAttemptAt || '');
    if (Number.isFinite(lastAttemptAt) && (now - lastAttemptAt) < minIntervalMs) {
      return {
        acquired:false,
        reason:'fresh-attempt',
        lastAttemptAt:data.lastAttemptAt
      };
    }

    const leaseUntil = Number(data?.leaseUntil || 0);
    if (leaseUntil > now) {
      return {
        acquired:false,
        reason:'busy',
        leaseUntil
      };
    }

    const nowIso = new Date(now).toISOString();

    tx.set(leaseRef, {
      date,
      leaseUntil: now + leaseMs,
      lastAttemptAt: nowIso,
      startedAt: nowIso
    }, { merge:true });

    return {
      acquired:true,
      reason:'due',
      lastAttemptAt:nowIso
    };
  });
}

export async function releaseDailyRefreshLease(date) {
  await db().collection('ranking_refresh').doc(date).set({
    leaseUntil: 0,
    finishedAt: new Date().toISOString()
  }, { merge:true });
}

export async function readDailySnapshotsByMonth(month) {
  const snap = await db()
    .collection('ranking_daily')
    .where('month', '==', month)
    .get();

  return snap.docs
    .map(d => ({ id:d.id, ...d.data() }))
    .filter(d => Array.isArray(d.ranking));
}

export async function readDailySnapshotsBySemester(semester) {
  const snap = await db()
    .collection('ranking_daily')
    .where('semester', '==', semester)
    .get();

  return snap.docs
    .map(d => ({ id:d.id, ...d.data() }))
    .filter(d => Array.isArray(d.ranking));
}

export async function readDailySnapshotsByYear(year) {
  const snap = await db()
    .collection('ranking_daily')
    .where('year', '==', Number(year))
    .get();

  return snap.docs
    .map(d => ({ id:d.id, ...d.data() }))
    .filter(d => Array.isArray(d.ranking));
}

export async function readAllDailySnapshots() {
  const snap = await db().collection('ranking_daily').get();
  return snap.docs
    .map(d => ({ id:d.id, ...d.data() }))
    .filter(d => Array.isArray(d.ranking));
}
