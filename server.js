import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import rankingHandler from './api/ranking.js';
import saiposDiagnosticoHandler from './api/saipos-diagnostico.js';
import saiposCatalogoHml from './api/saipos-catalogo-hml.js';
import saiposAuthDiagnostico from './api/saipos-auth-diagnostico.js';
import { saiposWebhookPost, saiposWebhookStatus } from './api/saipos-webhook.js';

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Webhook Saipos: captura diagnostica em tempo real.
app.post('/api/saipos-webhook', saiposWebhookPost);
app.get('/api/saipos-webhook', saiposWebhookStatus);

// API do Ranking do Copo
app.get('/api/ranking', rankingHandler);

// Diagnóstico temporário da Data API Saipos
app.get('/api/saipos-diagnostico', saiposDiagnosticoHandler);

// Catálogo da loja HML da API de Pedidos (somente leitura)
app.get('/api/saipos-catalogo-hml', saiposCatalogoHml);

// Diagnóstico isolado da autenticação da Order API
app.get('/api/saipos-auth-diagnostico', saiposAuthDiagnostico);

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
