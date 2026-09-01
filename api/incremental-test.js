const BASE = "https://data.saipos.io/v1";

function headers(token, mode = "raw") {
  return {
    Authorization: mode === "bearer" ? `Bearer ${token}` : token,
    Accept: "application/json"
  };
}

async function saipos(path, params = {}) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error("SAIPOS_API_TOKEN não configurado.");

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const mode = process.env.SAIPOS_AUTH_MODE || "raw";
  let r = await fetch(url, { headers: headers(token, mode) });

  if (r.status === 401 && mode === "raw") {
    r = await fetch(url, { headers: headers(token, "bearer") });
  }

  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!r.ok) {
    throw new Error(
      `Saipos ${r.status}: ${typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`
    );
  }

  return Array.isArray(body)
    ? body
    : (body?.data || body?.items || body?.results || body?.records || body?.result || []);
}

function spParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d);

  return Object.fromEntries(p.map(x => [x.type, x.value]));
}

function spTimestamp(d = new Date()) {
  const p = spParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function saleId(o) {
  return String(o?.id_sale ?? o?.sale?.id_sale ?? o?.sale_id ?? "");
}

function itemName(o) {
  return String(
    o?.desc_sale_item ??
    o?.desc_store_item ??
    o?.desc_item ??
    o?.item_name ??
    o?.name ??
    o?.product_name ??
    ""
  ).trim();
}

function qty(o) {
  const n = Number(o?.quantity ?? o?.qty ?? o?.count ?? o?.amount ?? 1);
  return Number.isFinite(n) ? n : 0;
}

function canceledItem(o) {
  return ["Y", "S", true, 1, "1"].includes(
    o?.deleted ?? o?.canceled ?? o?.cancelled ?? o?.is_canceled ?? o?.is_cancelled
  );
}

const BEERS = [
  "pilsen", "hoplager", "witbier", "bitterzinha", "ybá", "yba",
  "ipa zero", "american ipa", "textreme", "english porter",
  "maria manuela", "maria manoela", "milkshake neipa",
  "session ipa", "sunrise", "winner blond", "pilsen caju"
];

function isBeer(name) {
  const n = String(name || "").toLowerCase();
  return BEERS.some(k => n.includes(k));
}

function hourKey(createdAt) {
  const s = String(createdAt || "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T?(\d{2})/);
  return m ? `${m[1]}|${m[2]}` : null;
}

async function fetchItemsForHour(date, hour) {
  const start = `${date} ${hour}:00:00`;
  const end = `${date} ${hour}:59:59`;
  const all = [];
  let offset = 0;
  const limit = 250;

  for (let page = 0; page < 10; page++) {
    const batch = await saipos("/sales_items", {
      p_date_column_filter: "created_at",
      p_filter_date_start: start,
      p_filter_date_end: end,
      p_limit: limit,
      p_offset: offset
    });

    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

export default async function handler(req, res) {
  try {
    const minutes = 1;
    const now = new Date();
    const start = new Date(now.getTime() - minutes * 60 * 1000);

    const sales = await saipos("/search_sales", {
      p_date_column_filter: "updated_at",
      p_filter_date_start: spTimestamp(start),
      p_filter_date_end: spTimestamp(now),
      p_limit: 100,
      p_offset: 0
    });

    const activeSales = sales.filter(s => !["Y", "S", true, 1, "1"].includes(s?.canceled));
    const ids = new Set(activeSales.map(saleId).filter(Boolean));

    const hourKeys = [...new Set(activeSales.map(s => hourKey(s?.created_at)).filter(Boolean))];

    const groups = [];
    for (const key of hourKeys) {
      const [date, hour] = key.split("|");
      const hourGroups = await fetchItemsForHour(date, hour);
      groups.push(...hourGroups.filter(g => ids.has(saleId(g))));
    }

    const groupBySale = new Map(groups.map(g => [saleId(g), g]));

    const changed = activeSales.map(sale => {
      const id = saleId(sale);
      const group = groupBySale.get(id);
      const items = Array.isArray(group?.items) ? group.items : [];

      const beers = [];
      let cups = 0;

      for (const item of items) {
        if (canceledItem(item)) continue;
        const name = itemName(item);
        if (!isBeer(name)) continue;
        const q = qty(item);
        if (q <= 0) continue;
        cups += q;
        beers.push({ name, quantity: q });
      }

      return {
        id_sale: id,
        customer: String(sale?.desc_sale || "").trim() || "Não identificado",
        created_at: sale?.created_at ?? null,
        updated_at: sale?.updated_at ?? null,
        cups,
        beers
      };
    });

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      ok: true,
      test: "incremental-items",
      window: {
        start: spTimestamp(start),
        end: spTimestamp(now),
        minutes
      },
      changedSales: changed.length,
      changed
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      test: "incremental-items",
      error: e?.message || String(e)
    });
  }
}
