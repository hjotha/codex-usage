const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const LOCAL_STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const LOCAL_HISTORY_JSONL = path.join(CODEX_HOME, "history.jsonl");

const PLAN_PROFILES = [
  {
    id: "api-only",
    name: "Seguir no pay-as-you-go",
    monthlyPriceUsd: 0,
    monthlyCostCeilingUsd: 15,
    monthlyRequestsCeiling: 150,
    description:
      "Uso baixo ou esporadico. Mantem flexibilidade e evita pagar assinatura fixa desnecessaria."
  },
  {
    id: "plus",
    name: "Plus / equivalente",
    monthlyPriceUsd: 20,
    monthlyCostCeilingUsd: 60,
    monthlyRequestsCeiling: 800,
    description:
      "Faz sentido quando seu custo recorrente ja supera uma faixa baixa e o uso do Codex e consistente."
  },
  {
    id: "pro",
    name: "Pro / equivalente",
    monthlyPriceUsd: 200,
    monthlyCostCeilingUsd: 300,
    monthlyRequestsCeiling: 4000,
    description:
      "Indicado quando o uso e muito frequente e um plano mais alto tende a reduzir atrito operacional."
  },
  {
    id: "business",
    name: "Business / equipe",
    monthlyPriceUsd: 25,
    monthlyCostCeilingUsd: 1000,
    monthlyRequestsCeiling: 10000,
    description:
      "Perfil para uso organizacional consolidado, varias chaves/projetos e necessidade de governanca."
  }
];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath);
    const contentType =
      extension === ".html"
        ? "text/html; charset=utf-8"
        : extension === ".css"
          ? "text/css; charset=utf-8"
          : extension === ".js"
            ? "application/javascript; charset=utf-8"
            : "text/plain; charset=utf-8";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function fromMonthsBack(months) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  date.setUTCMonth(date.getUTCMonth() - months + 1);
  return date;
}

function isCodexModel(modelName) {
  if (!modelName) {
    return false;
  }

  const normalized = String(modelName).toLowerCase();
  return normalized.includes("codex");
}

async function fetchOpenAI(pathname, query) {
  if (!OPENAI_ADMIN_KEY) {
    throw new Error("Defina OPENAI_ADMIN_KEY para consultar os endpoints da organizacao.");
  }

  const url = new URL(`${OPENAI_BASE_URL}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, item));
      return;
    }

    url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_ADMIN_KEY}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Erro OpenAI ${response.status}: ${text}`);
  }

  return response.json();
}

async function fetchAllBuckets(pathname, baseQuery) {
  const items = [];
  let page;

  do {
    const payload = await fetchOpenAI(pathname, { ...baseQuery, page });
    items.push(...(payload.data || []));
    page = payload.has_more ? payload.next_page : undefined;
  } while (page);

  return items;
}

async function fetchBucketsInWindows(pathname, baseQuery, maxDaysPerWindow = 31) {
  const windowSeconds = maxDaysPerWindow * 24 * 60 * 60;
  const items = [];
  let cursor = Number(baseQuery.start_time);
  const finalEnd = Number(baseQuery.end_time);

  while (cursor < finalEnd) {
    const windowEnd = Math.min(finalEnd, cursor + windowSeconds);
    const payload = await fetchOpenAI(pathname, {
      ...baseQuery,
      start_time: cursor,
      end_time: windowEnd,
      limit: maxDaysPerWindow
    });

    items.push(...(payload.data || []));
    cursor = windowEnd;
  }

  return items;
}

function emptyMonthSummary(monthKey) {
  return {
    month: monthKey,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCostUsd: 0,
    models: new Set(),
    projects: new Set()
  };
}

function monthKeyFromUnix(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7);
}

