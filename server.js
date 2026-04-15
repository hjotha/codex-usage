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
const LOCAL_CONFIG_TOML = path.join(CODEX_HOME, "config.toml");
const MODEL_PRICING = {
  "gpt-5.4": {
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15
  }
};

const PLAN_PROFILES = [
  {
    id: "api-only",
    name: "Stay on pay-as-you-go",
    monthlyPriceUsd: 0,
    monthlyCostCeilingUsd: 15,
    monthlyRequestsCeiling: 150,
    description:
      "Low or sporadic usage. Keeps flexibility and avoids paying for a fixed plan too early."
  },
  {
    id: "plus",
    name: "Plus / equivalent",
    monthlyPriceUsd: 20,
    monthlyCostCeilingUsd: 60,
    monthlyRequestsCeiling: 800,
    description:
      "Makes sense when recurring usage is already consistent and above a light-use profile."
  },
  {
    id: "pro",
    name: "Pro / equivalent",
    monthlyPriceUsd: 200,
    monthlyCostCeilingUsd: 300,
    monthlyRequestsCeiling: 4000,
    description:
      "Best fit when usage is very frequent and a higher-tier plan is likely to reduce operational friction."
  },
  {
    id: "business",
    name: "Business / team",
    monthlyPriceUsd: 25,
    monthlyCostCeilingUsd: 1000,
    monthlyRequestsCeiling: 10000,
    description:
      "Intended for team or organization-level usage with multiple projects and governance needs."
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
    throw new Error("Set OPENAI_ADMIN_KEY to query organization usage endpoints.");
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
    throw new Error(`OpenAI error ${response.status}: ${text}`);
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

function getConfiguredModel() {
  try {
    const config = fs.readFileSync(LOCAL_CONFIG_TOML, "utf8");
    const match = config.match(/^model\s*=\s*"([^"]+)"/m);
    return match ? match[1] : "gpt-5.4";
  } catch {
    return "gpt-5.4";
  }
}

function estimatePaygCost(tokensUsed, modelName) {
  const pricing = MODEL_PRICING[modelName] || MODEL_PRICING["gpt-5.4"];
  const conservativeUsd = (tokensUsed / 1_000_000) * pricing.outputPerMillionUsd;
  const optimisticUsd = (tokensUsed / 1_000_000) * pricing.inputPerMillionUsd;
  const midpointUsd = (conservativeUsd + optimisticUsd) / 2;

  return {
    model: modelName,
    pricing,
    optimisticUsd: Number(optimisticUsd.toFixed(4)),
    midpointUsd: Number(midpointUsd.toFixed(4)),
    conservativeUsd: Number(conservativeUsd.toFixed(4))
  };
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
        reject(new Error(`Failed to parse Python output: ${parseError.message}`));
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
      confidence: "low",
      rationale: [
        "There is not enough Codex usage in the selected period to justify a fixed plan.",
        "Without a recurring pattern, paying for a subscription is likely wasteful."
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
    `Average monthly requests: ${Math.round(avgMonthlyRequests)}; monthly peak: ${peakMonthlyRequests}.`,
    `Average observed monthly tokens: ${Math.round(avgMonthlyTokens).toLocaleString("en-US")}; monthly peak: ${Math.round(peakMonthlyTokens).toLocaleString("en-US")}.`
  ];

  if (peakMonthlyCost > 0 || avgMonthlyCost > 0) {
    rationale.unshift(`Estimated average monthly Codex cost: US$ ${avgMonthlyCost.toFixed(2)}.`);
    rationale.push(`Highest observed monthly cost: US$ ${peakMonthlyCost.toFixed(2)}.`);
  } else {
    rationale.push("This local mode does not include official monthly billing data, so cost here is only estimated.");
  }

  if (best.id === "api-only") {
    rationale.push("Your current pattern looks light enough to stay on pay-as-you-go.");
  } else {
    rationale.push(
      "Your recurring usage suggests that a fixed plan could reduce pricing uncertainty and limit friction."
    );
  }

  return {
    recommendedPlanId: best.id,
    confidence: activeMonths.length >= 3 ? "medium" : "low",
    rationale,
    comparedPlans: scored
  };
}

async function buildLocalReport(monthsBack) {
  const configuredModel = getConfiguredModel();
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
    (monthKey) => {
      const month =
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
        };
      month.paygEstimate = estimatePaygCost(month.outputTokens || 0, configuredModel);
      return month;
    }
  );

  const recommendation = recommendPlan(months);
  const totalObservedTokens = months.reduce((sum, month) => sum + (month.outputTokens || 0), 0);
  const paygEstimate = estimatePaygCost(totalObservedTokens, configuredModel);

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
    paygEstimate,
    notes: [
      "This report uses local Codex files from this machine, mainly ~/.codex/state_5.sqlite and ~/.codex/history.jsonl.",
      "For ChatGPT subscription accounts, this local approach is the most reliable way to measure real Codex CLI usage without depending on organization-level API endpoints.",
      `The pay-as-you-go estimate is based on the current official ${configuredModel} pricing: US$ ${paygEstimate.pricing.inputPerMillionUsd.toFixed(2)}/1M input tokens, US$ ${paygEstimate.pricing.cachedInputPerMillionUsd.toFixed(2)}/1M cached input tokens, and US$ ${paygEstimate.pricing.outputPerMillionUsd.toFixed(2)}/1M output tokens.`,
      "Because this machine's local data does not safely separate input and output tokens, the dashboard shows three estimates: optimistic, midpoint, and conservative.",
      "As far as current public documentation shows, there is no official API to automatically fetch total Codex usage for a ChatGPT subscription across all machines and accounts."
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
      "OpenAI exposes official organization usage and cost endpoints, which can consolidate usage across machines when they all belong to the same organization or project.",
      "The plan recommendation is heuristic. Real ChatGPT or Codex plan limits are not exposed by this API.",
      "If you use machines tied to different organizations or accounts, this dashboard only sees the scope available to the configured admin key."
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
          "Check OPENAI_ADMIN_KEY and confirm the key has access to the organization's usage and cost endpoints."
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
        hint: "Check that local Codex files exist under ~/.codex and can be read."
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
  console.log(`Codex Usage app at http://localhost:${PORT}`);
});
