# Tex Pub — Ranking do Copo V1

Sistema simples para testar um ranking diário em tempo real.

## Telas

- `/admin` — painel do garçom: adicionar participante, +1, -1, remover e zerar o dia.
- `/ranking` — tela para a TV, atualizada em tempo real.
- `/entrar` — cadastro do cliente por apelido/mesa.

## 1. Firebase

1. Abra seu projeto no Firebase.
2. Ative **Firestore Database**.
3. Em **Configurações do projeto > Seus apps**, crie/abra um app Web.
4. Copie os valores do `firebaseConfig`.

## 2. Variáveis na Vercel

Crie estas variáveis no projeto Vercel:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

Use o arquivo `.env.example` como referência.

## 3. Regras do Firestore — SOMENTE PARA TESTE INICIAL

Para a V1 funcionar sem login, você pode usar temporariamente regras abertas durante o teste interno:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /ranking_days/{day}/participants/{participant} {
      allow read, write: if true;
    }
  }
}
```

IMPORTANTE: essas regras são deliberadamente simples para o teste V1. Antes de deixar o link público de forma permanente, adicione autenticação/regras mais restritivas.

## 4. Rodar localmente

```bash
npm install
npm run dev
```

## 5. Deploy

Suba os arquivos para um repositório GitHub e importe o repositório na Vercel.
Depois adicione as variáveis de ambiente e faça o deploy.

## Operação sugerida

1. TV abre `/ranking` em tela cheia.
2. Garçom mantém `/admin` aberto no celular.
3. Cliente pode entrar por `/entrar` ou ser cadastrado pelo garçom.
4. A cada copo contabilizado, o garçom toca `+1 COPO`.
5. O ranking reordena automaticamente.
6. Quando muda o líder, a TV mostra `NOVO LÍDER!`.

