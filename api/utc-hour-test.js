import { fetchHour } from './_saipos.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  const date = String(req.query.date || '2026-09-01');
  const name = String(req.query.name || 'Tio Zé');
  const wanted = name.trim().toLowerCase();

  const results = [];
  const matches = [];

  // Reproduz a cobertura ampla que funcionava antes:
  // todas as 24 horas do dia + 0,1,2,3 do dia seguinte.
  const slots = [];
  for (let hour = 0; hour <= 23; hour++) {
    slots.push({ date, hour });
  }

  // calcula dia seguinte
  const [y,m,d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDate = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;

  for (let hour = 0; hour <= 3; hour++) {
    slots.push({ date: nextDate, hour });
  }

  for (const slot of slots) {
    try {
      const sales = await fetchHour('/search_sales', slot.date, slot.hour);
      const viewed = sales.map(saleView);

      const hit = viewed.filter(s => {
        const desc = String(s.desc_sale || '').trim().toLowerCase();
        return wanted && desc.includes(wanted);
      });

      results.push({
        date: slot.date,
        hour: slot.hour,
        count: sales.length,
        matches: hit
      });

      for (const sale of hit) {
        matches.push({
          slotDate: slot.date,
          slotHour: slot.hour,
          ...sale
        });
      }
    } catch (e) {
      results.push({
        date: slot.date,
        hour: slot.hour,
        error: e.message
      });
    }

    // reduz pressão na API
    await sleep(700);
  }

  return res.status(200).json({
    ok: true,
    target: { date, name },
    note: 'Diagnóstico somente leitura. Varre 00-23 do dia informado e 00-03 do dia seguinte via created_at.',
    matches,
    summary: {
      slotsChecked: slots.length,
      slotsWithErrors: results.filter(r => r.error).length,
      totalMatches: matches.length
    },
    results
  });
}
