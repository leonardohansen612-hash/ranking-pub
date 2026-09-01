export default async function handler(req, res) {
  try {
    const token = process.env.SAIPOS_API_TOKEN;

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "SAIPOS_API_TOKEN não configurado na Vercel"
      });
    }

    const now = new Date();
    const minutes = Math.max(1, Math.min(60, Number(req.query.minutes || 10)));
    const start = new Date(now.getTime() - minutes * 60 * 1000);

    // A Saipos trabalha com horário local de São Paulo nesses filtros.
    const fmt = (d) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).formatToParts(d);

      const get = (type) => parts.find((p) => p.type === type)?.value;
      return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
    };

    const params = new URLSearchParams({
      p_date_column_filter: "updated_at",
      p_filter_date_start: fmt(start),
      p_filter_date_end: fmt(now),
      p_limit: "300",
      p_offset: "0"
    });

    const url = `https://data.saipos.io/v1/search_sales?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: token,
        accept: "application/json"
      }
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        status: response.status,
        window: {
          start: fmt(start),
          end: fmt(now),
          minutes
        },
        saipos: data
      });
    }

    const sales = Array.isArray(data) ? data : [];

    return res.status(200).json({
      ok: true,
      filter: "updated_at",
      window: {
        start: fmt(start),
        end: fmt(now),
        minutes
      },
      count: sales.length,
      sales: sales.map((sale) => ({
        id_sale: sale.id_sale ?? null,
        desc_sale: sale.desc_sale ?? null,
        created_at: sale.created_at ?? null,
        updated_at: sale.updated_at ?? null,
        shift_date: sale.shift_date ?? null,
        canceled: sale.canceled ?? null
      }))
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
}
