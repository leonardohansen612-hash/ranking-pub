import {
  saiposFetch,
  rows,
  getSaleId,
  saleCanceled,
  customerFor
} from './_saipos.js';

function spParts(date = new Date()) {
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const p = spParts(new Date());
    const date = `${p.year}-${p.month}-${p.day}`;
    const hour = p.hour;

    const start = `${date} ${hour}:00:00`;
    const end = `${date} ${hour}:59:59`;

    const body = await saiposFetch('/search_sales', {
      p_date_column_filter: 'created_at',
      p_filter_date_start: start,
      p_filter_date_end: end,
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
        id_sale_status: sale?.id_sale_status ?? null,
        desc_sale: sale?.desc_sale ?? null,
        table_order: sale?.table_order ?? null
      };
    });

    res.status(200).json({
      ok: true,
      test: 'current-hour-created-at',
      filter: 'created_at',
      window: { start, end },
      count: sales.length,
      sales
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      test: 'current-hour-created-at',
      error: String(err?.message || err)
    });
  }
}
