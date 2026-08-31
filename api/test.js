import { saiposFetch, rows } from './_saipos.js';

function pad(n){ return String(n).padStart(2,'0'); }

function validDate(v){
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''));
}

function safeShape(body){
  const r = rows(body);
  return {
    type: Array.isArray(body) ? 'array' : typeof body,
    topLevelKeys: body && !Array.isArray(body) && typeof body === 'object' ? Object.keys(body) : [],
    count: r.length,
    firstRow: r[0] || null
  };
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
  const endpoint = req.query.endpoint === 'items' ? 'items' : 'sales';

  const hh = pad(hour);
  const start = `${date} ${hh}:00:00`;
  const end = `${date} ${hh}:59:59`;

  const path = endpoint === 'items' ? '/sales_items' : '/search_sales';

  const params = {
    p_date_column_filter: 'created_at',
    p_filter_date_start: start,
    p_filter_date_end: end,
    p_limit: 5,
    p_offset: 0
  };

  try{
    const t0 = Date.now();
    const body = await saiposFetch(path, params);
    const elapsedMs = Date.now() - t0;

    return res.status(200).json({
      ok:true,
      diagnostic:'one-hour',
      endpoint,
      path,
      date,
      hour,
      start,
      end,
      elapsedMs,
      result:safeShape(body)
    });
  }catch(e){
    return res.status(500).json({
      ok:false,
      diagnostic:'one-hour',
      endpoint,
      path,
      date,
      hour,
      start,
      end,
      error:e.message
    });
  }
}
