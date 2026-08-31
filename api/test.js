import {fetchHour, getSaleId, customerFor, getItemName, getQty, isBeer} from './_saipos.js';

export default async function handler(req,res){
  if(!process.env.SETUP_KEY || req.query.key !== process.env.SETUP_KEY){
    return res.status(403).json({ok:false,error:'SETUP_KEY inválida'});
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date||''))
    ? String(req.query.date)
    : '2026-08-29';

  const hour = Math.max(0,Math.min(23,Number(req.query.hour ?? 20)));

  try{
    const sales = await fetchHour('/search_sales',date,hour);
    const groups = await fetchHour('/sales_items',date,hour);
    const saleMap = new Map(sales.map(s=>[getSaleId(s),s]));

    const joined = groups.map(g=>{
      const sale=saleMap.get(getSaleId(g));
      return {
        id_sale:getSaleId(g),
        customer:sale ? customerFor(sale).name : null,
        beers:(Array.isArray(g.items)?g.items:[])
          .filter(i=>isBeer(getItemName(i)))
          .map(i=>({name:getItemName(i),quantity:getQty(i)}))
      };
    }).filter(x=>x.beers.length);

    res.status(200).json({
      ok:true,date,hour,
      sales:sales.length,
      saleGroups:groups.length,
      joined
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
}
