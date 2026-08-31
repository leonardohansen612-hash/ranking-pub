import { saiposFetch, rows, getItemName, getSaleId } from './_saipos.js';

function pad(n){ return String(n).padStart(2,'0'); }
function fmt(d){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function parseDateParam(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))) return null;
  const [y,m,d] = value.split('-').map(Number);
  const dt = new Date(y, m-1, d, 0, 0, 0, 0);
  if(dt.getFullYear()!==y || dt.getMonth()!==m-1 || dt.getDate()!==d) return null;
  return dt;
}
function chunksForDays(days){
  const end = new Date();
  end.setHours(23,59,59,999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0,0,0,0);
  return [[fmt(start), fmt(end)]];
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

  const column = ['shift_date','created_at','updated_at'].includes(req.query.column) ? req.query.column : 'shift_date';
  const specificDate = parseDateParam(req.query.date);
  const requestedDays = Number(req.query.days || 1);
  const days = Math.max(1, Math.min(15, Number.isFinite(requestedDays) ? requestedDays : 1));

  let chunks;
  if (req.query.date && !specificDate) {
    return res.status(400).json({ok:false,error:'Data inválida. Use YYYY-MM-DD, por exemplo 2026-08-29.'});
  }
  if (specificDate) {
    const start = new Date(specificDate);
    start.setHours(0,0,0,0);
    const end = new Date(specificDate);
    end.setHours(23,59,59,999);
    chunks = [[fmt(start), fmt(end)]];
  } else {
    chunks = chunksForDays(days);
  }

  try{
    const diagnostics=[];
    let salesTotal=0, itemsTotal=0;
    let firstSale=null, firstItem=null;

    for(const [start,end] of chunks){
      const params = {
        p_date_column_filter: column,
        p_filter_date_start: start,
        p_filter_date_end: end,
        p_limit: 100,
        p_offset: 0
      };

      // Fazemos em sequência para reduzir carga e facilitar o diagnóstico.
      const salesBody = await saiposFetch('/search_sales', params);
      const sales = rows(salesBody);
      salesTotal += sales.length;
      if(!firstSale && sales.length) firstSale = sales[0];

      const itemsBody = await saiposFetch('/sales_items', params);
      const items = rows(itemsBody);
      itemsTotal += items.length;
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
      date:req.query.date || null,
      days:specificDate ? 1 : days,
      dateColumn:column,
      chunks:diagnostics,
      countsFirstPages:{sales:salesTotal,items:itemsTotal},
      sampleSale:safeSale(firstSale),
      sampleItem:safeItem(firstItem)
    });
  }catch(e){
    return res.status(500).json({ok:false,error:e.message});
  }
}
