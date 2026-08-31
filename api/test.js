import { saiposFetch, rows, getItemName, getSaleId } from './_saipos.js';

function pad(n){ return String(n).padStart(2,'0'); }
function fmt(d){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function chunksForDays(days){
  const end = new Date();
  end.setHours(23,59,59,999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0,0,0,0);
  const chunks=[];
  let a = start;
  while(a < end){
    const b = new Date(Math.min(end.getTime(), a.getTime() + 14*24*60*60*1000));
    chunks.push([fmt(a), fmt(b)]);
    a = new Date(b.getTime() + 1000);
  }
  return chunks;
}
function shape(body){
  return {
    type: Array.isArray(body) ? 'array' : typeof body,
    topLevelKeys: body && !Array.isArray(body) && typeof body === 'object' ? Object.keys(body) : [],
    rowCountOnFirstPage: rows(body).length
  };
}
function safeSale(s){
  if(!s) return null;
  return {
    id_sale: s.id_sale,
    id_store: s.id_store,
    id_sale_type: s.id_sale_type,
    created_at: s.created_at,
    updated_at: s.updated_at,
    shift_date: s.shift_date,
    canceled: s.canceled,
    desc_sale: s.desc_sale,
    customer: s.customer ? { id_customer:s.customer.id_customer, name:s.customer.name } : null,
    table_order: s.table_order ? {
      id_store_table:s.table_order.id_store_table,
      id_store_order_card:s.table_order.id_store_order_card,
      id_table_order_status:s.table_order.id_table_order_status
    } : null,
    keys: Object.keys(s)
  };
}
function safeItem(it){
  if(!it) return null;
  return {
    id_sale: getSaleId(it),
    detected_name: getItemName(it),
    quantity: it.quantity ?? it.qty ?? it.count ?? it.quantity_item ?? it.item_quantity ?? it.amount,
    canceled: it.canceled ?? it.cancelled ?? it.is_canceled ?? it.is_cancelled,
    keys: Object.keys(it)
  };
}

export default async function handler(req,res){
  if(!process.env.SETUP_KEY || req.query.key !== process.env.SETUP_KEY){
    return res.status(403).json({ok:false,error:'SETUP_KEY inválida'});
  }

  const requestedDays = Number(req.query.days || 30);
  const days = Math.max(1, Math.min(30, Number.isFinite(requestedDays) ? requestedDays : 30));
  const column = ['shift_date','created_at','updated_at'].includes(req.query.column) ? req.query.column : 'shift_date';

  try{
    const chunks = chunksForDays(days);
    const diagnostics=[];
    let salesTotal=0, itemsTotal=0;
    let firstSale=null, firstItem=null;

    for(const [start,end] of chunks){
      const params = {
        p_date_column_filter: column,
        p_filter_date_start: start,
        p_filter_date_end: end,
        p_limit: 1000,
        p_offset: 0
      };

      const [salesBody, itemsBody] = await Promise.all([
        saiposFetch('/search_sales', params),
        saiposFetch('/sales_items', params)
      ]);

      const sales = rows(salesBody);
      const items = rows(itemsBody);
      salesTotal += sales.length;
      itemsTotal += items.length;
      if(!firstSale && sales.length) firstSale = sales[0];
      if(!firstItem && items.length) firstItem = items[0];

      diagnostics.push({
        start,end,
        sales:{...shape(salesBody), firstRowKeys:sales[0] ? Object.keys(sales[0]) : []},
        items:{...shape(itemsBody), firstRowKeys:items[0] ? Object.keys(items[0]) : []}
      });
    }

    return res.status(200).json({
      ok:true,
      diagnostic:true,
      days,
      dateColumn:column,
      chunks:diagnostics,
      countsFirstPages:{sales:salesTotal,items:itemsTotal},
      sampleSale:safeSale(firstSale),
      sampleItem:safeItem(firstItem),
      nextTests:{
        created_at:`/api/test?key=SEU_SETUP_KEY&days=${days}&column=created_at`,
        updated_at:`/api/test?key=SEU_SETUP_KEY&days=${days}&column=updated_at`
      }
    });
  }catch(e){
    return res.status(500).json({ok:false,error:e.message,stack:process.env.NODE_ENV==='development'?e.stack:undefined});
  }
}
