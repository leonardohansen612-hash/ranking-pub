import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import saiposHandler from './api/saipos.js';
import rankingHandler from './api/ranking.js';

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// API Saipos.
app.get('/api/saipos', saiposHandler);

// API do Ranking do Copo.
// IMPORTANTE: precisa vir antes do express.static e do fallback '*'.
app.get('/api/ranking', rankingHandler);

// Healthcheck simples para o Render.
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'tex-ranking-copo' });
});

// Front-end estático da aplicação.
app.use(express.static(__dirname));

// Mantém a aplicação acessível mesmo em URLs desconhecidas do front-end.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tex Ranking do Copo rodando na porta ${PORT}`);
});
