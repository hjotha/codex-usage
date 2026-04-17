# Codex Usage Analyzer

Aplicacao local para analisar o uso do Codex e do Claude Code nesta maquina ou em snapshots importados de varias maquinas e estimar qual plano faz mais sentido com base no historico real do CLI.

## Modo principal

O projeto opera apenas em modo local/snapshots:

- le `~/.codex/state_5.sqlite`
- le `~/.codex/history.jsonl`
- agrupa o uso por mes
- mostra sessoes, prompts, tokens e dias ativos
- sugere um plano com base em uma heuristica editavel

Tambem existe o modo consolidado por snapshots do Codex:

- le subpastas em `/home/hjotha/codex-usage/data-snapshots`
- espera `state_5.sqlite` e opcionalmente `history.jsonl` em cada origem
- agrega o uso por mes entre varias maquinas
- ignora snapshots sem base do Codex e lista essas origens nas notas

Para Claude Code:

- le `~/.claude/projects/**/*.jsonl`
- usa `~/.claude/history.jsonl` para completar o intervalo de meses
- extrai tokens por chamada de API, incluindo cache
- agrega por mes e por maquina, inclusive em snapshots importados

## Por que isso existe

Se voce usa Codex com assinatura ChatGPT, o uso pesado do CLI pode nao aparecer em endpoints de billing centralizados. Nesse caso, ler os arquivos locais do Codex e a forma mais fiel de medir o uso real por maquina.

## Limitacao importante

Nao ha, ate onde a documentacao publica mostra hoje, uma API oficial que este projeto possa usar para obter automaticamente o uso total do Codex da sua assinatura ChatGPT consolidado entre varias maquinas.

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
- `GET /api/local-report?months=6&scope=all`
- `GET /api/local-report?months=6&scope=local`
- `GET /api/local-report?months=6&scope=all&machine=all&product=codex`
- `GET /api/local-report?months=6&scope=all&machine=all&product=claude`
- `GET /api/health`

## Estrutura

- `server.js`: servidor HTTP e leitura do historico local
- `public/index.html`: interface
- `public/app.js`: renderizacao do dashboard
- `public/styles.css`: estilo

## Observacoes

- `OPENAI_ADMIN_KEY` nao e mais suportada.
- O dashboard depende apenas de dados locais do Codex/Claude e de snapshots importados.
- A recomendacao de plano e heuristica. Ajuste os perfis em `server.js` conforme sua realidade.
