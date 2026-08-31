const BASE = 'https://data.saipos.io/v1';

function authHeaders(token, mode='raw') {
  return {
    Authorization: mode === 'bearer' ? `Bearer ${token}` : token,
    Accept: 'application/json'
  };
}

export async function saiposFetch(path, params={}) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error('SAIPOS_API_TOKEN não configurado na Vercel.');

  const url = new URL(BASE + path);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const mode = process.env.SAIPOS_AUTH_MODE || 'raw';
  let r = await fetch(url, { headers: authHeaders(token, mode) });

  if (r.status === 401 && mode === 'raw') {
    r = await fetch(url, { headers: authHeaders(token, 'bearer') });
  }

  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!r.ok) {
    throw new Error(
      `Saipos ${r.status}: ${
        typeof body === 'string' ? body.slice(0,500) : JSON.stringify(body).slice(0,500)
      }`
    );
  }
  return body;
}

export function rows(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['data','items','results','records','result']) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

function pad(n){ return String(n).padStart(2,'0'); }

export function dateHourRange(date, hour) {
  const hh = pad(hour);
  return [`${date} ${hh}:00:00`, `${date} ${hh}:59:59`];
}

export async function fetchHour(path, date, hour) {
  const out = [];
  let offset = 0;
  const limit = Number(process.env.SAIPOS_PAGE_LIMIT || 250);

  for (let page=0; page<20; page++) {
    const [start,end] = dateHourRange(date, hour);
    const body = await saiposFetch(path, {
      p_date_column_filter: 'created_at',
      p_filter_date_start: start,
      p_filter_date_end: end,
      p_limit: limit,
      p_offset: offset
    });

    const batch = rows(body);
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

export function getSaleId(o) {
  return String(o?.id_sale ?? o?.sale?.id_sale ?? o?.sale_id ?? '');
}

export function saleCanceled(o) {
  return ['Y','S',true,1,'1'].includes(
    o?.canceled ?? o?.cancelled ?? o?.is_canceled ?? o?.is_cancelled
  );
}

export function itemCanceled(o) {
  return ['Y','S',true,1,'1'].includes(
    o?.deleted ?? o?.canceled ?? o?.cancelled ?? o?.is_canceled ?? o?.is_cancelled
  );
}

export function getItemName(o) {
  return String(
    o?.desc_sale_item ??
    o?.desc_store_item ??
    o?.desc_item ??
    o?.item_name ??
    o?.name ??
    o?.product_name ??
    ''
  ).trim();
}

export function getQty(o) {
  const q = Number(o?.quantity ?? o?.qty ?? o?.count ?? o?.amount ?? 1);
  return Number.isFinite(q) ? q : 0;
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g,' ').trim();
}

export function customerFor(sale) {
  // No uso real do Tex, desc_sale é o nome/comanda do cliente.
  const desc = cleanName(sale?.desc_sale);
  if (desc) return { key:`d:${desc.toLowerCase()}`, name:desc };

  const c = sale?.customer || {};
  const cname = cleanName(c.name);
  const normalized = cname.toLowerCase();

  if (cname &&
      !normalized.includes('consumidor') &&
      !normalized.includes('identificado')) {
    return {
      key: c.id_customer ? `c:${c.id_customer}` : `n:${normalized}`,
      name: cname
    };
  }

  const card = sale?.table_order?.id_store_order_card;
  const table = sale?.table_order?.id_store_table;
  if (card) return { key:`card:${card}`, name:`Comanda ${card}` };
  if (table) return { key:`table:${table}`, name:`Mesa ${table}` };

  return { key:`sale:${sale?.id_sale}`, name:'Não identificado' };
}

const DEFAULT_KEYWORDS = [
  'pilsen',
  'hoplager',
  'witbier',
  'bitterzinha',
  'ybá',
  'yba',
  'ipa zero',
  'american ipa',
  'textreme',
  'english porter',
  'maria manuela',
  'maria manoela',
  'milkshake neipa',
  'session ipa',
  'sunrise',
  'winner blond',
  'pilsen caju'
];

export function isBeer(name) {
  const custom = (process.env.BEER_KEYWORDS || '')
    .split(',')
    .map(x=>x.trim().toLowerCase())
    .filter(Boolean);

  const keywords = custom.length ? custom : DEFAULT_KEYWORDS;
  const n = String(name || '').toLowerCase();
  return keywords.some(k => n.includes(k));
}

export function hourWindow() {
  const start = Math.max(0, Math.min(23, Number(process.env.SAIPOS_START_HOUR ?? 14)));
  const end = Math.max(start, Math.min(23, Number(process.env.SAIPOS_END_HOUR ?? 23)));
  return {start,end};
}

export function saoPauloToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo',
    year:'numeric',
    month:'2-digit',
    day:'2-digit'
  }).formatToParts(new Date());

  const obj = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

export function monthDatesThrough(dateStr) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const out=[];
  for(let day=1; day<=d; day++) {
    out.push(`${y}-${pad(m)}-${pad(day)}`);
  }
  return out;
}
