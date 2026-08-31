import {fetchPaged, periodsFor, getSaleId, getItemName, getQty, itemCanceled, saleCanceled, customerFor, isBeer} from './_saipos.js';

export default async function handler(req,res){
  try {
    const period=req.query.period==='month'?'month':'today';
    const chunks=periodsFor(period);
    let sales=[], items=[];
    for(const [start,end] of chunks){
      const [s,i]=await Promise.all([fetchPaged('/search_sales',start,end),fetchPaged('/sales_items',start,end)]);
      sales.push(...s); items.push(...i);
    }
    const saleMap=new Map(sales.filter(s=>!saleCanceled(s)).map(s=>[getSaleId(s),s]));
    const rank=new Map(); let matchedItems=0;
    for(const it of items){
      if(itemCanceled(it)) continue;
      const name=getItemName(it); if(!isBeer(name)) continue;
      const sale=saleMap.get(getSaleId(it)); if(!sale) continue;
      const qty=getQty(it); if(qty<=0) continue;
      matchedItems++;
      const c=customerFor(sale);
      const cur=rank.get(c.key)||{name:c.name,cups:0,beers:{}};
      cur.cups+=qty; cur.beers[name]=(cur.beers[name]||0)+qty; rank.set(c.key,cur);
    }
    const ranking=[...rank.values()].sort((a,b)=>b.cups-a.cups||a.name.localeCompare(b.name));
    res.status(200).json({ok:true,period,updatedAt:new Date().toISOString(),ranking,stats:{sales:sales.length,items:items.length,matchedItems}});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
}
