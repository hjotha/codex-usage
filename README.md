# Codex Usage Analyzer

Aplicacao local para analisar o uso do Codex nesta maquina e estimar qual plano faz mais sentido com base no historico real do CLI.

## Modo principal

O modo principal agora e o modo local:

- le `~/.codex/state_5.sqlite`
- le `~/.codex/history.jsonl`
- agrupa o uso por mes
- mostra sessoes, prompts, tokens e dias ativos
- sugere um plano com base em uma heuristica editavel

## Por que isso existe

Se voce usa Codex com assinatura ChatGPT, o uso pesado do CLI pode nao aparecer nos endpoints de billing/usage de uma organizacao da API. Nesse caso, ler os arquivos locais do Codex e a forma mais fiel de medir o uso real por maquina.

## Limitacao importante

Nao ha, ate onde a documentacao publica da OpenAI mostra hoje, uma API oficial para obter automaticamente o uso total do Codex da sua assinatura ChatGPT consolidado entre varias maquinas.

Entao a estrategia correta para expandir este projeto no futuro e:

1. gerar um snapshot local por maquina
2. importar esses snapshots para um painel central
3. agregar tudo por mes/maquina/projeto

## Como rodar

```bash
npm start
```

Abra `http://localhost:3000`.

## Endpoints

- `GET /api/local-report?months=6`
- `GET /api/health`

## Estrutura

- `server.js`: servidor HTTP e leitura do historico local
- `public/index.html`: interface
- `public/app.js`: renderizacao do dashboard
- `public/styles.css`: estilo

## Observacoes

- `OPENAI_ADMIN_KEY` continua suportada para experimentos com endpoints de organizacao, mas nao e o caminho principal para assinatura ChatGPT.
- A recomendacao de plano e heuristica. Ajuste os perfis em `server.js` conforme sua realidade.