function aggregateUsage(usageBuckets, costBuckets) {
  const months = new Map();

  for (const bucket of usageBuckets) {
    const monthKey = monthKeyFromUnix(bucket.start_time);
    const month = months.get(monthKey) || emptyMonthSummary(monthKey);

    for (const result of bucket.results || bucket.result || []) {
      if (!isCodexModel(result.model)) {
        continue;
      }

      month.requests += result.num_model_requests || 0;
      month.inputTokens += result.input_tokens || 0;
      month.outputTokens += result.output_tokens || 0;
      month.cachedTokens += result.input_cached_tokens || 0;

      if (result.model) {
        month.models.add(result.model);
      }

      if (result.project_id) {
        month.projects.add(result.project_id);
      }
    }

    months.set(monthKey, month);
  }

  for (const bucket of costBuckets) {
    const monthKey = monthKeyFromUnix(bucket.start_time);
    const month = months.get(monthKey) || emptyMonthSummary(monthKey);

    for (const result of bucket.results || bucket.result || []) {
      const lineItem = String(result.line_item || "").toLowerCase();
      const projectId = result.project_id || "";
      const projectMatches =
        !projectId || month.projects.size === 0 || month.projects.has(projectId);

      if (!projectMatches) {
        continue;
      }

      if (lineItem.includes("codex") || lineItem.includes("gpt-5") || lineItem.includes("model")) {
        month.totalCostUsd += Number(result.amount?.value || 0);
      }
    }

    months.set(monthKey, month);
  }

  return Array.from(months.values())
    .map((month) => ({
      month: month.month,
      requests: month.requests,
      inputTokens: month.inputTokens,
      outputTokens: month.outputTokens,
      cachedTokens: month.cachedTokens,
      totalCostUsd: Number(month.totalCostUsd.toFixed(4)),
      models: Array.from(month.models).sort(),
      projects: Array.from(month.projects).sort()
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function average(numbers) {
  if (!numbers.length) {
    return 0;
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function buildMonthRange(monthsBack) {
  const months = [];
  const cursor = fromMonthsBack(monthsBack);
  const end = new Date();

  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

function runPythonJson(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-c", script, ...args], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`Falha ao interpretar saida Python: ${parseError.message}`));
      }
    });
  });
}

function recommendPlan(months) {
  const activeMonths = months.filter(
    (month) =>
      month.requests > 0 ||
      month.totalCostUsd > 0 ||
      (month.inputTokens || 0) + (month.outputTokens || 0) > 0
  );

  if (!activeMonths.length) {
    return {
      recommendedPlanId: "api-only",
      confidence: "baixa",
      rationale: [
        "Nao ha uso suficiente de Codex identificado nos meses consultados.",
        "Sem um padrao recorrente, pagar uma assinatura fixa tende a ser desperdicio."
      ],
      comparedPlans: PLAN_PROFILES
    };
  }

  const avgMonthlyCost = average(activeMonths.map((month) => month.totalCostUsd));
  const avgMonthlyRequests = average(activeMonths.map((month) => month.requests));
  const peakMonthlyRequests = Math.max(...activeMonths.map((month) => month.requests));
  const peakMonthlyCost = Math.max(...activeMonths.map((month) => month.totalCostUsd));
  const avgMonthlyTokens = average(
    activeMonths.map((month) => (month.inputTokens || 0) + (month.outputTokens || 0))
  );
  const peakMonthlyTokens = Math.max(
    ...activeMonths.map((month) => (month.inputTokens || 0) + (month.outputTokens || 0))
  );

  const scored = PLAN_PROFILES.map((plan) => {
    const costGap = Math.max(0, avgMonthlyCost - plan.monthlyCostCeilingUsd);
    const requestGap = Math.max(0, peakMonthlyRequests - plan.monthlyRequestsCeiling);
    const tokenPressure = peakMonthlyTokens > 0 ? peakMonthlyTokens / 1_000_000 : 0;
    const fixedCostPenalty = plan.monthlyPriceUsd > avgMonthlyCost * 1.5 ? 20 : 0;
    const businessPenalty = plan.id === "business" && peakMonthlyRequests < 3000 ? 18 : 0;
    const score =
      costGap * 2 +
      requestGap / 40 +
      tokenPressure / Math.max(1, plan.monthlyRequestsCeiling / 200) +
      fixedCostPenalty +
      businessPenalty;

    return { ...plan, score };
  }).sort((a, b) => a.score - b.score || a.monthlyPriceUsd - b.monthlyPriceUsd);

  const best = scored[0];
  const rationale = [
    `Media mensal de requisicoes: ${Math.round(avgMonthlyRequests)}; pico mensal: ${peakMonthlyRequests}.`,
    `Media mensal de tokens observados: ${Math.round(avgMonthlyTokens).toLocaleString("pt-BR")}; pico mensal: ${Math.round(peakMonthlyTokens).toLocaleString("pt-BR")}.`
  ];

  if (peakMonthlyCost > 0 || avgMonthlyCost > 0) {
    rationale.unshift(`Custo medio mensal estimado de Codex: US$ ${avgMonthlyCost.toFixed(2)}.`);
    rationale.push(`Maior gasto mensal observado: US$ ${peakMonthlyCost.toFixed(2)}.`);
  } else {
    rationale.push("Como este modo usa apenas dados locais do Codex, nao existe custo oficial associado por mes neste relatorio.");
  }

  if (best.id === "api-only") {
    rationale.push("Seu padrao atual parece baixo o bastante para manter cobranca por uso.");
  } else {
    rationale.push(
      "Seu uso recorrente sugere que um plano fixo pode reduzir custo previsivel ou atrito de limite."
    );
  }

  return {
    recommendedPlanId: best.id,
    confidence: activeMonths.length >= 3 ? "media" : "baixa",
    rationale,
    comparedPlans: scored
  };
}

async function buildLocalReport(monthsBack) {
  const pythonScript = `
import json, sqlite3, sys
from collections import defaultdict
from datetime import datetime, timezone

db_path, history_path, months_back = sys.argv[1], sys.argv[2], int(sys.argv[3])
now = datetime.now(timezone.utc)
start_year = now.year
start_month = now.month - months_back + 1
while start_month <= 0:
    start_month += 12
    start_year -= 1
start = datetime(start_year, start_month, 1, tzinfo=timezone.utc)
start_ts = int(start.timestamp())

months = {}
day_activity = defaultdict(int)
all_cwds = set()
providers = set()
session_ids = set()

def month_key(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")

conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("""
    SELECT id, created_at, updated_at, source, model_provider, cwd, title, COALESCE(tokens_used, 0)
    FROM threads
    WHERE created_at >= ?
    ORDER BY created_at
""", (start_ts,))
for thread_id, created_at, updated_at, source, model_provider, cwd, title, tokens_used in cur.fetchall():
    key = month_key(created_at)
    month = months.setdefault(key, {
        "month": key,
        "sessions": 0,
        "requests": 0,
        "tokensUsed": 0,
        "activeDays": set(),
        "models": set(),
        "projects": set(),
        "sampleTitles": []
    })
    month["sessions"] += 1
    month["tokensUsed"] += int(tokens_used or 0)
    if model_provider:
        month["models"].add(model_provider)
        providers.add(model_provider)
    if cwd:
        month["projects"].add(cwd)
        all_cwds.add(cwd)
    if title and len(month["sampleTitles"]) < 3:
        month["sampleTitles"].append(title[:140])
    day = datetime.fromtimestamp(created_at, timezone.utc).strftime("%Y-%m-%d")
    month["activeDays"].add(day)
    day_activity[day] += 1
    session_ids.add(thread_id)
conn.close()

try:
    with open(history_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            ts = int(row.get("ts", 0))
            if ts < start_ts:
                continue
            key = month_key(ts)
            month = months.setdefault(key, {
                "month": key,
                "sessions": 0,
                "requests": 0,
                "tokensUsed": 0,
                "activeDays": set(),
                "models": set(),
                "projects": set(),
                "sampleTitles": []
            })
            month["requests"] += 1
            day = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
            month["activeDays"].add(day)
            day_activity[day] += 0
except FileNotFoundError:
    pass

result_months = []
for month in months.values():
    result_months.append({
        "month": month["month"],
        "sessions": month["sessions"],
        "requests": month["requests"],
        "inputTokens": 0,
        "outputTokens": month["tokensUsed"],
        "cachedTokens": 0,
        "totalCostUsd": 0,
        "models": sorted(month["models"]),
        "projects": sorted(month["projects"]),
        "activeDays": len(month["activeDays"]),
        "sampleTitles": month["sampleTitles"]
    })

print(json.dumps({
    "months": sorted(result_months, key=lambda item: item["month"]),
    "totals": {
        "distinctProjects": sorted(all_cwds),
        "providers": sorted(providers),
        "sessionCount": len(session_ids),
        "activeDays": len(day_activity)
    }
}))
`;

  const localData = await runPythonJson(pythonScript, [LOCAL_STATE_DB, LOCAL_HISTORY_JSONL, String(monthsBack)]);
  const monthRange = buildMonthRange(monthsBack);
  const monthMap = new Map(localData.months.map((month) => [month.month, month]));
  const months = monthRange.map(
    (monthKey) =>
      monthMap.get(monthKey) || {
        month: monthKey,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalCostUsd: 0,
        models: [],
        projects: [],
        activeDays: 0,
        sampleTitles: []
      }
  );

  const recommendation = recommendPlan(months);

  return {
    generatedAt: new Date().toISOString(),
    source: "local",
    machine: os.hostname(),
    period: {
      monthsBack,
      start: fromMonthsBack(monthsBack).toISOString(),
      end: new Date().toISOString()
    },
    plans: PLAN_PROFILES,
    months,
    recommendation,
    totals: localData.totals,
    notes: [
      "Este relatorio usa os arquivos locais do Codex nesta maquina, principalmente ~/.codex/state_5.sqlite e ~/.codex/history.jsonl.",
      "Para contas com assinatura ChatGPT, esse caminho local e a forma mais confiavel de medir seu uso real do Codex CLI sem depender de endpoints de organizacao da API.",
      "Nao existe, ate onde a documentacao publica mostra, uma API oficial para pegar o uso total do Codex da sua assinatura ChatGPT entre todas as maquinas e contas automaticamente."
    ]
  };
}

async function buildUsageReport(monthsBack) {
  const startDate = fromMonthsBack(monthsBack);
  const endDate = new Date();
  const baseQuery = {
    start_time: toUnixSeconds(startDate),
    end_time: toUnixSeconds(endDate),
    bucket_width: "1d",
    group_by: ["model", "project_id"]
  };

  const [usageBuckets, costBuckets] = await Promise.all([
    fetchBucketsInWindows("/organization/usage/completions", baseQuery),
    fetchBucketsInWindows("/organization/costs", {
      start_time: baseQuery.start_time,
      end_time: baseQuery.end_time,
      bucket_width: "1d",
      group_by: ["project_id", "line_item"]
    })
  ]);

  const months = aggregateUsage(usageBuckets, costBuckets);
  const recommendation = recommendPlan(months);

  return {
    generatedAt: new Date().toISOString(),
    period: {
      monthsBack,
      start: startDate.toISOString(),
      end: endDate.toISOString()
    },
    plans: PLAN_PROFILES,
    months,
    recommendation,
    notes: [
      "A OpenAI expoe endpoints oficiais de usage e costs da organizacao, que permitem consolidar uso entre maquinas quando todas usam a mesma organizacao/projeto.",
      "A recomendacao de assinatura e heuristica. Os limites reais de planos ChatGPT/Codex nao sao expostos por esta API.",
      "Se voce usa maquinas com organizacoes ou contas diferentes, este dashboard so enxerga o escopo da chave administrativa informada."
    ]
  };
}

const publicDir = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      hasAdminKey: Boolean(OPENAI_ADMIN_KEY)
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/report") {
    const monthsBack = Math.max(1, Math.min(24, Number(requestUrl.searchParams.get("months") || 6)));

    try {
      const report = await buildUsageReport(monthsBack);
      sendJson(res, 200, report);
    } catch (error) {
      sendJson(res, 500, {
        error: error.message,
        hint:
          "Verifique OPENAI_ADMIN_KEY e confirme que a chave possui acesso aos endpoints de uso/custo da organizacao."
      });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/local-report") {
    const monthsBack = Math.max(1, Math.min(24, Number(requestUrl.searchParams.get("months") || 6)));

    try {
      const report = await buildLocalReport(monthsBack);
      sendJson(res, 200, report);
    } catch (error) {
      sendJson(res, 500, {
        error: error.message,
        hint: "Verifique se os arquivos locais do Codex existem em ~/.codex e se podem ser lidos."
      });
    }
    return;
  }

  if (req.method === "GET") {
    const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
    sendFile(res, path.join(publicDir, safePath));
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Codex Usage app em http://localhost:${PORT}`);
});
