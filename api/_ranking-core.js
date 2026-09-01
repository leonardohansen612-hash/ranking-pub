import {
  fetchHour,
  getSaleId,
  saleCanceled,
  itemCanceled,
  getItemName,
  getQty,
  customerFor,
  isBeer,
  hourWindow
} from './_saipos.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mapLimit(values, limit, worker) {
  const out = new Array(values.length);
  let next = 0;

  async function run() {
    while (true) {
      const i = next++;
      if (i >= values.length) return;
      out[i] = await worker(values[i], i);
    }
  }

  await Promise.all(
    Array.from({length: Math.min(limit, values.length)}, () => run())
  );
  return out;
}

function saoPauloParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo',
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
    hour:'2-digit',
    hourCycle:'h23'
  }).formatToParts(new Date());

  return Object.fromEntries(parts.map(p => [p.type,p.value]));
}

function addDays(dateStr, amount) {
  const [y,m,d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + amount));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

/**
 * Monta as faixas horárias consultadas na Saipos.
 *
 * Regra:
 * - mantém a janela local que já funcionava;
 * - para o dia atual, adiciona até 3 horas de "lookahead";
 * - se o lookahead passar de 23h, consulta 00h/01h/02h do dia seguinte.
 *
 * Motivo:
 * A API recebe created_at como data/hora sem timezone explícito. Se os dados
 * estiverem sendo indexados em UTC, uma comanda criada às 16h em São Paulo
 * pode cair na faixa 19h da API. Sem o lookahead ela só seria encontrada
 * horas depois.
 *
 * Essa abordagem cobre tanto o comportamento local quanto UTC sem voltar
 * a consultar 24 horas por atualização.
 */
function buildSlots(date, configured, realToday, nowHour) {
  if (date > realToday) return [];

  const slots = [];

  if (date < realToday) {
    for (let h=configured.start; h<=configured.end; h++) {
      slots.push({date, hour:h});
    }
    return slots;
  }

  // Dia atual: janela normal até a hora local atual.
  const localEnd = Math.min(configured.end, nowHour);
  for (let h=configured.start; h<=localEnd; h++) {
    slots.push({date, hour:h});
  }

  // Folga de até 3h para cobrir possível created_at em UTC.
  const lookaheadHours = 3;
  for (let offset=1; offset<=lookaheadHours; offset++) {
    const rawHour = nowHour + offset;

    if (rawHour <= 23) {
      // Só adiciona se ainda não estiver na janela local normal.
      if (rawHour > localEnd) {
        slots.push({date, hour:rawHour});
      }
    } else {
      const nextDate = addDays(date, 1);
      slots.push({date:nextDate, hour:rawHour - 24});
    }
  }

  return slots;
}

export async function fetchAndAggregateDate(date) {
  // Regra oficial: a comanda pertence ao dia em que foi aberta (created_at).
  const configured = hourWindow();
  const now = saoPauloParts();
  const realToday = `${now.year}-${now.month}-${now.day}`;
  const nowHour = Number(now.hour);

  const slots = buildSlots(date, configured, realToday, nowHour);

  if (!slots.length) {
    return aggregate({
      date,
      sales:[],
      itemGroups:[],
      warnings:[]
    });
  }

  const concurrency = Math.max(
    1,
    Math.min(2, Number(process.env.SAIPOS_CONCURRENCY || 1))
  );

  const warnings=[];

  const chunks = await mapLimit(slots, concurrency, async slot => {
    let lastError = null;

    for (let attempt=1; attempt<=2; attempt++) {
      try {
        const sales = await fetchHour('/search_sales', slot.date, slot.hour);

        await sleep(250);

        const itemGroups = await fetchHour('/sales_items', slot.date, slot.hour);

        return {slot,sales,itemGroups};
      } catch(e) {
        lastError = e;
        if (attempt < 2) await sleep(1200);
      }
    }

    warnings.push(
      `${slot.date} ${String(slot.hour).padStart(2,'0')}h: ${lastError?.message || 'Falha Saipos'}`
    );

    return {slot,sales:[],itemGroups:[]};
  });

  const sales=[];
  const itemGroups=[];

  for(const c of chunks) {
    sales.push(...c.sales);
    itemGroups.push(...c.itemGroups);
  }

  return aggregate({date,sales,itemGroups,warnings});
}

function aggregate(day) {
  const saleMap = new Map(
    day.sales
      .filter(s => !saleCanceled(s))
      .map(s => [getSaleId(s), s])
      .filter(([id]) => id)
  );

  const rank = new Map();
  let matchedItems = 0;
  let beerCups = 0;

  for(const group of day.itemGroups) {
    const saleId = getSaleId(group);
    const sale = saleMap.get(saleId);
    if (!sale) continue;

    const customer = customerFor(sale);
    const items = Array.isArray(group?.items) ? group.items : [];

    for(const item of items) {
      if (itemCanceled(item)) continue;

      const name = getItemName(item);
      if (!isBeer(name)) continue;

      const qty = getQty(item);
      if (qty <= 0) continue;

      matchedItems++;
      beerCups += qty;

      const cur = rank.get(customer.key) || {
        key: customer.key,
        name: customer.name,
        cups: 0,
        beers: {}
      };

      cur.cups += qty;
      cur.beers[name] = (cur.beers[name] || 0) + qty;
      rank.set(customer.key, cur);
    }
  }

  return {
    date: day.date,
    ranking:[...rank.values()]
      .sort((a,b)=>b.cups-a.cups || a.name.localeCompare(b.name,'pt-BR')),
    stats:{
      sales:day.sales.length,
      saleGroups:day.itemGroups.length,
      matchedItems,
      beerCups,
      days:1
    },
    warnings:day.warnings || []
  };
}

export function mergeSnapshots(docs) {
  const rank = new Map();
  const stats = {
    sales:0,
    saleGroups:0,
    matchedItems:0,
    beerCups:0,
    days:0
  };

  const warnings=[];

  for(const doc of docs) {
    if (!Array.isArray(doc.ranking)) continue;

    stats.days += 1;
    stats.sales += Number(doc.stats?.sales || 0);
    stats.saleGroups += Number(doc.stats?.saleGroups || 0);
    stats.matchedItems += Number(doc.stats?.matchedItems || 0);
    stats.beerCups += Number(doc.stats?.beerCups || 0);

    for(const w of (doc.warnings || [])) {
      if (warnings.length < 20) warnings.push(w);
    }

    for(const person of doc.ranking) {
      if (!person?.key) continue;

      const cur = rank.get(person.key) || {
        key:person.key,
        name:person.name,
        cups:0,
        beers:{}
      };

      cur.cups += Number(person.cups || 0);

      for(const [beer,qty] of Object.entries(person.beers || {})) {
        cur.beers[beer] = (cur.beers[beer] || 0) + Number(qty || 0);
      }

      rank.set(person.key,cur);
    }
  }

  return {
    ranking:[...rank.values()]
      .sort((a,b)=>b.cups-a.cups || a.name.localeCompare(b.name,'pt-BR')),
    stats,
    warnings
  };
}

export function saoPauloToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo',
    year:'numeric',
    month:'2-digit',
    day:'2-digit'
  }).formatToParts(new Date());

  const obj = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}
