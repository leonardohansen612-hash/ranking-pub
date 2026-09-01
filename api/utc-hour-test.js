import { saiposFetch, rows } from './_saipos.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function compact(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const preferred = [
    'id_sale',
    'id_sale_status_history',
    'id_status',
    'id_sale_status',
    'status',
    'desc_status',
    'description',
    'created_at',
    'updated_at',
    'shift_date',
    'desc_sale',
    'id_store'
  ];

  const out = {};
  for (const key of preferred) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }

  // Ajuda a descobrir o layout real sem despejar payload gigante.
  out._keys = Object.keys(obj);
  return out;
}

async function fetchEndpoint(path, column, start, end) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const body = await saiposFetch(path, {
        p_date_column_filter: column,
        p_filter_date_start: start,
        p_filter_date_end: end,
        p_limit: 300,
        p_offset: 0
      });

      const data = rows(body);

      return {
        ok: true,
        count: data.length,
        rows: data.slice(0, 300).map(compact)
      };
    } catch (e) {
      lastError = e;
      if (attempt < 2) await sleep(1200);
    }
  }

  return {
    ok: false,
    error: lastError?.message || 'Falha Saipos',
    count: 0,
    rows: []
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Janela do Tio Zé, lançado às 16:09.
  // Também testamos +3h apenas como comparação.
  const windows = [
    {
      label: 'local_16h',
      start: '2026-09-01 15:55:00',
      end:   '2026-09-01 16:30:59'
    },
    {
      label: 'mais_3h_19h',
      start: '2026-09-01 18:55:00',
      end:   '2026-09-01 19:30:59'
    }
  ];

  const results = [];

  for (const window of windows) {
    const sales = await fetchEndpoint(
      '/search_sales',
      'created_at',
      window.start,
      window.end
    );

    await sleep(700);

    const historiesCreated = await fetchEndpoint(
      '/sales_status_histories',
      'created_at',
      window.start,
      window.end
    );

    await sleep(700);

    const historiesUpdated = await fetchEndpoint(
      '/sales_status_histories',
      'updated_at',
      window.start,
      window.end
    );

    results.push({
      ...window,
      search_sales_created_at: sales,
      sales_status_histories_created_at: historiesCreated,
      sales_status_histories_updated_at: historiesUpdated
    });

    await sleep(700);
  }

  // ID conhecido do Teste João para ajudar a enxergar IDs posteriores.
  const knownTestJoaoId = 854470621;

  const candidateStatusIds = [
    ...new Set(
      results.flatMap(r => [
        ...(r.sales_status_histories_created_at.rows || []),
        ...(r.sales_status_histories_updated_at.rows || [])
      ])
      .map(x => Number(x?.id_sale))
      .filter(x => Number.isFinite(x) && x > knownTestJoaoId)
    )
  ].sort((a,b) => a-b);

  return res.status(200).json({
    ok: true,
    test: 'search_sales_vs_sales_status_histories',
    knownReference: {
      name: 'Teste João',
      id_sale: knownTestJoaoId,
      created_at: '2026-09-01T15:22:50'
    },
    target: {
      name: 'Tio Zé',
      launchedAtLocal: '2026-09-01 16:09'
    },
    note: 'Somente leitura. Compara vendas com histórico de status nas mesmas janelas.',
    candidateStatusIdsAfterTesteJoao: candidateStatusIds,
    results
  });
}
