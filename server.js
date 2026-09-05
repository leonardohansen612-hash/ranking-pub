import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import rankingHandler from './api/ranking.js';

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// API do Ranking do Copo
app.get('/api/ranking', rankingHandler);

// Healthcheck
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'ranking-pub' });
});

// Front-end estático
app.use(express.static(__dirname));

// Fallback do front-end — precisa vir DEPOIS das rotas /api
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ranking do Copo rodando na porta ${PORT}`);
});
