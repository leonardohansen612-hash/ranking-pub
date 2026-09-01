import {
  saiposFetch,
  rows,
  getSaleId,
  saleCanceled,
  customerFor
} from './_saipos.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const now = new Date();

    // Teste proposital usando a hora UTC atual.
    // São Paulo está em UTC-3, então por volta de 14h local este teste consulta 17h.
    const y = now.getUTCFullYear();
    const m = pad(now.getUTCMonth() + 1);
    const d = pad(now.getUTCDate());
    const h = pad(now.getUTCHours());

    const date = `${y}-${m}-${d}`;
    const start = `${date} ${h}:00:00`;
    const end = `${date} ${h}:59:59`;

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
      test: 'utc-current-hour-created-at',
      filter: 'created_at',
      window: { start, end },
      count: sales.length,
      sales
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      test: 'utc-current-hour-created-at',
      error: String(err?.message || err)
    });
  }
}
