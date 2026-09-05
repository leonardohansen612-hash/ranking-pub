import dns from 'node:dns/promises';

const AUTH_URL = 'https://order-api.saipos.com/auth';
const HOST = 'order-api.saipos.com';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function discoverOutboundIp() {
  const services = [
    {
      name: 'ipify',
      url: 'https://api.ipify.org?format=json',
      parse: async r => {
        const j = await r.json();
        return String(j?.ip || '').trim();
      }
    },
    {
      name: 'icanhazip',
      url: 'https://icanhazip.com/',
      parse: async r => String(await r.text()).trim()
    }
  ];

  for (const svc of services) {
    const started = Date.now();
    try {
      const r = await fetch(svc.url, {
        method: 'GET',
        headers: { 'user-agent': 'TexPubRanking-IP-Diagnostic/1.0' },
        cache: 'no-store'
      });
      if (!r.ok) continue;
      const ip = await svc.parse(r);
      if (ip) return { ok:true, ip, source:svc.name, elapsedMs:Date.now()-started };
    } catch {}
  }

  return { ok:false, ip:null, source:null };
}

async function authAttempt(idPartner, secret) {
  const started = Date.now();
  try {
    const r = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'TexPubRanking-IP-Diagnostic/1.0'
      },
      body: JSON.stringify({ idPartner, secret }),
      redirect: 'manual',
      cache: 'no-store'
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const token = json?.token || json?.access_token || json?.accessToken || json?.data?.token || null;

    return {
      status: r.status,
      ok: r.ok,
      elapsedMs: Date.now() - started,
      server: r.headers.get('server'),
      contentType: r.headers.get('content-type'),
      hasToken: !!token,
      apiErrorCode: json?.errorCode ?? json?.code ?? null,
      apiMessage: json?.errorMessage ?? json?.message ?? json?.error ?? null,
      responseKind: json ? 'json' : 'text',
      textPreview: json ? null : String(text).slice(0,180)
    };
  } catch (e) {
    return {
      status: null,
      ok: false,
      elapsedMs: Date.now() - started,
      networkError: e?.message || String(e)
    };
  }
}

function summarize(attempts) {
  const byIp = {};
  for (const a of attempts) {
    const ip = a.outbound?.ip || 'IP_NAO_IDENTIFICADO';
    if (!byIp[ip]) byIp[ip] = { attempts:0, statuses:{}, successes:0 };
    byIp[ip].attempts++;
    const status = String(a.auth?.status ?? 'network-error');
    byIp[ip].statuses[status] = (byIp[ip].statuses[status] || 0) + 1;
    if (a.auth?.ok && a.auth?.hasToken) byIp[ip].successes++;
  }
  return byIp;
}

export default async function saiposIpDiagnostico(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const idPartner = String(process.env.SAIPOS_ORDER_PARTNER_ID || '').trim();
  const secret = String(process.env.SAIPOS_ORDER_SECRET || '').trim();
  if (!idPartner || !secret) {
    return res.status(500).json({
      ok:false,
      error:'Faltam SAIPOS_ORDER_PARTNER_ID e/ou SAIPOS_ORDER_SECRET no Render.'
    });
  }

  let count = Number.parseInt(String(req.query.n || '12'), 10);
  if (!Number.isFinite(count)) count = 12;
  count = Math.max(1, Math.min(count, 20));

  let dnsResults = [];
  try {
    dnsResults = await dns.lookup(HOST, { all:true });
  } catch (e) {
    dnsResults = [{ error:e?.message || String(e) }];
  }

  const attempts = [];
  for (let i = 1; i <= count; i++) {
    const outbound = await discoverOutboundIp();
    const auth = await authAttempt(idPartner, secret);
    attempts.push({ attempt:i, outbound, auth });
    if (i < count) await sleep(150);
  }

  const anySuccess = attempts.some(a => a.auth?.ok && a.auth?.hasToken);

  return res.status(200).json({
    ok: anySuccess,
    test: 'saipos-ip-auth-diagnostic-v1',
    timestamp: new Date().toISOString(),
    renderAdvertisedOutboundRanges: ['74.220.49.0/24','74.220.57.0/24'],
    saiposDns: dnsResults,
    attemptCount: count,
    summaryByObservedIp: summarize(attempts),
    attempts,
    interpretation: 'O IP observado vem de um serviço externo imediatamente antes do /auth. Em infraestrutura NAT compartilhada ele é uma forte pista, mas não prova que a conexão seguinte com a Saipos usou exatamente o mesmo IP.',
    security: 'Partner ID, Secret e token não são retornados.'
  });
}
