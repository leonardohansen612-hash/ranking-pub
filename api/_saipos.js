const BASE = 'https://data.saipos.io/v1';

function authHeaders(token, mode='raw') {
  return {
    Authorization: mode === 'bearer' ? `Bearer ${token}` : token,
    Accept: 'application/json'
  };
}

async function requestJson(path, params) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error('SAIPOS_API_TOKEN não configurado.');

  const url = new URL(BASE + path);
  for (const [k,v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const mode = process.env.SAIPOS_AUTH_MODE || 'raw';
  let r = await fetch(url, { headers: authHeaders(token, mode) });

  if (r.status === 401 && mode === 'raw') {
    r = await fetch(url, { headers: authHeaders(token, 'bearer') });
  }

  const text = await r.text();

  if (!r.ok) {
    const err = new Error(`Saipos ${path} respondeu HTTP ${r.status}`);
    err.status = r.status;
    err.detail = text.slice(0, 500);
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Saipos ${path} respondeu conteúdo inválido.`);
  }
}

function unwrapList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];

  const preferred = [
    'data','results','result','records','rows',
    'sales','sale_items','sales_items'
  ];

  for (const key of preferred) {
    if (Array.isArray(json[key])) return json[key];
  }

  // Alguns endpoints devolvem um envelope com uma única chave contendo o array.
  for (const value of Object.values(json)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

async function fetchAll(path, date) {
  const start = `${date}T00:00:00`;
  const end   = `${date}T23:59:59`;

  const out = [];
  const limit = 1000;

  for (let offset=0; offset<10000; offset += limit) {
    const json = await requestJson(path, {
      p_date_column_filter: 'shift_date',
      p_filter_date_start: start,
      p_filter_date_end: end,
      p_limit: limit,
      p_offset: offset
    });

    const rows = unwrapList(json);
    out.push(...rows);

    if (rows.length < limit) break;
  }

  return out;
}

export async function fetchDay(date) {
  // Consulta independente: uma falha não apaga silenciosamente o resultado da outra.
  const [salesResult, itemsResult] = await Promise.allSettled([
    fetchAll('/search_sales', date),
    fetchAll('/sales_items', date)
  ]);

  const warnings = [];

  const sales = salesResult.status === 'fulfilled' ? salesResult.value : [];
  const itemGroups = itemsResult.status === 'fulfilled' ? itemsResult.value : [];

  if (salesResult.status === 'rejected') {
    warnings.push(`search_sales: ${salesResult.reason?.message || 'falha'}`);
  }
  if (itemsResult.status === 'rejected') {
    warnings.push(`sales_items: ${itemsResult.reason?.message || 'falha'}`);
  }

  // Se um dos dois endpoints falhar, não fingimos que foi atualização válida.
  if (salesResult.status === 'rejected' || itemsResult.status === 'rejected') {
    const e = new Error(warnings.join(' | '));
    e.partial = { sales, itemGroups, warnings };
    throw e;
  }

  return { sales, itemGroups, warnings };
}

export function getSaleId(obj) {
  const raw =
    obj?.id_sale ??
    obj?.sale_id ??
    obj?.idSale ??
    obj?.sale?.id_sale ??
    obj?.sale?.id;

  return raw === undefined || raw === null ? null : String(raw);
}

export function saleCanceled(sale) {
  const v = sale?.canceled ?? sale?.cancelled ?? sale?.deleted;
  return v === true || v === 1 || String(v || '').toUpperCase() === 'Y';
}

export function itemCanceled(item) {
  const v = item?.canceled ?? item?.cancelled ?? item?.deleted;
  return v === true || v === 1 || String(v || '').toUpperCase() === 'Y';
}

export function getItemName(item) {
  return String(
    item?.desc_sale_item ??
    item?.desc_store_item ??
    item?.item_name ??
    item?.sale_item_name ??
    item?.product_name ??
    item?.description ??
    item?.name ??
    ''
  ).trim();
}

export function getQty(item) {
  const n = Number(
    item?.quantity ??
    item?.qty ??
    item?.amount ??
    item?.item_quantity ??
    0
  );
  return Number.isFinite(n) ? n : 0;
}

function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .trim()
    .replace(/\s+/g,' ');
}

export function customerFor(sale) {
  const rawCustomerName = normalizeName(
    sale?.customer?.name ??
    sale?.customer_name ??
    sale?.name_customer ??
    sale?.desc_customer ??
    ''
  );

  // A própria Saipos pode devolver customer.name = "Consumidor não identificado"
  // mesmo quando a venda de salão/comanda possui o nome digitado em desc_sale.
  const customerIsGeneric = !rawCustomerName ||
    rawCustomerName.toLowerCase() === 'consumidor nao identificado';

  if (!customerIsGeneric) {
    const customerId = sale?.customer?.id_customer ?? sale?.id_customer;
    return {
      key: customerId ? `c:${customerId}` : `n:${rawCustomerName.toLowerCase()}`,
      name: rawCustomerName
    };
  }

  const descSale = normalizeName(sale?.desc_sale ?? '');
  if (descSale) {
    return {
      key: `d:${descSale.toLowerCase()}`,
      name: descSale
    };
  }

  const card = sale?.table_order?.id_store_order_card;
  if (card !== undefined && card !== null && card !== '') {
    return {
      key: `card:${card}`,
      name: `Comanda ${card}`
    };
  }

  const table = sale?.table_order?.id_store_table;
  if (table !== undefined && table !== null && table !== '') {
    return {
      key: `table:${table}`,
      name: `Mesa ${table}`
    };
  }

  const ticket = sale?.ticket?.number;
  if (ticket !== undefined && ticket !== null && ticket !== '') {
    return {
      key: `ticket:${ticket}`,
      name: `Ficha ${ticket}`
    };
  }

  return {
    key: `sale:${getSaleId(sale) || 'unknown'}`,
    name: 'Consumidor não identificado'
  };
}

const BEERS = [
  'pilsen',
  'bitterzinha',
  'hoplager',
  'witbier',
  'yba',
  'ybá',
  'ipa zero',
  'american ipa',
  'textreme',
  'english porter',
  'maria manuela'
];

export function isBeer(name) {
  const n = normalizeName(name).toLowerCase();
  return BEERS.some(b => n.includes(normalizeName(b).toLowerCase()));
}
