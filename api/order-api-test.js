async function tryAuth(baseUrl, idPartner, secret) {
  const url = `${baseUrl.replace(/\/+$/,'')}/auth`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ idPartner, secret })
    });

    const text = await response.text();

    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    // Nunca devolvemos token/secret ao navegador.
    const hasToken =
      !!parsed &&
      typeof parsed === 'object' &&
      Object.keys(parsed).some(k =>
        ['token','access_token','accesstoken','authorization'].includes(k.toLowerCase())
      );

    return {
      baseUrl,
      status: response.status,
      ok: response.ok,
      authenticated: response.ok && (hasToken || response.status === 200),
      hasToken,
      responseKeys: parsed && typeof parsed === 'object'
        ? Object.keys(parsed)
        : [],
      errorPreview: response.ok
        ? null
        : String(
            parsed?.message ||
            parsed?.error ||
            text ||
            'Falha sem mensagem'
          ).slice(0, 250)
    };
  } catch (error) {
    return {
      baseUrl,
      ok: false,
      authenticated: false,
      networkError: error.message
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const idPartner = process.env.SAIPOS_ORDER_PARTNER_ID;
  const secret = process.env.SAIPOS_ORDER_SECRET;
  const storeId = process.env.SAIPOS_ORDER_STORE_ID;

  if (!idPartner || !secret || !storeId) {
    return res.status(500).json({
      ok: false,
      configured: {
        partnerId: !!idPartner,
        secret: !!secret,
        storeId: !!storeId
      },
      error: 'Faltam variáveis SAIPOS_ORDER_* no Render.'
    });
  }

  // A tela do Developer mostra order-api.saipos.com.
  // Como as credenciais são de Desenvolvimento, também testamos o host
  // de homologação usado historicamente pela API, sem executar pedido algum.
  const bases = [
    'https://order-api.saipos.com',
    'https://homolog-order-api.saipos.com'
  ];

  const results = [];
  for (const base of bases) {
    results.push(await tryAuth(base, idPartner, secret));
  }

  const winner = results.find(r => r.authenticated);

  return res.status(200).json({
    ok: true,
    test: 'saipos-order-api-auth',
    configured: {
      partnerId: true,
      secret: true,
      storeId: true
    },
    storeId,
    authenticated: !!winner,
    workingBaseUrl: winner?.baseUrl || null,
    results,
    note: 'Teste somente de autenticação. Nenhum pedido foi criado e nenhum token é exibido.'
  });
}
