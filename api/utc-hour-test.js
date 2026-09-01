import { saiposFetch, rows } from './_saipos.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function saoPauloParts() {
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

async function queryUpdatedWindow(centerDate, centerTime, offsetMinutes) {
  const center = addMinutes(centerDate, centerTime, offsetMinutes);
  const start = addMinutes(center.date, center.time, -10);
  const end = addMinutes(center.date, center.time, 10);

  let lastError = null;

  for (let attempt=1; attempt<=2; attempt++) {
    try {
      const body = await saiposFetch('/search_sales', {
        p_date_column_filter: 'updated_at',
        p_filter_date_start: stamp(start, '00'),
        p_filter_date_end: stamp(end, '59'),
        p_limit: 100,
        p_offset: 0
      });

      const sales = rows(body);

      return {
        offsetMinutes,
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
    offsetMinutes,
    range: {
      start: stamp(start, '00'),
      end: stamp(end, '59')
    },
    error: lastError?.message || 'Falha Saipos'
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const now = saoPauloParts();
    const nowDate = `${now.year}-${now.month}-${now.day}`;
    const nowTime = `${now.hour}:${now.minute}`;

    const name = String(req.query.name || 'Tio Zé');
    const wanted = name.trim().toLowerCase();

    // Procura updates recentes em janelas próximas de agora.
    // Testamos o relógio local e possíveis deslocamentos de +1h/+2h/+3h.
    const offsets = [0, 60, 120, 180];

    const results = [];
    for (const offset of offsets) {
      const result = await queryUpdatedWindow(nowDate, nowTime, offset);
      results.push(result);
      await sleep(500);
    }

    const matches = [];

    for (const result of results) {
      for (const sale of (result.sales || [])) {
        const desc = String(sale.desc_sale || '').trim().toLowerCase();
        if (wanted && desc.includes(wanted)) {
          matches.push({
            offsetMinutes: result.offsetMinutes,
            ...sale
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      saoPauloNow: `${nowDate} ${nowTime}`,
      targetName: name,
      column: 'updated_at',
      note: 'Diagnóstico somente leitura. Busca vendas atualizadas recentemente, sem alterar ranking ou Firebase.',
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
