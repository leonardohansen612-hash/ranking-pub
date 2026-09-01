import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const REFRESH_MS = 60_000;

function Shell({ children, className = '' }) {
  return <div className={`app ${className}`}>{children}</div>;
}

function beerSummary(p) {
  const entries = Object.entries(p?.beers || {})
    .filter(([, qty]) => Number(qty || 0) > 0)
    .sort((a,b) => Number(b[1] || 0) - Number(a[1] || 0));

  if (!entries.length) return '';
  return entries
    .map(([name, qty]) => `${name} ×${qty}`)
    .join(' • ');
}

function Ranking() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [lastSaiposAttemptAt, setLastSaiposAttemptAt] = useState(null);
  const [source, setSource] = useState('');
  const [leaderFlash, setLeaderFlash] = useState(false);
  const lastLeader = useRef(null);

  async function loadRanking() {
    try {
      const r = await fetch(`/api/ranking?period=today&_=${Date.now()}`, {
        cache: 'no-store'
      });

      const data = await r.json();

      if (!r.ok || !data?.ok) {
        throw new Error(data?.error || `Erro ${r.status}`);
      }

      setItems(Array.isArray(data.ranking) ? data.ranking : []);
      setStats(data.stats || {});
      setUpdatedAt(data.updatedAt || null);
      setLastSaiposAttemptAt(data.lastSaiposAttemptAt || null);
      setSource(data.storage?.source || '');
      setError('');
    } catch (e) {
      console.error(e);
      // IMPORTANTE: erro de atualização não apaga o ranking que já estava na TV.
      setError(e.message || 'Falha ao atualizar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRanking();
    const timer = setInterval(loadRanking, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const sorted = useMemo(
    () => [...items].sort((a,b) => (Number(b.cups)||0) - (Number(a.cups)||0) || String(a.name||'').localeCompare(String(b.name||''),'pt-BR')),
    [items]
  );

  useEffect(() => {
    const leader = sorted[0]?.key;
    if (lastLeader.current && leader && leader !== lastLeader.current) {
      setLeaderFlash(true);
      const t = setTimeout(() => setLeaderFlash(false), 3200);
      lastLeader.current = leader;
      return () => clearTimeout(t);
    }
    if (leader) lastLeader.current = leader;
  }, [sorted]);

  const top = sorted.slice(0,10);

  return <Shell className="ranking-shell">
    {leaderFlash && <div className="leader-flash"><div>👑</div><b>NOVO LÍDER!</b></div>}

    <header className="ranking-header">
      <div className="brandmark">TEX</div>
      <div>
        <div className="eyebrow">TEX PUB APRESENTA</div>
        <h1>RANKING DO COPO</h1>
        <p>Ranking de hoje</p>
      </div>
      <div className="live">● AO VIVO</div>
    </header>

    {loading && top.length === 0 ? (
      <div className="loading">Carregando ranking...</div>
    ) : top.length === 0 ? (
      <div className="tv-empty">
        <div>🍺</div>
        <h2>Quem abre a rodada?</h2>
        <p>O primeiro chope confirmado do dia aparece aqui.</p>
      </div>
    ) : (
      <>
        <section className="podium">
          {top[1] && <PodiumCard p={top[1]} place={2}/>}
          {top[0] && <PodiumCard p={top[0]} place={1}/>}
          {top[2] && <PodiumCard p={top[2]} place={3}/>}
        </section>

        <section className="rest-list">
          {top.slice(3).map((p, idx) => (
            <div className="rank-row" key={p.key}>
              <div className="rank-num">{idx+4}º</div>
              <div className="rank-name">
                <b>{p.name}</b>
                <span>{beerSummary(p)}</span>
              </div>
              <div className="rank-cups">
                <span>🍺</span>{Number(p.cups)||0}<small>copos</small>
              </div>
            </div>
          ))}
        </section>
      </>
    )}

    <footer className="tv-footer">
      Atualização automática a cada 60 segundos
      {Number(stats?.beerCups || 0) > 0 ? ` • ${stats.beerCups} copos confirmados hoje` : ''}
      {error ? ' • Última tentativa falhou; mantendo o último ranking confirmado' : ''}
    </footer>
  </Shell>
}

function PodiumCard({ p, place }) {
  return <article className={`podium-card place-${place}`}>
    <div className="medal">{place===1?'🥇':place===2?'🥈':'🥉'}</div>
    <div className="podium-place">{place}º LUGAR</div>
    <h2>{p.name}</h2>
    <p>{beerSummary(p)}</p>
    <div className="big-cups"><span>🍺</span><b>{Number(p.cups)||0}</b></div>
    <small>COPOS</small>
  </article>
}

function Home() {
  return <Shell className="home-shell">
    <div className="home-card">
      <div className="brandmark">TEX</div>
      <h1>Ranking do Copo</h1>
      <a href="/ranking">Abrir Ranking de Hoje</a>
    </div>
  </Shell>;
}

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const Component = path === '/ranking' ? Ranking : Home;

createRoot(document.getElementById('root')).render(<Component />);
