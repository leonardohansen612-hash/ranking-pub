const BASE_URL = 'https://order-api.saipos.com';

function safeResponseHeaders(headers) {
  const allow = new Set([
    'content-type','server','date','content-length','connection','via',
    'x-request-id','x-amzn-requestid','x-amz-cf-id','x-cache','cf-ray','cf-cache-status'
  ]);
  const out = {};
  for (const [k,v] of headers.entries()) {
    if (allow.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function attempt(name, url, idPartner, secret, extraHeaders = {}) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...extraHeaders
      },
      body: JSON.stringify({ idPartner, secret }),
      redirect: 'manual'
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    const token = json?.token || json?.access_token || json?.accessToken || json?.data?.token || null;

    return {
      name,
      url,
      status: r.status,
      ok: r.ok,
      elapsedMs: Date.now() - started,
      responseHeaders: safeResponseHeaders(r.headers),
      hasToken: !!token,
      json: json ? {
        type: json.type ?? null,
        errorCode: json.errorCode ?? null,
        errorMessage: json.errorMessage ?? json.message ?? json.error ?? null,
        guidRequest: json.guidRequest ?? null,
        keys: Object.keys(json).filter(k => !['token','access_token','accessToken'].includes(k)).slice(0,30)
      } : null,
      textPreview: json ? null : String(text).slice(0,500)
    };
  } catch (e) {
    return {
      name,
      url,
      status: null,
      ok: false,
      elapsedMs: Date.now() - started,
      networkError: e?.message || String(e)
    };
  }
}

export default async function saiposAuthDiagnostico(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const idPartner = String(process.env.SAIPOS_ORDER_PARTNER_ID || '').trim();
  const secret = String(process.env.SAIPOS_ORDER_SECRET || '').trim();

  if (!idPartner || !secret) {
    return res.status(500).json({
      ok:false,
      configured:{ partnerId:!!idPartner, secret:!!secret },
      error:'Faltam SAIPOS_ORDER_PARTNER_ID e/ou SAIPOS_ORDER_SECRET no Render.'
    });
  }

  // Não exibe credenciais. Só comprimentos ajudam a detectar espaços/quebras acidentais.
  const credentialsCheck = {
    partnerIdConfigured: true,
    secretConfigured: true,
    partnerIdLength: idPartner.length,
    secretLength: secret.length
  };

  const attempts = [];
  attempts.push(await attempt('auth-normal', `${BASE_URL}/auth`, idPartner, secret));
  attempts.push(await attempt('auth-trailing-slash', `${BASE_URL}/auth/`, idPartner, secret));
  attempts.push(await attempt('auth-browser-user-agent', `${BASE_URL}/auth`, idPartner, secret, {
    'user-agent': 'Mozilla/5.0 (compatible; TexPubRanking/1.0; +https://ranking-pub.onrender.com)'
  }));
  attempts.push(await attempt('auth-json-charset', `${BASE_URL}/auth`, idPartner, secret, {
    'content-type': 'application/json; charset=utf-8'
  }));

  const successful = attempts.find(a => a.ok && a.hasToken) || null;

  return res.status(200).json({
    ok: !!successful,
    test: 'saipos-order-auth-diagnostic-v2',
    baseUrl: BASE_URL,
    credentialsCheck,
    successfulAttempt: successful ? successful.name : null,
    attempts,
    note: 'Nenhum Secret, Partner ID ou token é retornado. Este endpoint somente testa autenticação e não cria pedidos.'
  });
}
