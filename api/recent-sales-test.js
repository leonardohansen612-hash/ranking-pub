import {
  saiposFetch,
  rows,
  getSaleId,
  saleCanceled,
  customerFor
} from './_saipos.js';

function partsInSaoPaulo(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function localIsoLike(date) {
  const p = partsInSaoPaulo(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const minutes = Math.max(15, Math.min(240, Number(req.query.minutes || 120)));

    const now = new Date();
    const start = new Date(now.getTime() - minutes * 60 * 1000);

    const startStr = localIsoLike(start);
    const endStr = localIsoLike(now);

    const body = await saiposFetch('/search_sales', {
      p_date_column_filter: 'created_at',
      p_filter_date_start: startStr,
      p_filter_date_end: endStr,
      p_limit: 250,
      p_offset: 0
    });

    const found = rows(body);

    const sales = found.map(sale => {
      const customer = customerFor(sale);
      return {
        id_sale: getSaleId(sale),
        name: customer.name,
        canceled: saleCanceled(sale),
        id_sale_type: sale?.id_sale_type ?? null,
        created_at: sale?.created_at ?? null,
        updated_at: sale?.updated_at ?? null,
        shift_date: sale?.shift_date ?? null,
        sale_status: sale?.id_sale_status ?? sale?.sale_status ?? null,
        table_order: sale?.table_order ?? null
      };
    });

    res.status(200).json({
      ok: true,
      test: 'recent-sales-created-at',
      window: {
        minutes,
        start: startStr,
        end: endStr
      },
      count: sales.length,
      sales
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      test: 'recent-sales-created-at',
      error: String(err?.message || err)
    });
  }
}
