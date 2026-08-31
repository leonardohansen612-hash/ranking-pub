import {fetchPaged, periodsFor, getItemName, getSaleId} from './_saipos.js';
export default async function handler(req,res){
  if(!process.env.SETUP_KEY || req.query.key!==process.env.SETUP_KEY) return res.status(403).json({ok:false,error:'SETUP_KEY inválida'});
  try{
    const [[start,end]]=periodsFor('today');
    const [sales,items]=await Promise.all([fetchPaged('/search_sales',start,end),fetchPaged('/sales_items',start,end)]);
    res.status(200).json({ok:true,start,end,counts:{sales:sales.length,items:items.length},sampleSales:sales.slice(0,3),sampleItems:items.slice(0,10).map(x=>({id_sale:getSaleId(x),detected_name:getItemName(x),raw:x}))});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
}
