const BASE = 'https://data.saipos.io/v1';

function authHeaders(token, mode='raw') {
  return { Authorization: mode === 'bearer' ? `Bearer ${token}` : token, Accept: 'application/json' };
}

export async function saiposFetch(path, params) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error('SAIPOS_API_TOKEN não configurado na Vercel.');
  const url = new URL(BASE + path);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  let r = await fetch(url, {headers: authHeaders(token, process.env.SAIPOS_AUTH_MODE || 'raw')});
  if (r.status === 401 && (process.env.SAIPOS_AUTH_MODE || 'raw') === 'raw') {
    r = await fetch(url, {headers: authHeaders(token, 'bearer')});
  }
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`Saipos ${r.status}: ${typeof body === 'string' ? body.slice(0,500) : JSON.stringify(body).slice(0,500)}`);
  return body;
}

export function rows(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['data','items','results','records','result']) if (Array.isArray(body?.[key])) return body[key];
  return [];
}

export async function fetchPaged(path, start, end) {
  const out=[]; let offset=0; const limit=1000;
  for (let page=0; page<30; page++) {
    const body = await saiposFetch(path, {
      p_date_column_filter:'shift_date', p_filter_date_start:start, p_filter_date_end:end,
      p_limit:limit, p_offset:offset
    });
    const batch=rows(body); out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

export function isoLocal(d) {
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function periodsFor(mode='today', now=new Date()) {
  if (mode === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0);
    const end = new Date(now.getFullYear(), now.getMonth()+1, 1, 0,0,0);
    const chunks=[]; let a=start;
    while (a < end) {
      const b=new Date(Math.min(end.getTime(), a.getTime()+14*24*3600*1000));
      chunks.push([isoLocal(a), isoLocal(b)]); a=b;
    }
    return chunks;
  }
  const start=new Date(now.getFullYear(),now.getMonth(),now.getDate(),0,0,0);
  const end=new Date(start); end.setDate(end.getDate()+1);
  return [[isoLocal(start), isoLocal(end)]];
}

function first(obj, paths) {
  for (const path of paths) {
    let v=obj; for (const k of path.split('.')) v=v?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
}
export const getSaleId=o=>String(first(o,['id_sale','sale.id_sale','sale_id']) ?? '');
export const getItemName=o=>String(first(o,['desc_store_item','desc_item','item_name','name','product_name','item.desc_store_item','item.desc_item','item.name','store_item.desc_store_item','product.name']) ?? '');
export const getQty=o=>Number(first(o,['quantity','qty','count','quantity_item','item_quantity','amount']) ?? 1) || 0;
export const itemCanceled=o=>['Y','S',true,1,'1'].includes(first(o,['canceled','cancelled','is_canceled','is_cancelled']));
export const saleCanceled=o=>['Y','S',true,1,'1'].includes(first(o,['canceled','cancelled','is_canceled','is_cancelled']));

export function customerFor(sale) {
  const c=sale?.customer || {};
  const cname=String(c.name || '').trim();
  if (cname && cname.toLowerCase() !== 'consumidor não identificado') return {key:c.id_customer?`c:${c.id_customer}`:`n:${cname.toLowerCase()}`, name:cname};
  const desc=String(sale?.desc_sale || '').trim();
  if (desc) return {key:`d:${desc.toLowerCase()}`, name:desc};
  const card=sale?.table_order?.id_store_order_card;
  const table=sale?.table_order?.id_store_table;
  if (card) return {key:`card:${card}`, name:`Comanda ${card}`};
  if (table) return {key:`table:${table}`, name:`Mesa ${table}`};
  return {key:`sale:${sale?.id_sale}`, name:'Não identificado'};
}

const DEFAULT_KEYWORDS=['pilsen','hoplager','american ipa','ipa zero','bitterzinha','english porter','maria manoela','milkshake neipa','session ipa','sunrise','textreme','winner blond','witbier','pilsen caju'];
export function isBeer(name) {
  const custom=(process.env.BEER_KEYWORDS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  const ks=custom.length?custom:DEFAULT_KEYWORDS;
  const n=String(name||'').toLowerCase();
  return ks.some(k=>n.includes(k));
}
