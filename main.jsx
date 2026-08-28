import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';
import './styles.css';

const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const participantsCol = () => collection(db, 'ranking_days', todayKey(), 'participants');

function useParticipants() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(participantsCol(), orderBy('cups', 'desc'));
    const unsub = onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a,b) => (b.cups || 0) - (a.cups || 0) || (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
      setItems(rows);
      setLoading(false);
    }, err => {
      console.error(err);
      setLoading(false);
    });
    return unsub;
  }, []);

  return { items, loading };
}

function Shell({ children, className = '' }) {
  return <div className={`app ${className}`}>{children}</div>;
}

function Admin() {
  const { items } = useParticipants();
  const [name, setName] = useState('');
  const [table, setTable] = useState('');
  const [busy, setBusy] = useState(false);

  async function createParticipant(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await addDoc(participantsCol(), {
        name: name.trim().slice(0, 28),
        table: table.trim().slice(0, 12),
        cups: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setName('');
      setTable('');
    } finally { setBusy(false); }
  }

  async function change(id, amount) {
    const row = items.find(i => i.id === id);
    if (!row) return;
    if (amount < 0 && (row.cups || 0) <= 0) return;
    await updateDoc(doc(db, 'ranking_days', todayKey(), 'participants', id), {
      cups: increment(amount),
      updatedAt: serverTimestamp(),
    });
  }

  async function remove(id) {
    if (!confirm('Remover esse participante do ranking?')) return;
    await deleteDoc(doc(db, 'ranking_days', todayKey(), 'participants', id));
  }

  async function resetDay() {
    if (!confirm('Zerar TODOS os copos de hoje?')) return;
    const snap = await getDocs(participantsCol());
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { cups: 0, updatedAt: serverTimestamp() }));
    await batch.commit();
  }

  return <Shell className="admin-shell">
    <header className="topbar">
      <div>
        <div className="eyebrow">TEX PUB</div>
        <h1>Painel do Ranking</h1>
      </div>
      <div className="navlinks">
        <a href="/ranking" target="_blank">Abrir TV</a>
        <a href="/entrar" target="_blank">Abrir cadastro</a>
      </div>
    </header>

    <section className="admin-grid">
      <form className="create-card" onSubmit={createParticipant}>
        <h2>Novo participante</h2>
        <label>Nome / apelido<input value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Hansen" maxLength={28}/></label>
        <label>Mesa<input value={table} onChange={e=>setTable(e.target.value)} placeholder="Ex.: 07" maxLength={12}/></label>
        <button className="primary" disabled={busy}>{busy ? 'Criando...' : 'Adicionar ao ranking'}</button>
        <button className="danger ghost" type="button" onClick={resetDay}>Zerar copos do dia</button>
      </form>

      <div className="participants">
        {items.length === 0 && <div className="empty">Ninguém entrou no ranking ainda.</div>}
        {items.map((p, idx) => <article className="participant-card" key={p.id}>
          <div className="position">#{idx+1}</div>
          <div className="person">
            <strong>{p.name}</strong>
            <span>{p.table ? `Mesa ${p.table}` : 'Sem mesa'}</span>
          </div>
          <div className="cupcount">🍺 <b>{p.cups || 0}</b></div>
          <div className="actions">
            <button className="minus" onClick={()=>change(p.id,-1)}>−1</button>
            <button className="plus" onClick={()=>change(p.id,1)}>+1 COPO</button>
            <button className="remove" onClick={()=>remove(p.id)}>×</button>
          </div>
        </article>)}
      </div>
    </section>
  </Shell>
}

function Ranking() {
  const { items, loading } = useParticipants();
  const [leaderFlash, setLeaderFlash] = useState(false);
  const lastLeader = useRef(null);
  const sorted = useMemo(() => [...items].sort((a,b)=>(b.cups||0)-(a.cups||0)), [items]);

  useEffect(() => {
    const leader = sorted[0]?.id;
    if (lastLeader.current && leader && leader !== lastLeader.current) {
      setLeaderFlash(true);
      const t = setTimeout(()=>setLeaderFlash(false), 3200);
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
        <p>Quem está no topo hoje?</p>
      </div>
      <div className="live">● AO VIVO</div>
    </header>

    {loading ? <div className="loading">Carregando ranking...</div> : top.length === 0 ?
      <div className="tv-empty"><div>🍺</div><h2>O ranking ainda está vazio.</h2><p>Escaneie o QR ou fale com o garçom para participar.</p></div>
      : <>
        <section className="podium">
          {top[1] && <PodiumCard p={top[1]} place={2}/>} 
          {top[0] && <PodiumCard p={top[0]} place={1}/>} 
          {top[2] && <PodiumCard p={top[2]} place={3}/>} 
        </section>
        <section className="rest-list">
          {top.slice(3).map((p, idx) => <div className="rank-row" key={p.id}>
            <div className="rank-num">{idx+4}º</div>
            <div className="rank-name"><b>{p.name}</b><span>{p.table ? `Mesa ${p.table}` : ''}</span></div>
            <div className="rank-cups"><span>🍺</span>{p.cups || 0}<small>copos</small></div>
          </div>)}
        </section>
      </>}
    <footer className="tv-footer">Atualização em tempo real • Copos sem álcool também podem participar</footer>
  </Shell>
}

function PodiumCard({ p, place }) {
  return <article className={`podium-card place-${place}`}>
    <div className="medal">{place===1?'🥇':place===2?'🥈':'🥉'}</div>
    <div className="podium-place">{place}º LUGAR</div>
    <h2>{p.name}</h2>
    <p>{p.table ? `Mesa ${p.table}` : ' '}</p>
    <div className="big-cups"><span>🍺</span><b>{p.cups || 0}</b></div>
    <small>COPOS</small>
  </article>
}

function Join() {
  const [name, setName] = useState('');
  const [table, setTable] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await addDoc(participantsCol(), {
        name: name.trim().slice(0,28),
        table: table.trim().slice(0,12),
        cups: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setDone(true);
    } finally { setBusy(false); }
  }

  return <Shell className="join-shell">
    <div className="join-card">
      <div className="join-logo">🍺</div>
      <div className="eyebrow">TEX PUB</div>
      <h1>Entre no Ranking</h1>
      {!done ? <form onSubmit={submit}>
        <label>Seu apelido<input value={name} onChange={e=>setName(e.target.value)} placeholder="Como quer aparecer na TV?" maxLength={28}/></label>
        <label>Sua mesa<input value={table} onChange={e=>setTable(e.target.value)} placeholder="Ex.: 04" maxLength={12}/></label>
        <button className="primary" disabled={busy}>{busy?'Entrando...':'QUERO PARTICIPAR'}</button>
      </form> : <div className="success"><div>✅</div><h2>Você entrou!</h2><p>Agora seus copos podem ser atualizados pela equipe.</p><a href="/ranking">Ver ranking</a></div>}
    </div>
  </Shell>
}

function Home() {
  return <Shell className="home-shell"><div className="home-card"><div className="brandmark">TEX</div><h1>Ranking do Copo</h1><a href="/admin">Painel do garçom</a><a href="/ranking">Tela da TV</a><a href="/entrar">Cadastro do cliente</a></div></Shell>
}

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const Component = path === '/admin' ? Admin : path === '/ranking' ? Ranking : path === '/entrar' ? Join : Home;

createRoot(document.getElementById('root')).render(<Component />);
