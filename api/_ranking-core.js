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


function previousDate(date) {
  const [y,m,d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0,10);
}

function saoPauloHour() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo',
    hour:'2-digit',
    hour12:false
  }).formatToParts(new Date());

  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  return hour === 24 ? 0 : hour;
}

function saleUpdatedOnDate(sale, date) {
  const raw = String(
    sale?.updated_at ??
    sale?.updatedAt ??
    sale?.date_updated ??
    ''
  );
  return raw.startsWith(date);
}

async function fetchHoursForDate(date, hours, concurrency, warnings, label='') {
  return mapLimit(hours, concurrency, async hour => {
    let lastError = null;

    for (let attempt=1; attempt<=3; attempt++) {
      try {
        const sales = await fetchHour('/search_sales', date, hour);
        const itemGroups = await fetchHour('/sales_items', date, hour);
        return {hour,sales,itemGroups};
      } catch(e) {
        lastError = e;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 800));
        }
      }
    }

    warnings.push(
      `${label}${date} ${String(hour).padStart(2,'0')}h: ${lastError?.message || 'Falha Saipos'}`
    );
    return {hour,sales:[],itemGroups:[]};
  });
}

export async function fetchAndAggregateDate(date) {
  const {start,end} = hourWindow();
  const hours=[];
  for(let h=start; h<=end; h++) hours.push(h);

  const concurrency = Math.max(
    1,
    Math.min(4, Number(process.env.SAIPOS_CONCURRENCY || 2))
  );

  const warnings=[];

  // Fluxo normal: vendas criadas na data consultada.
  const chunks = await fetchHoursForDate(
    date,
    hours,
    concurrency,
    warnings
  );

  const sales=[];
  const itemGroups=[];

  for(const c of chunks) {
    sales.push(...c.sales);
    itemGroups.push(...c.itemGroups);
  }

  /*
   * VIRADA DA MEIA-NOITE
   *
   * Até o horário de corte, também olhamos algumas horas do dia anterior.
   * Porém só carregamos vendas cujo updated_at já pertence ao dia atual.
   *
   * Isso resolve a situação de uma comanda aberta antes da meia-noite que
   * continua recebendo lançamentos depois da meia-noite, sem depender de
   * pesquisar a Saipos diretamente por updated_at (consulta que se mostrou
   * muito instável).
   *
   * Depois do corte, o DIA volta a considerar somente vendas criadas hoje.
   * Assim a comanda da noite anterior não permanece no ranking durante o
   * restante do novo dia.
   */
  const carryoverCutoff = Math.max(
    0,
    Math.min(12, Number(process.env.SAIPOS_CARRYOVER_CUTOFF_HOUR || 6))
  );

  const carryoverStart = Math.max(
    0,
    Math.min(23, Number(process.env.SAIPOS_CARRYOVER_START_HOUR || 20))
  );

  const isRealToday = date === saoPauloToday();
  const inCarryoverWindow = saoPauloHour() < carryoverCutoff;

  if (isRealToday && inCarryoverWindow) {
    const prev = previousDate(date);
    const prevHours=[];
    for(let h=carryoverStart; h<=23; h++) prevHours.push(h);

    const prevChunks = await fetchHoursForDate(
      prev,
      prevHours,
      concurrency,
      warnings,
      'virada '
    );

    const carrySales = [];
    const carryIds = new Set();

    for(const c of prevChunks) {
      for(const sale of c.sales) {
        const id = getSaleId(sale);
        if (!id || saleCanceled(sale)) continue;
        if (!saleUpdatedOnDate(sale, date)) continue;

        carrySales.push(sale);
        carryIds.add(id);
      }
    }

    if (carryIds.size) {
      const seenSales = new Set(sales.map(getSaleId).filter(Boolean));
      const seenGroups = new Set(itemGroups.map(getSaleId).filter(Boolean));

      for(const sale of carrySales) {
        const id = getSaleId(sale);
        if (!seenSales.has(id)) {
          sales.push(sale);
          seenSales.add(id);
        }
      }

      for(const c of prevChunks) {
        for(const group of c.itemGroups) {
          const id = getSaleId(group);
          if (!id || !carryIds.has(id) || seenGroups.has(id)) continue;
          itemGroups.push(group);
          seenGroups.add(id);
        }
      }
    }
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
