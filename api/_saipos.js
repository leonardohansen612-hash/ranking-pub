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

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

async function fetchAllByFilter(path, column, start, end) {
  const out=[];
  const limit=1000;

  for (let offset=0; offset<10000; offset+=limit) {
    const json = await requestJson(path, {
      p_date_column_filter:column,
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

function dateOnly(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^(\\d{4}-\\d{2}-\\d{2})/);
  return m ? m[1] : null;
}

function rowShiftDate(row) {
  return dateOnly(
    row?.shift_date ??
    row?.sale?.shift_date ??
    row?.store_shift?.shift_date ??
    row?.date_shift
  );
}

function itemRichness(group) {
  const items = Array.isArray(group?.items) ? group.items : [];
  let qty = 0;
  for (const item of items) {
    const n = Number(item?.quantity ?? item?.qty ?? item?.count ?? 0);
    if (Number.isFinite(n) && n > 0) qty += n;
  }
  return items.length * 10000 + qty;
}

function mergeSales(...lists) {
  const map = new Map();
  for (const rows of lists) {
    for (const row of rows || []) {
      const id = getSaleId(row);
      if (!id) continue;
      const old = map.get(id);
      // updated_at tende a carregar a versão mais atual da venda.
      const oldTs = Date.parse(old?.updated_at || old?.created_at || '') || 0;
      const newTs = Date.parse(row?.updated_at || row?.created_at || '') || 0;
      if (!old || newTs >= oldTs) map.set(id, row);
    }
  }
  return [...map.values()];
}

function mergeGroups(...lists) {
  const map = new Map();
  let orphan = 0;
  for (const rows of lists) {
    for (const row of rows || []) {
      const id = getSaleId(row);
      if (!id) {
        map.set(`__orphan_${orphan++}`, row);
        continue;
      }
      const old = map.get(id);
      // O mesmo id_sale pode vir nos dois filtros. Nunca somamos os dois:
      // ficamos com a versão que contém mais itens/quantidades.
      if (!old || itemRichness(row) >= itemRichness(old)) map.set(id, row);
    }
  }
  return [...map.values()];
}

export async function fetchDay(date) {
  // Estratégia V5 para operação AO VIVO:
  // 1) shift_date continua sendo a fonte oficial do turno.
  // 2) updated_at funciona como "rede de captura" para comandas abertas/alteradas
  //    que ainda não apareceram no recorte por shift_date.
  // 3) tudo é deduplicado por id_sale e filtrado novamente para o turno desejado.
  //
  // A janela de updated_at vai até o meio-dia seguinte para manter o turno noturno
  // funcionando após 00:00. Resultados de outro turno são descartados abaixo.
  const shiftStart = `${date} 00:00:00`;
  const shiftEnd   = `${date} 23:59:59`;
  const nextDate   = addDays(date, 1);
  const updateStart = `${date} 00:00:00`;
  const updateEnd   = `${nextDate} 12:00:00`;

  // Sequencial de propósito: já observamos 504/PGRST003 quando pressionamos
  // o pool da Saipos com chamadas paralelas.
  const shiftSales = await fetchAllByFilter('/search_sales','shift_date',shiftStart,shiftEnd);
  const updatedSalesRaw = await fetchAllByFilter('/search_sales','updated_at',updateStart,updateEnd);

  // Só aceitamos vendas do turno solicitado quando shift_date está disponível.
  // Se uma venda recém-aberta ainda vier sem shift_date, aceitamos somente quando
  // foi criada na data operacional pedida.
  const updatedSales = updatedSalesRaw.filter(s => {
    const sd = rowShiftDate(s);
    if (sd) return sd === date;
    return dateOnly(s?.created_at) === date;
  });

  const sales = mergeSales(shiftSales, updatedSales);
  const validSaleIds = new Set(sales.map(getSaleId).filter(Boolean));

  const shiftGroups = await fetchAllByFilter('/sales_items','shift_date',shiftStart,shiftEnd);
  const updatedGroupsRaw = await fetchAllByFilter('/sales_items','updated_at',updateStart,updateEnd);

  // Para itens, o id_sale da lista final de vendas é a autoridade. Isso evita
  // trazer item de venda antiga apenas porque ela foi editada hoje.
  const updatedGroups = updatedGroupsRaw.filter(g => validSaleIds.has(getSaleId(g)));
  const itemGroups = mergeGroups(shiftGroups, updatedGroups)
    .filter(g => {
      const id = getSaleId(g);
      return !id || validSaleIds.has(id);
    });

  return {
    sales,
    itemGroups,
    warnings:[],
    fetchMeta:{
      shiftSales: shiftSales.length,
      updatedSales: updatedSales.length,
      mergedSales: sales.length,
      shiftGroups: shiftGroups.length,
      updatedGroups: updatedGroups.length,
      mergedGroups: itemGroups.length
    }
  };
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
