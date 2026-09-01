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

function monotonicPayload(date, previous, fresh) {
  const meta = periodMeta(date);
  const rank = new Map();

  for (const person of (previous?.ranking || [])) {
    if (!person?.key) continue;
    rank.set(person.key, {
      key: person.key,
      name: person.name,
      cups: num(person.cups),
      beers: { ...(person.beers || {}) }
    });
  }

  for (const person of (fresh?.ranking || [])) {
    if (!person?.key) continue;

    const old = rank.get(person.key);
    if (!old) {
      rank.set(person.key, {
        key: person.key,
        name: person.name,
        cups: num(person.cups),
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

  return {
    date,
    ...meta,
    status: 'snapshot',
    ranking: [...rank.values()]
      .sort((a,b) => b.cups - a.cups || a.name.localeCompare(b.name,'pt-BR')),
    stats: {
      sales: Math.max(num(previous?.stats?.sales), num(fresh?.stats?.sales)),
      saleGroups: Math.max(num(previous?.stats?.saleGroups), num(fresh?.stats?.saleGroups)),
      matchedItems: Math.max(num(previous?.stats?.matchedItems), num(fresh?.stats?.matchedItems)),
      beerCups: Math.max(num(previous?.stats?.beerCups), num(fresh?.stats?.beerCups)),
      days: 1
    },
    warnings: fresh?.warnings || [],
    source: 'saipos-monotonic',
    updatedAt: new Date().toISOString()
  };
}

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

  await ref.set(doc, { merge: false });
  return doc;
}

// Grava o DIA de forma monotônica e transacional.
// Mesmo que duas atualizações terminem fora de ordem, uma leitura menor
// nunca consegue apagar copos/clientes já confirmados no mesmo dia.
export async function saveDailySnapshotMonotonic(date, fresh) {
  const firestore = db();
  const ref = firestore.collection('ranking_daily').doc(date);

  return firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const previous = snap.exists ? snap.data() : null;
    const doc = monotonicPayload(date, previous, fresh);
    tx.set(ref, doc, { merge: false });
    return doc;
  });
}

export async function readDailySnapshot(date) {
  const snap = await db().collection('ranking_daily').doc(date).get();
  if (!snap.exists) return null;
  return { id:snap.id, ...snap.data() };
}

// Evita que TV, navegador, GitHub Actions e testes disparem várias
// varreduras Saipos ao mesmo tempo.
export async function acquireDailyRefreshLease(
  date,
  { minIntervalMs = 300000, leaseMs = 120000 } = {}
) {
  const firestore = db();
  const dailyRef = firestore.collection('ranking_daily').doc(date);
  const leaseRef = firestore.collection('ranking_refresh').doc(date);
  const now = Date.now();

  return firestore.runTransaction(async tx => {
    const [dailySnap, leaseSnap] = await Promise.all([
      tx.get(dailyRef),
      tx.get(leaseRef)
    ]);

    if (dailySnap.exists) {
      const updatedAt = Date.parse(dailySnap.data()?.updatedAt || '');
      if (Number.isFinite(updatedAt) && (now - updatedAt) < minIntervalMs) {
        return { acquired:false, reason:'fresh' };
      }
    }

    const leaseUntil = Number(leaseSnap.exists ? leaseSnap.data()?.leaseUntil || 0 : 0);
    if (leaseUntil > now) {
      return { acquired:false, reason:'busy', leaseUntil };
    }

    tx.set(leaseRef, {
      date,
      leaseUntil: now + leaseMs,
      startedAt: new Date(now).toISOString()
    }, { merge:true });

    return { acquired:true, reason:'stale' };
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
