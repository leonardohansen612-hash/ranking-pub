import {
  firebaseReady,
  saveIncrementalSaleTest,
  readIncrementalSalesTest
} from './_firebase.js';

const BASE = 'https://data.saipos.io/v1';
const wait = ms => new Promise(r => setTimeout(r, ms));

function authHeaders(token, bearer = false) {
  return { Authorization: bearer ? `Bearer ${token}` : token, Accept: 'application/json' };
}

async function saipos(path, params = {}, retries = 3) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error('SAIPOS_API_TOKEN não configurado.');

  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k,v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  let last;
  for (let attempt=1; attempt<=retries; attempt++) {
    try {
      let r = await fetch(url, { headers: authHeaders(token) });
      if (r.status === 401) r = await fetch(url, { headers: authHeaders(token, true) });

      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }

      if (r.ok) {
        return Array.isArray(body)
          ? body
          : (body?.data || body?.items || body?.results || body?.records || body?.result || []);
      }

      const msg = `Saipos ${r.status}: ${typeof body === 'string' ? body.slice(0,400) : JSON.stringify(body).slice(0,400)}`;
      if ((r.status === 504 || body?.code === 'PGRST003') && attempt < retries) {
        last = new Error(msg);
        await wait(900 * attempt);
        continue;
      }
      throw new Error(msg);
    } catch (e) {
      last = e;
      if (/504|PGRST003|timeout|Timed out/i.test(String(e?.message || e)) && attempt < retries) {
        await wait(900 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

function sp(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).formatToParts(d).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const saleId = o => String(o?.id_sale ?? o?.sale?.id_sale ?? o?.sale_id ?? '');

function parseCreatedAt(v) {
  const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? {y:+m[1],mo:+m[2],d:+m[3],h:+m[4],mi:+m[5],s:+m[6]} : null;
}

function shifted(p, mins) {
  const d=new Date(Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi+mins,p.s));
  const z=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
}

const beerWords = [
  'pilsen','hoplager','witbier','bitterzinha','ybá','yba','ipa zero','american ipa',
  'textreme','english porter','maria manuela','maria manoela','milkshake neipa',
  'session ipa','sunrise','winner blond','pilsen caju'
];

function itemName(x) {
  return String(x?.desc_sale_item ?? x?.desc_store_item ?? x?.desc_item ?? x?.item_name ?? x?.name ?? '').trim();
}
function itemQty(x) {
  const n=Number(x?.quantity ?? x?.qty ?? 1);
  return Number.isFinite(n) ? n : 0;
}
function itemCanceled(x) {
  return ['Y','S',true,1,'1'].includes(x?.deleted ?? x?.canceled ?? x?.cancelled);
}
function isBeer(n) {
  const s=String(n||'').toLowerCase();
  return beerWords.some(k => s.includes(k));
}

async function changedWindow(start,end) {
  return saipos('/search_sales', {
    p_date_column_filter:'updated_at',
    p_filter_date_start:sp(start),
    p_filter_date_end:sp(end),
    p_limit:100,
    p_offset:0
  });
}

async function saleItems(createdAt) {
  const p=parseCreatedAt(createdAt);
  if (!p) return [];
  return saipos('/sales_items', {
    p_date_column_filter:'created_at',
    p_filter_date_start:shifted(p,-2),
    p_filter_date_end:shifted(p,8),
    p_limit:300,
    p_offset:0
  });
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');

  try {
    if (!firebaseReady()) throw new Error('Firebase Admin não configurado.');

    const now=new Date();
    const ago=s=>new Date(now.getTime()-s*1000);

    // 3 blocos curtos. Falha de um bloco não impede os demais.
    const windows=[[ago(75),ago(45)],[ago(52),ago(22)],[ago(29),now]];
    const sales=new Map();
    const checks=[];

    for (const [a,b] of windows) {
      try {
        const rows=await changedWindow(a,b);
        rows.forEach(s => { const id=saleId(s); if(id) sales.set(id,s); });
        checks.push({start:sp(a),end:sp(b),ok:true,sales:rows.length});
      } catch(e) {
        checks.push({start:sp(a),end:sp(b),ok:false,sales:0,error:e.message});
      }
    }

    const saved=[];
    const errors=[];

    for (const sale of sales.values()) {
      if (['Y','S',true,1,'1'].includes(sale?.canceled)) continue;
      const id=saleId(sale);

      try {
        const groups=await saleItems(sale?.created_at);
        const group=groups.find(g => saleId(g)===id);
        const items=Array.isArray(group?.items) ? group.items : [];

        let cups=0;
        const beers=[];
        for (const item of items) {
          if (itemCanceled(item)) continue;
          const name=itemName(item);
          if (!isBeer(name)) continue;
          const quantity=itemQty(item);
          if (quantity<=0) continue;
          cups+=quantity;
          beers.push({name,quantity});
        }

        const doc=await saveIncrementalSaleTest({
          id_sale:id,
          customer:String(sale?.desc_sale||'').trim() || 'Não identificado',
          created_at:sale?.created_at || null,
          updated_at:sale?.updated_at || null,
          cups,
          beers
        });

        saved.push(doc);
      } catch(e) {
        errors.push({id_sale:id,error:e.message});
      }
    }

    const stored=await readIncrementalSalesTest();

    return res.status(200).json({
      ok:true,
      test:'incremental-firestore-v1',
      coverage:{start:sp(windows[0][0]),end:sp(now)},
      windows:checks,
      detectedSales:sales.size,
      savedSales:saved.length,
      saved,
      errors,
      firestore:{
        collection:'ranking_incremental_test',
        totalDocs:stored.length,
        docs:stored
      }
    });
  } catch(e) {
    return res.status(500).json({
      ok:false,
      test:'incremental-firestore-v1',
      error:e?.message || String(e)
    });
  }
}
