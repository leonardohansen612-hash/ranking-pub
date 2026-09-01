async function authenticateDetailed(baseUrl, idPartner, secret) {
  try {
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

    const safeBody =
      body && typeof body === 'object'
        ? {
            type: body.type ?? null,
            errorCode: body.errorCode ?? null,
            dateTime: body.dateTime ?? null,
            errorMessage: body.errorMessage ?? null,
            guidRequest: body.guidRequest ?? null,
            responseKeys: Object.keys(body).filter(k => k !== 'token').slice(0, 30),
            hasToken: !!body.token
          }
        : null;

    return {
      status: r.status,
      ok: r.ok,
      contentType: r.headers.get('content-type'),
      safeBody,
      textPreview: safeBody ? null : String(text).slice(0, 500)
    };
  } catch (e) {
    return {
      status: null,
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

  const auth = await authenticateDetailed(baseUrl, idPartner, secret);

  return res.status(200).json({
    ok: auth.ok,
    test: 'saipos-order-auth-diagnostic',
    configured:{
      partnerId: true,
      secret: true,
      storeId: true
    },
    storeId,
    baseUrl,
    auth,
    note:'Diagnóstico somente do /auth. Secret, Partner ID e token não são exibidos. Nenhum pedido é criado.'
  });
}
