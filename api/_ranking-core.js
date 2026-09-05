import {
  fetchDay,
  getSaleId,
  saleCanceled,
  itemCanceled,
  getItemName,
  getQty,
  customerFor,
  isBeer
} from './_saipos.js';

export async function fetchAndAggregateDate(date) {
  const {sales,itemGroups,warnings} = await fetchDay(date);
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
  let unmatchedGroups = 0;
  let unmatchedBeerCups = 0;

  for (const group of day.itemGroups) {
    const saleId = getSaleId(group);
    const sale = saleMap.get(saleId);

    const items = Array.isArray(group?.items) ? group.items : [];

    if (!sale) {
      unmatchedGroups++;

      // Diagnóstico: conta quantos copos existem em grupos cujo id_sale não casou.
      for (const item of items) {
        if (itemCanceled(item)) continue;
        const name = getItemName(item);
        if (!isBeer(name)) continue;
        const qty = getQty(item);
        if (qty > 0) unmatchedBeerCups += qty;
      }
      continue;
    }

    const customer = customerFor(sale);

    for (const item of items) {
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
      unmatchedGroups,
      unmatchedBeerCups,
      days:1
    },
    warnings:day.warnings || []
  };
}

export async function fetchDebugDate(date) {
  const {sales,itemGroups,warnings} = await fetchDay(date);
  const saleMap = new Map(
    sales.filter(s => !saleCanceled(s))
      .map(s => [getSaleId(s), s])
      .filter(([id]) => id)
  );

  const salesDebug = sales.map(s => ({
    id_sale: getSaleId(s),
    id_sale_type: s?.id_sale_type ?? null,
    desc_sale: s?.desc_sale ?? null,
    customer_name: s?.customer?.name ?? s?.customer_name ?? s?.name_customer ?? s?.desc_customer ?? null,
    customer_id: s?.customer?.id_customer ?? s?.id_customer ?? null,
    card: s?.table_order?.id_store_order_card ?? null,
    table: s?.table_order?.id_store_table ?? null,
    ticket: s?.ticket?.number ?? null,
    resolved_customer: customerFor(s),
    canceled: saleCanceled(s)
  }));

  const groupsDebug = itemGroups.map((g, index) => {
    const id = getSaleId(g);
    const sale = saleMap.get(id);
    const items = Array.isArray(g?.items) ? g.items : [];
    return {
      index,
      id_sale: id,
      matched_sale: Boolean(sale),
      resolved_customer: sale ? customerFor(sale) : null,
      items_count: items.length,
      items: items.map(it => ({
        name: getItemName(it),
        qty: getQty(it),
        canceled: itemCanceled(it),
        isBeer: isBeer(getItemName(it)),
        raw_name_fields: {
          desc_sale_item: it?.desc_sale_item ?? null,
          desc_store_item: it?.desc_store_item ?? null,
          desc_item: it?.desc_item ?? null,
          item_name: it?.item_name ?? null,
          product_name: it?.product_name ?? null,
          name: it?.name ?? null
        },
        raw_qty_fields: {
          quantity: it?.quantity ?? null,
          qty: it?.qty ?? null,
          count: it?.count ?? null,
          quantity_item: it?.quantity_item ?? null,
          item_quantity: it?.item_quantity ?? null,
          amount: it?.amount ?? null
        }
      }))
    };
  });

  return {
    date,
    warnings,
    sales_count: sales.length,
    groups_count: itemGroups.length,
    sales: salesDebug,
    groups: groupsDebug
  };
}

export function mergeSnapshots(docs) {
  const rank = new Map();
  const stats = {
    sales:0,
    saleGroups:0,
    matchedItems:0,
    beerCups:0,
    unmatchedGroups:0,
    unmatchedBeerCups:0,
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
    stats.unmatchedGroups += Number(doc.stats?.unmatchedGroups || 0);
    stats.unmatchedBeerCups += Number(doc.stats?.unmatchedBeerCups || 0);

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
