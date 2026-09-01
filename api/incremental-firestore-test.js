import { firebaseReady, saveIncrementalSaleTest, readIncrementalSalesTest } from './_firebase.js';

const BASE='https://data.saipos.io/v1';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function h(t,b=false){return {Authorization:b?`Bearer ${t}`:t,Accept:'application/json'}}

async function saipos(path,params={},retries=2){
  const token=process.env.SAIPOS_API_TOKEN;
  if(!token) throw new Error('SAIPOS_API_TOKEN não configurado.');
  const u=new URL(BASE+path);
  Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,String(v)));
  let last;
  for(let a=1;a<=retries;a++){
    try{
      let r=await fetch(u,{headers:h(token)});
      if(r.status===401) r=await fetch(u,{headers:h(token,true)});
      const txt=await r.text(); let b; try{b=JSON.parse(txt)}catch{b=txt}
      if(r.ok) return Array.isArray(b)?b:(b?.data||b?.items||b?.results||b?.records||b?.result||[]);
      const e=new Error(`Saipos ${r.status}: ${typeof b==='string'?b.slice(0,350):JSON.stringify(b).slice(0,350)}`);
      if((r.status===504||b?.code==='PGRST003')&&a<retries){last=e;await wait(600);continue}
      throw e;
    }catch(e){last=e;if(/504|PGRST003|timeout|Timed out/i.test(e.message)&&a<retries){await wait(600);continue}throw e}
  }
  throw last;
}

function sp(d){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(d).map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const sid=o=>String(o?.id_sale??o?.sale?.id_sale??o?.sale_id??'');
const words=['pilsen','hoplager','witbier','bitterzinha','ybá','yba','ipa zero','american ipa','textreme','english porter','maria manuela','maria manoela','milkshake neipa','session ipa','sunrise','winner blond','pilsen caju'];
const beer=n=>words.some(k=>String(n||'').toLowerCase().includes(k));
const iname=x=>String(x?.desc_sale_item??x?.desc_store_item??x?.desc_item??x?.item_name??x?.name??'').trim();
const iq=x=>Number(x?.quantity??x?.qty??1)||0;
const canceled=x=>['Y','S',true,1,'1'].includes(x?.deleted??x?.canceled??x?.cancelled);

function parts(v){
 const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
 return m?{y:+m[1],mo:+m[2],d:+m[3],h:+m[4],mi:+m[5],s:+m[6]}:null;
}
function shift(p,min){
 const d=new Date(Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi+min,p.s)),z=n=>String(n).padStart(2,'0');
 return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
}
async function items(created){
 const p=parts(created); if(!p)return[];
 return saipos('/sales_items',{p_date_column_filter:'created_at',p_filter_date_start:shift(p,-2),p_filter_date_end:shift(p,8),p_limit:300,p_offset:0},3);
}
async function changes(a,b){
 return saipos('/search_sales',{p_date_column_filter:'updated_at',p_filter_date_start:sp(a),p_filter_date_end:sp(b),p_limit:100,p_offset:0},2);
}

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  if(!firebaseReady())throw new Error('Firebase Admin não configurado.');
  const now=new Date(), ago=s=>new Date(now.getTime()-s*1000);

  // 8 janelas de 30s cobrem os últimos 4 minutos.
  // 5s de sobreposição entre janelas para não criar buracos.
  const windows=[];
  for(let i=0;i<8;i++){
    const endSec=i*30;
    const startSec=endSec+35;
    windows.push([ago(startSec),ago(endSec)]);
  }
  windows.reverse();

  const map=new Map(), checks=[];
  for(const [a,b] of windows){
    try{
      const rows=await changes(a,b);
      rows.forEach(s=>{const id=sid(s);if(id)map.set(id,s)});
      checks.push({start:sp(a),end:sp(b),ok:true,sales:rows.length});
    }catch(e){
      checks.push({start:sp(a),end:sp(b),ok:false,sales:0,error:e.message});
    }
  }

  const saved=[],errors=[];
  for(const sale of map.values()){
    if(['Y','S',true,1,'1'].includes(sale?.canceled))continue;
    const id=sid(sale);
    try{
      const groups=await items(sale.created_at);
      const group=groups.find(g=>sid(g)===id);
      const arr=Array.isArray(group?.items)?group.items:[];
      let cups=0; const beers=[];
      for(const x of arr){
        if(canceled(x))continue;
        const name=iname(x); if(!beer(name))continue;
        const quantity=iq(x); if(quantity<=0)continue;
        cups+=quantity; beers.push({name,quantity});
      }
      saved.push(await saveIncrementalSaleTest({
        id_sale:id,
        customer:String(sale?.desc_sale||'').trim()||'Não identificado',
        created_at:sale.created_at||null,updated_at:sale.updated_at||null,cups,beers
      }));
    }catch(e){errors.push({id_sale:id,error:e.message})}
  }

  const stored=await readIncrementalSalesTest();
  return res.status(200).json({
    ok:true,test:'incremental-firestore-v2',
    coverage:{start:sp(windows[0][0]),end:sp(now),minutes:4,windowSeconds:30,overlapSeconds:5},
    windows:checks,detectedSales:map.size,savedSales:saved.length,saved,errors,
    firestore:{collection:'ranking_incremental_test',totalDocs:stored.length,docs:stored}
  });
 }catch(e){return res.status(500).json({ok:false,test:'incremental-firestore-v2',error:e.message||String(e)})}
}