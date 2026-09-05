const BASE = 'https://data.saipos.io/v1';

function authHeaders(token, mode = 'raw') {
  return {
    Authorization: mode === 'bearer' ? `Bearer ${token}` : token,
    Accept: 'application/json'
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(path, params, attempt = 1) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error('SAIPOS_API_TOKEN não configurado.');

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const mode = process.env.SAIPOS_AUTH_MODE || 'raw';
  let response = await fetch(url, { headers: authHeaders(token, mode) });
  if (response.status === 401 && mode === 'raw') {
    response = await fetch(url, { headers: authHeaders(token, 'bearer') });
  }

  const text = await response.text();

  if (!response.ok) {
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await sleep(attempt === 1 ? 1500 : 4000);
      return requestJson(path, params, attempt + 1);
    }
    const err = new Error(`Saipos ${path} respondeu HTTP ${response.status}`);
    err.status = response.status;
    err.detail = text.slice(0, 300);
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
    'data', 'results', 'result', 'records', 'rows',
    'sales', 'sale_items', 'sales_items', 'sales_status_histories'
  ];

  for (const key of preferred) {
    if (Array.isArray(json[key])) return json[key];
  }
  for (const value of Object.values(json)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function fetchPaged(path, dateColumn, start, end) {
  const out = [];
  const limit = 1000;

  for (let offset = 0; offset < 10000; offset += limit) {
    const json = await requestJson(path, {
      p_date_column_filter: dateColumn,
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

function getSaleId(obj) {
  const raw = obj?.id_sale ?? obj?.sale_id ?? obj?.idSale ?? obj?.sale?.id_sale ?? obj?.sale?.id;
  return raw == null ? null : String(raw);
}

function compactSale(s) {
  return {
    id_sale: getSaleId(s),
    id_sale_type: s?.id_sale_type ?? null,
    desc_sale: s?.desc_sale ?? null,
    shift_date: s?.shift_date ?? null,
    created_at: s?.created_at ?? null,
    updated_at: s?.updated_at ?? null,
    canceled: s?.canceled ?? s?.cancelled ?? s?.deleted ?? null,
    customer_name: s?.customer?.name ?? s?.customer_name ?? s?.name_customer ?? null,
    card: s?.table_order?.id_store_order_card ?? s?.id_store_order_card ?? null,
    table: s?.table_order?.id_store_table ?? s?.id_store_table ?? null,
    status: s?.table_order?.id_table_status ?? s?.id_table_status ?? s?.status ?? null
  };
}

function compactGroup(g) {
  const items = Array.isArray(g?.items) ? g.items : [];
  return {
    id_sale: getSaleId(g),
    shift_date: g?.shift_date ?? null,
    created_at: g?.created_at ?? null,
    updated_at: g?.updated_at ?? null,
    items_count: items.length,
    items: items.map(i => ({
      name: i?.desc_sale_item ?? i?.desc_store_item ?? i?.item_name ?? i?.product_name ?? i?.name ?? null,
      quantity: i?.quantity ?? i?.qty ?? i?.amount ?? i?.item_quantity ?? null,
      canceled: i?.canceled ?? i?.cancelled ?? i?.deleted ?? null
    }))
  };
}

function compactStatus(h) {
  return {
    id_sale: getSaleId(h),
    id_sale_type: h?.id_sale_type ?? null,
    shift_date: h?.shift_date ?? null,
    created_at: h?.created_at ?? null,
    updated_at: h?.updated_at ?? null,
    status: h?.id_sale_status ?? h?.sale_status ?? h?.status ?? h?.id_status ?? null,
    raw_status_name: h?.desc_sale_status ?? h?.status_name ?? h?.description ?? null
  };
}

function uniqueIds(rows) {
  return [...new Set(rows.map(getSaleId).filter(Boolean))].sort();
}

function diff(a, b) {
  const bSet = new Set(b);
  return a.filter(x => !bSet.has(x));
}

function saoPauloParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

export default async function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const p = saoPauloParts();
  const date = `${p.year}-${p.month}-${p.day}`;
  const start = `${date}T00:00:00`;
  const end = `${date}T${p.hour}:${p.minute}:${p.second}`;
  const filters = ['shift_date', 'created_at', 'updated_at'];

  const result = {
    ok: true,
    date,
    window: { start, end },
    generatedAt: new Date().toISOString(),
    searches: {},
    comparison: {},
    errors: []
  };

  for (const filter of filters) {
    for (const [key, path, compact] of [
      ['sales', '/search_sales', compactSale],
      ['items', '/sales_items', compactGroup],
      ['status_histories', '/sales_status_histories', compactStatus]
    ]) {
      try {
        const rows = await fetchPaged(path, filter, start, end);
        result.searches[filter] ??= {};
        result.searches[filter][key] = {
          count: rows.length,
          unique_sale_ids: uniqueIds(rows).length,
          rows: rows.map(compact)
        };
      } catch (e) {
        result.searches[filter] ??= {};
        result.searches[filter][key] = { count: null, unique_sale_ids: null, rows: [] };
        result.errors.push({ filter, endpoint: path, error: e.message, detail: e.detail || null });
      }
      await sleep(250);
    }
  }

  const ids = {};
  for (const filter of filters) {
    ids[filter] = {
      sales: uniqueIds(result.searches[filter]?.sales?.rows || []),
      items: uniqueIds(result.searches[filter]?.items?.rows || []),
      status: uniqueIds(result.searches[filter]?.status_histories?.rows || [])
    };
  }

  result.comparison = {
    shift_date: {
      sales_ids: ids.shift_date.sales,
      items_ids: ids.shift_date.items,
      status_ids: ids.shift_date.status,
      in_status_not_sales: diff(ids.shift_date.status, ids.shift_date.sales),
      in_items_not_sales: diff(ids.shift_date.items, ids.shift_date.sales)
    },
    created_at: {
      sales_ids: ids.created_at.sales,
      items_ids: ids.created_at.items,
      status_ids: ids.created_at.status,
      in_status_not_sales: diff(ids.created_at.status, ids.created_at.sales),
      in_items_not_sales: diff(ids.created_at.items, ids.created_at.sales)
    },
    updated_at: {
      sales_ids: ids.updated_at.sales,
      items_ids: ids.updated_at.items,
      status_ids: ids.updated_at.status,
      in_status_not_sales: diff(ids.updated_at.status, ids.updated_at.sales),
      in_items_not_sales: diff(ids.updated_at.items, ids.updated_at.sales)
    }
  };

  return res.status(200).json(result);
}
