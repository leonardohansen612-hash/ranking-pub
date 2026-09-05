const BASE_URL = 'https://order-api.saipos.com';
const HML_COD_STORE = 'ae6c2251-56fa-457a-b688-05603829a4ea';
const HML_STORE_ID = '95279';

async function readJsonOrText(response) {
  const text = await response.text();
  try { return { body: JSON.parse(text), text: null }; }
  catch { return { body: null, text: text.slice(0, 1200) }; }
}

function extractToken(body) {
  if (!body || typeof body !== 'object') return null;
  return body.token || body.access_token || body.accessToken || body?.data?.token || body?.data?.access_token || null;
}

function summarizeCatalog(body) {
  if (!body || typeof body !== 'object') return { products: [], raw: body };

  const candidateArrays = [];
  const seen = new Set();

  function walk(value, path = 'root', depth = 0) {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      if (value.length && value.some(v => v && typeof v === 'object')) {
        candidateArrays.push({ path, value });
      }
      for (let i = 0; i < Math.min(value.length, 12); i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [k,v] of Object.entries(value)) walk(v, `${path}.${k}`, depth + 1);
    }
  }
  walk(body);

  const productishKeys = ['name','description','desc','title','product_name','desc_product','codigo_pdv','cod_pdv','pdv_code','code','sku','id'];
  const products = [];

  for (const arr of candidateArrays) {
    for (const item of arr.value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const keys = Object.keys(item);
      const score = productishKeys.filter(k => keys.includes(k)).length;
      if (score < 2) continue;

      const name = item.name ?? item.description ?? item.desc ?? item.title ?? item.product_name ?? item.desc_product ?? null;
      const pdvCode = item.codigo_pdv ?? item.cod_pdv ?? item.pdv_code ?? item.code ?? item.sku ?? item.externalCode ?? item.external_code ?? null;
      const id = item.id ?? item.id_product ?? item.product_id ?? item.guid ?? null;
      const key = JSON.stringify([name,pdvCode,id]);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push({ sourcePath: arr.path, name, pdvCode, id, raw: item });
      if (products.length >= 80) break;
    }
    if (products.length >= 80) break;
  }

  return { products, raw: body };
}

async function doCatalogAttempt(url, token, mode, extraHeaders = {}) {
  const authorization = mode === 'bearer' ? `Bearer ${token}` : token;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        Authorization: authorization,
        ...extraHeaders
      }
    });
    const parsed = await readJsonOrText(r);
    return {
      ok: r.ok,
      status: r.status,
      url: url.replace(HML_COD_STORE, '[COD_STORE_HML]'),
      authMode: mode,
      headersUsed: Object.keys(extraHeaders),
      body: parsed.body,
      textPreview: parsed.text
    };
  } catch (e) {
    return { ok:false, status:null, url, authMode:mode, networkError:e.message };
  }
}

export default async function saiposCatalogoHml(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const idPartner = process.env.SAIPOS_ORDER_PARTNER_ID;
  const secret = process.env.SAIPOS_ORDER_SECRET;

  if (!idPartner || !secret) {
    return res.status(500).json({
      ok:false,
      error:'Faltam SAIPOS_ORDER_PARTNER_ID e/ou SAIPOS_ORDER_SECRET no Render.',
      configured:{ partnerId:!!idPartner, secret:!!secret }
    });
  }

  try {
    const authResponse = await fetch(`${BASE_URL}/auth`, {
      method:'POST',
      headers:{ accept:'application/json', 'content-type':'application/json' },
      body:JSON.stringify({ idPartner, secret })
    });
    const authParsed = await readJsonOrText(authResponse);
    const token = extractToken(authParsed.body);

    if (!authResponse.ok || !token) {
      return res.status(502).json({
        ok:false,
        stage:'auth',
        authStatus:authResponse.status,
        hasToken:!!token,
        authBody: authParsed.body ? {
          type: authParsed.body.type ?? null,
          errorCode: authParsed.body.errorCode ?? null,
          errorMessage: authParsed.body.errorMessage ?? null,
          guidRequest: authParsed.body.guidRequest ?? null
        } : null,
        textPreview:authParsed.text
      });
    }

    const attempts = [
      [`${BASE_URL}/catalog`, 'raw', {}],
      [`${BASE_URL}/catalog`, 'bearer', {}],
      [`${BASE_URL}/catalog?cod_store=${encodeURIComponent(HML_COD_STORE)}`, 'raw', {}],
      [`${BASE_URL}/catalog?cod_store=${encodeURIComponent(HML_COD_STORE)}`, 'bearer', {}],
      [`${BASE_URL}/catalog?store_id=${encodeURIComponent(HML_STORE_ID)}`, 'raw', {}],
      [`${BASE_URL}/catalog?store_id=${encodeURIComponent(HML_STORE_ID)}`, 'bearer', {}],
      [`${BASE_URL}/catalog`, 'raw', { 'cod_store': HML_COD_STORE }],
      [`${BASE_URL}/catalog`, 'bearer', { 'cod_store': HML_COD_STORE }],
    ];

    const diagnostics = [];
    for (const [url, mode, headers] of attempts) {
      const result = await doCatalogAttempt(url, token, mode, headers);
      diagnostics.push({
        ok:result.ok,
        status:result.status,
        url:result.url,
        authMode:result.authMode,
        headersUsed:result.headersUsed,
        error: result.body?.errorMessage ?? result.body?.message ?? result.body?.error ?? result.textPreview ?? result.networkError ?? null
      });

      if (result.ok) {
        const summary = summarizeCatalog(result.body);
        return res.status(200).json({
          ok:true,
          test:'saipos-hml-catalog',
          cod_store:HML_COD_STORE,
          storeId:HML_STORE_ID,
          successfulAttempt:{ url:result.url, authMode:result.authMode, headersUsed:result.headersUsed },
          productCountDetected:summary.products.length,
          products:summary.products,
          catalog:summary.raw,
          diagnostics,
          note:'Token, Partner ID e Secret não são exibidos. Endpoint somente leitura.'
        });
      }
    }

    return res.status(502).json({
      ok:false,
      stage:'catalog',
      cod_store:HML_COD_STORE,
      storeId:HML_STORE_ID,
      diagnostics,
      note:'Autenticação funcionou, mas nenhuma variação de consulta ao /catalog retornou 2xx. Envie este JSON para ajustarmos o formato exato sem expor credenciais.'
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}
