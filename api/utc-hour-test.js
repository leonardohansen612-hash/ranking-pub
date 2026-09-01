import { saiposFetch, rows } from './_saipos.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pad(n){ return String(n).padStart(2,'0'); }

function addMinutes(date, time, deltaMinutes) {
  const [y,m,d] = date.split('-').map(Number);
  const [hh,mm] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm + deltaMinutes, 0));

  return {
    date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`,
    time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`
  };
}

function stamp(x, seconds='00') {
  return `${x.date} ${x.time}:${seconds}`;
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

async function queryWindow(date, time, offsetHours) {
  const center = addMinutes(date, time, offsetHours * 60);
  const start = addMinutes(center.date, center.time, -5);
  const end = addMinutes(center.date, center.time, 5);

  let lastError = null;

  for (let attempt=1; attempt<=2; attempt++) {
    try {
      const body = await saiposFetch('/search_sales', {
        p_date_column_filter: 'created_at',
        p_filter_date_start: stamp(start, '00'),
        p_filter_date_end: stamp(end, '59'),
        p_limit: 100,
        p_offset: 0
      });

      const sales = rows(body);

      return {
        offsetHours,
        range: {
          start: stamp(start, '00'),
          end: stamp(end, '59')
        },
        count: sales.length,
        sales: sales.map(saleView)
      };
    } catch (e) {
      lastError = e;
      if (attempt < 2) await sleep(1200);
    }
  }

  return {
    offsetHours,
    range: {
      start: stamp(start, '00'),
      end: stamp(end, '59')
    },
    error: lastError?.message || 'Falha Saipos'
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const date = String(req.query.date || '2026-09-01');
  const time = String(req.query.time || '16:09');
  const name = String(req.query.name || 'Tio Zé');

  try {
    const results = [];

    // Testa exatamente o horário informado e +1h, +2h, +3h, +4h.
    // São janelas de apenas 10 minutos para reduzir muito a carga da consulta.
    for (const offset of [0,1,2,3,4]) {
      const result = await queryWindow(date, time, offset);
      results.push(result);
      await sleep(500);
    }

    const matches = [];
    const wanted = name.trim().toLowerCase();

    for (const result of results) {
      for (const sale of (result.sales || [])) {
        const desc = String(sale.desc_sale || '').trim().toLowerCase();
        if (wanted && desc.includes(wanted)) {
          matches.push({
            offsetHours: result.offsetHours,
            ...sale
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      target: { date, time, name },
      note: 'Diagnóstico somente leitura. Janelas de ±5 minutos em created_at.',
      matches,
      results
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
