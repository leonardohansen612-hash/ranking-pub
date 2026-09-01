async function authenticate(baseUrl, idPartner, secret) {
  const r = await fetch(`${baseUrl.replace(/\/+$/,'')}/auth`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ idPartner, secret })
  });

  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}

  if (!r.ok || !body?.token) {
    throw new Error(`Falha na autenticação (${r.status}).`);
  }

  return body.token;
}

function preview(text='') {
  return String(text).slice(0, 900);
}

async function callCatalog(baseUrl, token, authMode) {
  const authorization =
    authMode === 'bearer'
      ? `Bearer ${token}`
      : token;

  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/,'')}/catalog`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization
      }
    });

    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}

    return {
      authMode,
      status: r.status,
      ok: r.ok,
      contentType: r.headers.get('content-type'),
      responseKeys:
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body).slice(0, 50)
          : [],
      arrayLength: Array.isArray(body) ? body.length : null,
      preview: preview(body ? JSON.stringify(body) : text)
    };
  } catch (e) {
    return {
      authMode,
      ok: false,
      networkError: e.message
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const baseUrl = 'https://order-api.saipos.com';
  const idPartner = process.env.SAIPOS_ORDER_PARTNER_ID;
  const secret = process.env.SAIPOS_ORDER_SECRET;
  const storeId = process.env.SAIPOS_ORDER_STORE_ID;

  if (!idPartner || !secret || !storeId) {
    return res.status(500).json({
      ok:false,
      configured:{
        partnerId: !!idPartner,
        secret: !!secret,
        storeId: !!storeId
      },
      error:'Faltam variáveis SAIPOS_ORDER_* no Render.'
    });
  }

  try {
    const token = await authenticate(baseUrl, idPartner, secret);

    // O teste anterior confirmou que /catalog existe,
    // mas Bearer foi rejeitado como token inválido.
    // Agora comparamos RAW x Bearer usando o MESMO token recém-gerado.
    const raw = await callCatalog(baseUrl, token, 'raw');
    const bearer = await callCatalog(baseUrl, token, 'bearer');

    const winner = [raw, bearer].find(x => x.ok);

    return res.status(200).json({
      ok: true,
      test: 'saipos-order-catalog-auth-mode',
      authenticated: true,
      storeId,
      baseUrl,
      catalogAccessible: !!winner,
      workingAuthMode: winner?.authMode || null,
      results: [raw, bearer],
      note: 'Somente leitura em /catalog. Token e Secret não são exibidos. Nenhum pedido foi criado.'
    });
  } catch (e) {
    return res.status(500).json({
      ok:false,
      authenticated:false,
      error:e.message
    });
  }
}
