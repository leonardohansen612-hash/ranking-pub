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
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const configuredMode = process.env.SAIPOS_AUTH_MODE || 'raw';
  const delays = [0, 2000, 5000, 10000];
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt++) {
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
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`Saipos ${path} respondeu conteúdo inválido.`);
        }
      }

      const err = new Error(`Saipos ${path} respondeu HTTP ${r.status}: ${text.slice(0, 220)}`);
      err.status = r.status;
      err.detail = text.slice(0, 500);
      lastError = err;

      // Erros transitórios da Saipos: tenta novamente com espera crescente.
      if (![429, 500, 502, 503, 504].includes(r.status)) throw err;
    } catch (e) {
      lastError = e;
      if (e?.status && ![429, 500, 502, 503, 504].includes(e.status)) throw e;
    }
  }

  throw lastError || new Error(`Falha ao consultar ${path} na Saipos.`);
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
  // A Saipos apresentou timeout de pool (PGRST003/504) quando recebia consultas
  // simultâneas. Fazemos as duas leituras em sequência para reduzir a pressão.
  const warnings = [];
  let sales = [];
  let itemGroups = [];

  try {
    sales = await fetchAll('/search_sales', date);
  } catch (e) {
    warnings.push(`search_sales: ${e?.message || 'falha'}`);
  }

  try {
    itemGroups = await fetchAll('/sales_items', date);
  } catch (e) {
    warnings.push(`sales_items: ${e?.message || 'falha'}`);
  }

  // Precisamos dos dois lados para associar cada copo ao cliente correto.
  // Em caso de falha, o ranking.js mantém o último snapshot válido no Firestore.
  if (warnings.length) {
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

  // Para vendas de salão/comanda, a Saipos pode trazer o objeto customer
  // como "Consumidor não identificado" e manter o nome digitado em desc_sale.
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
