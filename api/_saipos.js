const BASE = 'https://data.saipos.io/v1';

function authHeaders(token, mode='raw') {
  return {
    Authorization: mode === 'bearer' ? `Bearer ${token}` : token,
    Accept: 'application/json'
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestJson(path, params) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error('SAIPOS_API_TOKEN não configurado.');

  const url = new URL(BASE + path);
  for (const [k,v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const configuredMode = process.env.SAIPOS_AUTH_MODE || 'raw';
  const delays = [0, 2000, 5000, 10000];
  let lastError = null;

  for (let attempt=0; attempt<delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      let mode = configuredMode;
      let r = await fetch(url, { headers: authHeaders(token, mode) });
      if (r.status === 401 && mode === 'raw') {
        mode = 'bearer';
        r = await fetch(url, { headers: authHeaders(token, mode) });
      }
      const text = await r.text();
      if (r.ok) {
        try { return JSON.parse(text); }
        catch { throw new Error(`Saipos ${path} respondeu conteúdo inválido.`); }
      }
      const err = new Error(`Saipos ${path} respondeu HTTP ${r.status}: ${text.slice(0,220)}`);
      err.status = r.status;
      lastError = err;
      if (![429,500,502,503,504].includes(r.status)) throw err;
    } catch (e) {
      lastError = e;
      if (e?.status && ![429,500,502,503,504].includes(e.status)) throw e;
    }
  }
  throw lastError || new Error(`Falha ao consultar ${path} na Saipos.`);
}

function unwrapList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of ['data','results','result','records','rows','sales','sale_items','sales_items','items']) {
    if (Array.isArray(json[key])) return json[key];
  }
  for (const value of Object.values(json)) if (Array.isArray(value)) return value;
  return [];
}

async function fetchAll(path, date) {
  // A documentação da Saipos define estes filtros como date-time. Mantemos o
  // turno (shift_date) e o formato com espaço usado nos exemplos oficiais.
  const start = `${date} 00:00:00`;
  const end   = `${date} 23:59:59`;
  const out=[];
  const limit=1000;

  for (let offset=0; offset<10000; offset+=limit) {
    const json = await requestJson(path, {
      p_date_column_filter:'shift_date',
      p_filter_date_start:start,
      p_filter_date_end:end,
      p_limit:limit,
      p_offset:offset
    });
    const rows = unwrapList(json);
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

export async function fetchDay(date) {
  // Sequencial para reduzir os 504/PGRST003 observados na Saipos.
  const sales = await fetchAll('/search_sales', date);
  const itemGroups = await fetchAll('/sales_items', date);
  return { sales, itemGroups, warnings:[] };
}

function first(obj, paths) {
  for (const path of paths) {
    let v=obj;
    for (const k of path.split('.')) v=v?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function getSaleId(obj) {
  const raw = first(obj, ['id_sale','sale.id_sale','sale_id','idSale','sale.id']);
  return raw === undefined || raw === null ? null : String(raw);
}

export function saleCanceled(sale) {
  const v = first(sale,['canceled','cancelled','is_canceled','is_cancelled','deleted']);
  return ['Y','S',true,1,'1'].includes(v);
}

export function itemCanceled(item) {
  const v = first(item,['canceled','cancelled','is_canceled','is_cancelled','deleted']);
  return ['Y','S',true,1,'1'].includes(v);
}

export function getItemName(item) {
  return String(first(item,[
    'desc_sale_item','desc_store_item','desc_item','item_name','sale_item_name',
    'product_name','description','name','item.desc_store_item','item.desc_item',
    'item.name','store_item.desc_store_item','product.name'
  ]) ?? '').trim();
}

export function getQty(item) {
  const n = Number(first(item,['quantity','qty','count','quantity_item','item_quantity','amount']) ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function repairMojibake(value) {
  let s = String(value ?? '');

  // A Saipos pode chegar com texto UTF-8 interpretado como latin1/windows-1252
  // (ex.: "não" vira "nÃ£o"). Se isso acontecer, reconstituímos o UTF-8
  // antes de comparar ou exibir o nome.
  if (/[ÃÂ]/.test(s)) {
    try {
      const fixed = Buffer.from(s, 'latin1').toString('utf8');
      if (fixed && !fixed.includes('�')) s = fixed;
    } catch {}
  }

  return s;
}

function displayName(value) {
  return repairMojibake(value).trim().replace(/\s+/g,' ');
}

function comparable(value) {
  return displayName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase();
}

function isGenericName(value) {
  const n = comparable(value).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return true;

  // Deliberadamente tolerante a texto corrompido. O bug observado no ranking
  // gerava "Consumidor nA£o identificado" depois da normalização; por isso
  // não dependemos da grafia exata da palavra "não".
  if (n === 'nao identificado' || n === 'não identificado') return true;
  if (n.includes('consumidor') && n.includes('identificado')) return true;
  if (n.includes('cliente') && n.includes('nao identificado')) return true;

  return false;
}

export function customerFor(sale) {
  const saleType = Number(sale?.id_sale_type || 0);
  const descSale = displayName(sale?.desc_sale);
  const customerName = displayName(first(sale,[
    'customer.name','customer_name','name_customer','desc_customer'
  ]));
  const customerId = first(sale,['customer.id_customer','id_customer']);

  // IMPORTANTE: para Salão (3) e Ficha (4), a própria documentação da Saipos
  // define desc_sale como o texto de identificação da venda, normalmente o nome
  // do cliente/posição. Portanto ele é a fonte principal nesses tipos de venda.
  if ((saleType === 3 || saleType === 4) && descSale && !isGenericName(descSale)) {
    return { key:`d:${comparable(descSale)}`, name:descSale };
  }

  // Nos demais tipos, ou quando desc_sale está vazio/genérico, usa o cadastro do cliente.
  if (customerName && !isGenericName(customerName)) {
    return {
      key: customerId ? `c:${customerId}` : `n:${comparable(customerName)}`,
      name: customerName
    };
  }

  // Fallback adicional: mesmo fora de salão/ficha, desc_sale pode carregar identificação útil.
  if (descSale && !isGenericName(descSale)) {
    return { key:`d:${comparable(descSale)}`, name:descSale };
  }

  const card = first(sale,['table_order.id_store_order_card','id_store_order_card']);
  if (card !== undefined && card !== null && card !== '') {
    return { key:`card:${card}`, name:`Comanda ${card}` };
  }

  const table = first(sale,['table_order.id_store_table','id_store_table']);
  if (table !== undefined && table !== null && table !== '') {
    return { key:`table:${table}`, name:`Mesa ${table}` };
  }

  const ticket = first(sale,['ticket.number','ticket_number']);
  if (ticket !== undefined && ticket !== null && ticket !== '') {
    return { key:`ticket:${ticket}`, name:`Ficha ${ticket}` };
  }

  return { key:`sale:${getSaleId(sale) || 'unknown'}`, name:'Consumidor não identificado' };
}

const DEFAULT_BEERS = [
  'pilsen','hoplager','witbier','bitterzinha','ybá','yba','ipa zero','american ipa',
  'textreme','english porter','maria manuela','maria manoela','milkshake neipa',
  'session ipa','sunrise','winner blond','pilsen caju'
];

export function isBeer(name) {
  const custom = String(process.env.BEER_KEYWORDS || '')
    .split(',').map(x=>x.trim()).filter(Boolean);
  const keys = custom.length ? custom : DEFAULT_BEERS;
  const n = comparable(name);
  return keys.some(k => n.includes(comparable(k)));
}
