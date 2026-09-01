const BASE="https://data.saipos.io/v1";
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function headers(t,b=false){return {Authorization:b?`Bearer ${t}`:t,Accept:"application/json"}}
async function saipos(path,params={},retries=3){
 const token=process.env.SAIPOS_API_TOKEN;if(!token)throw new Error("SAIPOS_API_TOKEN não configurado.");
 const u=new URL(BASE+path);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,String(v)));
 let last;
 for(let a=1;a<=retries;a++){try{
  let r=await fetch(u,{headers:headers(token)});
  if(r.status===401)r=await fetch(u,{headers:headers(token,true)});
  const txt=await r.text();let b;try{b=JSON.parse(txt)}catch{b=txt}
  if(r.ok)return Array.isArray(b)?b:(b?.data||b?.items||b?.results||b?.records||b?.result||[]);
  const e=new Error(`Saipos ${r.status}: ${typeof b==="string"?b.slice(0,400):JSON.stringify(b).slice(0,400)}`);
  if((r.status===504||b?.code==="PGRST003")&&a<retries){last=e;await wait(900*a);continue}throw e;
 }catch(e){last=e;if(/504|PGRST003|timeout|Timed out/i.test(e.message)&&a<retries){await wait(900*a);continue}throw e}}
 throw last;
}
function sp(d){const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`}
const sid=o=>String(o?.id_sale??o?.sale?.id_sale??o?.sale_id??"");
const name=o=>String(o?.desc_sale_item??o?.desc_store_item??o?.desc_item??o?.item_name??o?.name??"").trim();
const qty=o=>Number(o?.quantity??o?.qty??1)||0;
const beers=["pilsen","hoplager","witbier","bitterzinha","ybá","yba","ipa zero","american ipa","textreme","english porter","maria manuela","maria manoela","milkshake neipa","session ipa","sunrise","winner blond","pilsen caju"];
const isBeer=n=>beers.some(k=>String(n).toLowerCase().includes(k));
function itemWindow(created){
 const m=String(created||"").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);if(!m)return null;
 const f=delta=>{const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5]+delta,+m[6]));const z=n=>String(n).padStart(2,"0");return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`};
 return [f(-2),f(8)];
}
async function changed(a,b){return saipos("/search_sales",{p_date_column_filter:"updated_at",p_filter_date_start:sp(a),p_filter_date_end:sp(b),p_limit:100,p_offset:0})}
async function items(created){const w=itemWindow(created);if(!w)return[];return saipos("/sales_items",{p_date_column_filter:"created_at",p_filter_date_start:w[0],p_filter_date_end:w[1],p_limit:300,p_offset:0})}
export default async function handler(req,res){
 try{
  const now=new Date(),ago=s=>new Date(now-s*1000);
  const ws=[[ago(75),ago(45)],[ago(52),ago(22)],[ago(29),now]],map=new Map(),windows=[];
  for(const [a,b] of ws){try{const rows=await changed(a,b);rows.forEach(x=>{if(sid(x))map.set(sid(x),x)});windows.push({start:sp(a),end:sp(b),ok:true,sales:rows.length})}catch(e){windows.push({start:sp(a),end:sp(b),ok:false,sales:0,error:e.message})}}
  const out=[];
  for(const sale of map.values()){
   if(["Y","S",true,1,"1"].includes(sale?.canceled))continue;
   let groups=[],itemError=null;try{groups=await items(sale.created_at)}catch(e){itemError=e.message}
   const g=groups.find(x=>sid(x)===sid(sale)),arr=Array.isArray(g?.items)?g.items:[],found=[];let cups=0;
   for(const x of arr){if(["Y","S",true,1,"1"].includes(x?.deleted??x?.canceled))continue;const n=name(x);if(!isBeer(n))continue;const q=qty(x);cups+=q;found.push({name:n,quantity:q})}
   out.push({id_sale:sid(sale),customer:String(sale?.desc_sale||"").trim()||"Não identificado",created_at:sale.created_at??null,updated_at:sale.updated_at??null,cups,beers:found,itemError});
  }
  res.setHeader("Cache-Control","no-store");return res.status(200).json({ok:true,test:"incremental-items-v5",coverage:{start:sp(ws[0][0]),end:sp(now),seconds:75,windowSeconds:30,overlapSeconds:7},windows,changedSales:out.length,changed:out});
 }catch(e){return res.status(500).json({ok:false,test:"incremental-items-v5",error:e.message||String(e)})}
}