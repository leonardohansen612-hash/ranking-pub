import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldPath } from 'firebase-admin/firestore';

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


// --- Ranking incremental (coleção de teste isolada) ---
export async function saveIncrementalSaleTest(sale) {
  const idSale = String(sale?.id_sale || '').trim();
  if (!idSale) throw new Error('id_sale obrigatório.');
  const doc = {
    id_sale: idSale,
    customer: String(sale?.customer || '').trim() || 'Não identificado',
    created_at: sale?.created_at || null,
    updated_at: sale?.updated_at || null,
    cups: Number(sale?.cups || 0),
    beers: Array.isArray(sale?.beers) ? sale.beers : [],
    source: 'saipos-incremental-test',
    savedAt: new Date().toISOString()
  };
  await db().collection('ranking_incremental_test').doc(idSale).set(doc, { merge:false });
  return doc;
}
export async function readIncrementalSalesTest() {
  const snap = await db().collection('ranking_incremental_test').get();
  return snap.docs.map(d => ({ id:d.id, ...d.data() }));
}
