import {
  saiposFetch,
  rows,
  getSaleId,
  saleCanceled,
  itemCanceled,
  getItemName,
  getQty,
  customerFor,
  isBeer,
  saoPauloToday
} from './_saipos.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPaged(path, date) {
  const out = [];
  const limit = 250;
  let offset = 0;

  for (let page = 0; page < 20; page++) {
    let body;
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        body = await saiposFetch(path, {
          p_date_column_filter: 'shift_date',
          p_filter_date_start: `${date} 00:00:00`,
          p_filter_date_end: `${date} 23:59:59`,
          p_limit: limit,
          p_offset: offset
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(700 * attempt);
      }
    }

    if (lastError) throw lastError;

    const batch = rows(body);
    out.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  return out;
}

function flattenItemGroups(groups) {
  const out = [];

  for (const group of groups) {
    const saleId = getSaleId(group);
    const items = Array.isArray(group?.items) ? group.items : [];

    for (const item of items) {
      out.push({
        saleId,
        item
      });
    }
  }

  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const date = String(req.query.date || saoPauloToday());

    const [salesRaw, itemGroupsRaw] = await Promise.all([
      fetchPaged('/search_sales', date),
      fetchPaged('/sales_items', date)
    ]);

    const sales = salesRaw.filter(s => !saleCanceled(s));
    const flatItems = flattenItemGroups(itemGroupsRaw);

    const itemsBySale = new Map();
    for (const row of flatItems) {
      if (!row.saleId || itemCanceled(row.item)) continue;
      if (!itemsBySale.has(row.saleId)) itemsBySale.set(row.saleId, []);
      itemsBySale.get(row.saleId).push(row.item);
    }

    const details = sales.map(sale => {
      const id = getSaleId(sale);
      const customer = customerFor(sale);
      const saleItems = itemsBySale.get(id) || [];

      const beers = [];
      let beerCups = 0;

      for (const item of saleItems) {
        const name = getItemName(item);
        const qty = getQty(item);

        if (isBeer(name)) {
          beers.push({ name, qty });
          beerCups += qty;
        }
      }

      return {
        id_sale: id,
        name: customer.name,
        id_sale_type: sale?.id_sale_type ?? null,
        created_at: sale?.created_at ?? null,
        updated_at: sale?.updated_at ?? null,
        shift_date: sale?.shift_date ?? null,
        table_status: sale?.table_order?.id_table_order_status ?? null,
        total_items_found: saleItems.length,
        beer_cups: beerCups,
        beers
      };
    });

    const withBeer = details
      .filter(x => x.beer_cups > 0)
      .sort((a, b) => b.beer_cups - a.beer_cups);

    res.status(200).json({
      ok: true,
      test: 'shift-date',
      date,
      filter: 'shift_date',
      salesFound: sales.length,
      itemGroupsFound: itemGroupsRaw.length,
      salesWithBeer: withBeer.length,
      beerCups: withBeer.reduce((sum, x) => sum + x.beer_cups, 0),
      sales: details
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      test: 'shift-date',
      error: String(err?.message || err)
    });
  }
}
