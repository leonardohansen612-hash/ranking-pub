import { fetchHour } from './_saipos.js';

function saoPauloNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function addDays(dateStr, amount) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + amount));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

function slotFrom(date, hour) {
  if (hour <= 23) return { date, hour };
  return { date: addDays(date, 1), hour: hour - 24 };
}

function saleView(s) {
  return {
    id_sale: s?.id_sale ?? null,
    desc_sale: s?.desc_sale ?? null,
    created_at: s?.created_at ?? null,
    updated_at: s?.updated_at ?? null,
    canceled: s?.canceled ?? null,
    status: s?.table_order?.id_table_order_status ?? null
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const now = saoPauloNowParts();
    const date = `${now.year}-${now.month}-${now.day}`;
    const h = Number(now.hour);

    // Hora local anterior + hora atual + 4 horas à frente.
    const rawHours = [h - 1, h, h + 1, h + 2, h + 3, h + 4]
      .filter(x => x >= 0);

    const slots = rawHours.map(x => slotFrom(date, x));
    const results = [];

    for (const slot of slots) {
      try {
        const sales = await fetchHour('/search_sales', slot.date, slot.hour);

        results.push({
          date: slot.date,
          hour: slot.hour,
          count: sales.length,
          sales: sales.map(saleView)
        });
      } catch (e) {
        results.push({
          date: slot.date,
          hour: slot.hour,
          error: e.message
        });
      }
    }

    return res.status(200).json({
      ok: true,
      saoPauloNow: `${date} ${now.hour}:${now.minute}`,
      note: 'Diagnóstico somente leitura. Consulta created_at por hora e não grava nada.',
      results
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
