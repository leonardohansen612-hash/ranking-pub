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

function cleanPreview(text='') {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REMOVIDO]')
    .slice(0, 500);
}

async function safeProbe(baseUrl, token, path, method='GET') {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/,'')}${path}`, {
      method,
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${token}`
      }
    });

    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    return {
      path,
      method,
      status: r.status,
      ok: r.ok,
      allow: r.headers.get('allow'),
      contentType: r.headers.get('content-type'),
      responseKeys:
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.keys(parsed).slice(0, 40)
          : [],
      arrayLength: Array.isArray(parsed) ? parsed.length : null,
      preview: cleanPreview(
        parsed
          ? JSON.stringify(parsed)
          : text
      )
    };
  } catch (e) {
    return {
      path,
      method,
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

    // Somente descoberta/leitura.
    // Primeiro procuramos documentação/esquema publicado pela própria API.
    const probes = [
      ['/', 'GET'],
      ['/openapi.json', 'GET'],
      ['/swagger.json', 'GET'],
      ['/swagger/v1/swagger.json', 'GET'],
      ['/api-docs', 'GET'],
      ['/docs', 'GET'],

      // OPTIONS não cria/edita dados; serve apenas para descobrir rotas/métodos.
      ['/products', 'OPTIONS'],
      ['/product', 'OPTIONS'],
      ['/menu', 'OPTIONS'],
      ['/catalog', 'OPTIONS'],
      ['/orders', 'OPTIONS'],
      ['/order', 'OPTIONS'],
      [`/stores/${encodeURIComponent(storeId)}`, 'OPTIONS'],
      [`/stores/${encodeURIComponent(storeId)}/products`, 'OPTIONS'],
      [`/stores/${encodeURIComponent(storeId)}/menu`, 'OPTIONS']
    ];

    const results = [];
    for (const [path, method] of probes) {
      results.push(await safeProbe(baseUrl, token, path, method));
    }

    return res.status(200).json({
      ok:true,
      test:'saipos-order-api-discovery',
      authenticated:true,
      storeId,
      baseUrl,
      note:'Somente GET/OPTIONS. Nenhum pedido foi criado, alterado ou cancelado. Token e Secret não são exibidos.',
      results
    });
  } catch (e) {
    return res.status(500).json({
      ok:false,
      authenticated:false,
      error:e.message
    });
  }
}
