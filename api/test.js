import { saiposFetch, rows } from './_saipos.js';

function pad(n){ return String(n).padStart(2,'0'); }
function validDate(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v||'')); }

function customerName(sale){
  const name = String(sale?.customer?.name || '').trim();
  if(name) return name;
  const desc = String(sale?.desc_sale || '').trim();
  if(desc) return desc;
  return null;
}

function compactItems(wrapper){
  return (Array.isArray(wrapper?.items) ? wrapper.items : []).map(it => ({
    id_sale_item: it.id_sale_item ?? null,
    name: it.desc_sale_item ?? it.desc_store_item ?? null,
    quantity: Number(it.quantity ?? 0),
    unit_price: it.unit_price ?? null,
    deleted: it.deleted ?? null,
    status: it.status ?? null
  }));
}

export default async function handler(req,res){
  if(!process.env.SETUP_KEY || req.query.key !== process.env.SETUP_KEY){
    return res.status(403).json({ok:false,error:'SETUP_KEY inválida'});
  }

  const date = String(req.query.date || '');
  if(!validDate(date)){
    return res.status(400).json({ok:false,error:'Use date=YYYY-MM-DD'});
  }

  const hour = Math.max(0, Math.min(23, Number(req.query.hour ?? 20)));
  const hh = pad(hour);
  const start = `${date} ${hh}:00:00`;
  const end = `${date} ${hh}:59:59`;

  const params = {
    p_date_column_filter: 'created_at',
    p_filter_date_start: start,
    p_filter_date_end: end,
    p_limit: 5,
    p_offset: 0
  };

  try{
    const t0 = Date.now();
    const salesBody = await saiposFetch('/search_sales', params);
    const sales = rows(salesBody);

    const itemsBody = await saiposFetch('/sales_items', params);
    const itemGroups = rows(itemsBody);

    const itemsBySale = new Map(
      itemGroups.map(g => [String(g.id_sale ?? ''), compactItems(g)])
    );

    const joined = sales.map(s => ({
      id_sale: s.id_sale ?? null,
      customer: s.customer ?? null,
      customer_name: customerName(s),
      desc_sale: s.desc_sale ?? null,
      canceled: s.canceled ?? s.cancelled ?? null,
      opened_at: s.opened_at ?? null,
      closed_at: s.closed_at ?? null,
      table_order: s.table_order ?? null,
      items: itemsBySale.get(String(s.id_sale ?? '')) || []
    }));

    return res.status(200).json({
      ok:true,
      diagnostic:'join-sales-items',
      date,
      hour,
      start,
      end,
      elapsedMs: Date.now()-t0,
      salesCount:sales.length,
      itemGroupsCount:itemGroups.length,
      joined
    });
  }catch(e){
    return res.status(500).json({
      ok:false,
      diagnostic:'join-sales-items',
      date,
      hour,
      start,
      end,
      error:e.message
    });
  }
}
