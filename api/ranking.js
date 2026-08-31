import {
  fetchHour,
  getSaleId,
  saleCanceled,
  itemCanceled,
  getItemName,
  getQty,
  customerFor,
  isBeer,
  hourWindow,
  saoPauloToday,
  monthDatesThrough
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

async function fetchDate(date) {
  const {start,end} = hourWindow();
  const hours=[];
  for(let h=start; h<=end; h++) hours.push(h);

  const concurrency = Math.max(1, Math.min(8, Number(process.env.SAIPOS_CONCURRENCY || 3)));
  const warnings=[];

  const chunks = await mapLimit(hours, concurrency, async hour => {
    try {
      // Sequencial por hora para não pressionar o pool da Saipos.
      const sales = await fetchHour('/search_sales', date, hour);
      const itemGroups = await fetchHour('/sales_items', date, hour);
      return {hour,sales,itemGroups};
    } catch(e) {
      warnings.push(`${date} ${String(hour).padStart(2,'0')}h: ${e.message}`);
      return {hour,sales:[],itemGroups:[]};
    }
  });

  const sales=[];
  const itemGroups=[];
  for(const c of chunks) {
    sales.push(...c.sales);
    itemGroups.push(...c.itemGroups);
  }

  return {date,sales,itemGroups,warnings};
}

function aggregateDay(day) {
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
    ranking:[...rank.values()],
    stats:{
      sales:day.sales.length,
      saleGroups:day.itemGroups.length,
      matchedItems,
      beerCups
    }
  };
}

function mergeRankings(days) {
  const rank = new Map();
  const stats = {sales:0,saleGroups:0,matchedItems:0,beerCups:0,days:days.length};

  for(const day of days) {
    stats.sales += day.stats.sales;
    stats.saleGroups += day.stats.saleGroups;
    stats.matchedItems += day.stats.matchedItems;
    stats.beerCups += day.stats.beerCups;

    for(const person of day.ranking) {
      const cur = rank.get(person.key) || {
        key:person.key,
        name:person.name,
        cups:0,
        beers:{}
      };
      cur.cups += person.cups;
      for(const [beer,qty] of Object.entries(person.beers || {})) {
        cur.beers[beer] = (cur.beers[beer] || 0) + qty;
      }
      rank.set(person.key,cur);
    }
  }

  return {
    ranking:[...rank.values()]
      .sort((a,b)=>b.cups-a.cups || a.name.localeCompare(b.name,'pt-BR')),
    stats
  };
}

export default async function handler(req,res) {
  try {
    const period = req.query.period === 'month' ? 'month' : 'today';
    const today = saoPauloToday();

    // date=YYYY-MM-DD é útil para conferência manual e histórico.
    const forcedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? String(req.query.date)
      : null;

    const dates = forcedDate
      ? [forcedDate]
      : period === 'month'
        ? monthDatesThrough(today)
        : [today];

    const dateConcurrency = period === 'month' ? 2 : 1;
    const fetched = await mapLimit(dates, dateConcurrency, fetchDate);

    const warnings = fetched.flatMap(x=>x.warnings);
    const aggregatedDays = fetched.map(day => {
      const agg = aggregateDay(day);
      return {date:day.date, ...agg};
    });

    const merged = mergeRankings(aggregatedDays);

    res.setHeader('Cache-Control', period === 'month'
      ? 's-maxage=300, stale-while-revalidate=900'
      : 's-maxage=20, stale-while-revalidate=60'
    );

    res.status(200).json({
      ok:true,
      period,
      date:forcedDate || undefined,
      updatedAt:new Date().toISOString(),
      ranking:merged.ranking,
      stats:merged.stats,
      warnings:warnings.slice(0,20)
    });
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
}
