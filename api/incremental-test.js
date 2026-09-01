const BASE = "https://data.saipos.io/v1";

function headers(token, mode = "raw") {
  return {
    Authorization: mode === "bearer" ? `Bearer ${token}` : token,
    Accept: "application/json"
  };
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function saipos(path, params = {}, { retries = 3, timeoutMs = 45000 } = {}) {
  const token = process.env.SAIPOS_API_TOKEN;
  if (!token) throw new Error("SAIPOS_API_TOKEN não configurado.");

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const mode = process.env.SAIPOS_AUTH_MODE || "raw";
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let r = await fetch(url, {
        headers: headers(token, mode),
        signal: controller.signal
      });

      if (r.status === 401 && mode === "raw") {
        r = await fetch(url, {
          headers: headers(token, "bearer"),
          signal: controller.signal
        });
      }

      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }

      if (r.ok) {
        return Array.isArray(body)
          ? body
          : (body?.data || body?.items || body?.results || body?.records || body?.result || []);
      }

      const msg = `Saipos ${r.status}: ${
        typeof body === "string"
          ? body.slice(0, 500)
          : JSON.stringify(body).slice(0, 500)
      }`;

      const retryable =
        r.status === 504 ||
        body?.code === "PGRST003" ||
        /Timed out|timeout/i.test(msg);

      if (retryable && attempt < retries) {
        lastError = new Error(msg);
        await wait(1200 * attempt);
        continue;
      }

      throw new Error(msg);
    } catch (e) {
      lastError = e;

      const retryable =
        e?.name === "AbortError" ||
        /504|PGRST003|Timed out|timeout/i.test(String(e?.message || e));

      if (retryable && attempt < retries) {
        await wait(1200 * attempt);
        continue;
      }

      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Falha ao consultar Saipos.");
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

function parseCreatedAt(createdAt) {
  const m = String(createdAt || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/
  );
  if (!m) return null;

  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6])
  };
}

function localTimestampFromParts(parts, deltaMinutes = 0) {
  // Usa UTC apenas como calculadora de calendário, mantendo os números locais.
  const dt = new Date(Date.UTC(
    parts.y, parts.mo - 1, parts.d, parts.h, parts.mi + deltaMinutes, parts.s
  ));

  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ` +
         `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

async function fetchItemsForSale(createdAt) {
  const parts = parseCreatedAt(createdAt);
  if (!parts) return [];

  // Janela curta: 2 min antes a 8 min depois da criação.
  const start = localTimestampFromParts(parts, -2);
  const end = localTimestampFromParts(parts, 8);

  return saipos("/sales_items", {
    p_date_column_filter: "created_at",
    p_filter_date_start: start,
    p_filter_date_end: end,
    p_limit: 300,
    p_offset: 0
  }, { retries: 3, timeoutMs: 45000 });
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
    }, { retries: 3, timeoutMs: 45000 });

    const activeSales = sales.filter(
      s => !["Y", "S", true, 1, "1"].includes(s?.canceled)
    );

    const changed = [];

    for (const sale of activeSales) {
      const sid = saleId(sale);
      const groups = await fetchItemsForSale(sale?.created_at);

      const group = groups.find(g => saleId(g) === sid);
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

      changed.push({
        id_sale: sid,
        customer: String(sale?.desc_sale || "").trim() || "Não identificado",
        created_at: sale?.created_at ?? null,
        updated_at: sale?.updated_at ?? null,
        cups,
        beers
      });
    }

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      ok: true,
      test: "incremental-items-v4",
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
      test: "incremental-items-v4",
      error: e?.message || String(e)
    });
  }
}
