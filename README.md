# Tex Ranking do Copo V2

V2 conectada ao Firebase/Cloud Firestore do projeto `ranking-tv-pub`.

Rotas:
- `/admin` painel do garçom
- `/ranking` TV
- `/entrar` cadastro do cliente

O cadastro salva apelido, mesa, cerveja e copos em `ranking_days/{AAAA-MM-DD}/participants`.
As três telas usam listener em tempo real do Firestore.

## Deploy
Suba o conteúdo desta pasta na raiz do GitHub e faça Redeploy na Vercel.
Não é necessário configurar variáveis de ambiente nesta versão.
