import {
  fetchHour,
  getSaleId,
  saleCanceled,
  itemCanceled,
  getItemName,
  getQty,
  customerFor,
  isBeer
} from './_saipos.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

function previousDate(date) {
  const [y,m,d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  dt.setUTCDate(dt.getUTCDate()-1);
  return dt.toISOString().slice(0,10);
}

function todaySP() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function updatedOn(sale,date) {
  return String(sale?.updated_at ?? sale?.updatedAt ?? sale?.date_updated ?? '').startsWith(date);
}

async function getHour(path,date,hour,warnings) {
  let last;
  for(let attempt=1;attempt<=3;attempt++){
    try { return await fetchHour(path,date,hour); }
    catch(e) {
      last=e;
      if(attempt<3) await wait(attempt*700);
    }
  }
  warnings.push(`${date} ${String(hour).padStart(2,'0')}h ${path}: ${last?.message||'Falha Saipos'}`);
  return [];
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');

  try {
    const date = todaySP();
    const prev = previousDate(date);
    const warnings=[];

    // Teste isolado: apenas 20h–23h do dia anterior.
    const sales=[];
    const groups=[];

    for(let hour=20;hour<=23;hour++){
      const s=await getHour('/search_sales',prev,hour,warnings);
      const g=await getHour('/sales_items',prev,hour,warnings);
      sales.push(...s);
      groups.push(...g);
    }

    const carrySales = sales.filter(s =>
      !saleCanceled(s) &&
      getSaleId(s) &&
      updatedOn(s,date)
    );

    const ids = new Set(carrySales.map(getSaleId));
    const carryGroups = groups.filter(g => ids.has(getSaleId(g)));

    const rank=new Map();
    let matchedItems=0, beerCups=0;

    for(const group of carryGroups){
      const id=getSaleId(group);
      const sale=carrySales.find(s=>getSaleId(s)===id);
      if(!sale)continue;

      const customer=customerFor(sale);
      const items=Array.isArray(group?.items)?group.items:[];

      for(const item of items){
        if(itemCanceled(item))continue;
        const name=getItemName(item);
        if(!isBeer(name))continue;
        const q=getQty(item);
        if(q<=0)continue;

        matchedItems++;
        beerCups+=q;

        const cur=rank.get(customer.key)||{
          key:customer.key,name:customer.name,cups:0,beers:{}
        };
        cur.cups+=q;
        cur.beers[name]=(cur.beers[name]||0)+q;
        rank.set(customer.key,cur);
      }
    }

    return res.status(200).json({
      ok:true,
      test:'midnight-carryover',
      currentDate:date,
      previousDate:prev,
      hoursChecked:'20:00-23:59',
      previousDaySalesFound:sales.length,
      carryoverSalesFound:carrySales.length,
      carryoverSales:carrySales.map(s=>({
        id_sale:getSaleId(s),
        customer:customerFor(s).name,
        created_at:s?.created_at??null,
        updated_at:s?.updated_at??null
      })),
      ranking:[...rank.values()].sort((a,b)=>b.cups-a.cups),
      stats:{
        saleGroups:carryGroups.length,
        matchedItems,
        beerCups
      },
      warnings
    });
  } catch(e) {
    return res.status(500).json({
      ok:false,
      test:'midnight-carryover',
      error:e?.message||String(e)
    });
  }
}
