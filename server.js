import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import rankingHandler from './api/ranking.js';
import backfillHandler from './api/backfill.js';
import utcHourTestHandler from './api/utc-hour-test.js';
import saiposWebhookHandler from './api/saipos-webhook.js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req,res)=>res.status(200).json({ok:true,service:'ranking-pub',platform:'render'}));

app.all('/api/ranking', rankingHandler);
app.all('/api/backfill', backfillHandler);
app.all('/api/utc-hour-test', utcHourTestHandler);
app.all('/api/saipos-webhook', saiposWebhookHandler);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname,'dist');
app.use(express.static(distPath));
app.get(/.*/, (req,res)=>res.sendFile(path.join(distPath,'index.html')));

app.listen(PORT,'0.0.0.0',()=>console.log(`Ranking Pub rodando na porta ${PORT}`));
