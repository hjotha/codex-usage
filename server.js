const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const LOCAL_STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const LOCAL_HISTORY_JSONL = path.join(CODEX_HOME, "history.jsonl");
const LOCAL_CONFIG_TOML = path.join(CODEX_HOME, "config.toml");
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
const CLAUDE_HISTORY_JSONL = path.join(CLAUDE_HOME, "history.jsonl");
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions");
const MODEL_PRICING = {
  "gpt-5.4": {
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15
  },
  "claude-opus-4-6": {
    inputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.5,
    cacheCreationPerMillionUsd: 6.25,
    outputPerMillionUsd: 25
  },
  "claude-sonnet-4-5-20250929": {
    inputPerMillionUsd: 3,
    cachedInputPerMillionUsd: 0.3,
    cacheCreationPerMillionUsd: 3.75,
    outputPerMillionUsd: 15
  },
  "claude-sonnet-4-6": {
    inputPerMillionUsd: 3,
    cachedInputPerMillionUsd: 0.3,
    cacheCreationPerMillionUsd: 3.75,
    outputPerMillionUsd: 15
  },
  "claude-haiku-4-5-20251001": {
    inputPerMillionUsd: 1,
    cachedInputPerMillionUsd: 0.1,
    cacheCreationPerMillionUsd: 1.25,
    outputPerMillionUsd: 5
  }
};
const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR || path.join(__dirname, "data-snapshots");
const ASSUME_TEAM_WORKSPACE = /^(1|true|yes)$/i.test(process.env.ASSUME_TEAM_WORKSPACE || "");

const CODEX_PLAN_PROFILES = [
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

const CLAUDE_PLAN_PROFILES = [
  {
    id: "api-only",
    name: "API pay-as-you-go",
    monthlyPriceUsd: 0,
    monthlyCostCeilingUsd: 20,
    monthlyRequestsCeiling: 200,
    description:
      "Direct API billing with no subscription. Best for light or experimental usage."
  },
  {
    id: "pro",
    name: "Claude Pro",
    monthlyPriceUsd: 20,
    monthlyCostCeilingUsd: 60,
    monthlyRequestsCeiling: 2000,
    description:
      "Standard Claude subscription. Good for regular usage with higher rate limits than free tier."
  },
  {
    id: "max-5x",
    name: "Claude Max 5x",
    monthlyPriceUsd: 100,
    monthlyCostCeilingUsd: 250,
    monthlyRequestsCeiling: 7500,
    description:
      "5x the usage of Pro. For heavy daily usage with extended thinking and Opus access."
  },
  {
    id: "max-20x",
    name: "Claude Max 20x",
    monthlyPriceUsd: 200,
    monthlyCostCeilingUsd: 800,
    monthlyRequestsCeiling: 30000,
    description:
      "20x the usage of Pro. Maximum tier for power users who need very high throughput."
  }
];

const PLAN_PROFILES = CODEX_PLAN_PROFILES;

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

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function fromMonthsBack(months) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  date.setUTCMonth(date.getUTCMonth() - months + 1);
  return date;
}

function average(numbers) {
  if (!numbers.length) {
    return 0;
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function getConfiguredModel(configPath = LOCAL_CONFIG_TOML) {
  try {
    const config = fs.readFileSync(configPath, "utf8");
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

function estimateClaudePaygCost(tokenBreakdown) {
  let totalUsd = 0;
  for (const [model, tokens] of Object.entries(tokenBreakdown)) {
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-5-20250929"];
    totalUsd +=
      (tokens.input / 1_000_000) * pricing.inputPerMillionUsd +
      (tokens.output / 1_000_000) * pricing.outputPerMillionUsd +
      (tokens.cacheCreation / 1_000_000) * (pricing.cacheCreationPerMillionUsd || pricing.inputPerMillionUsd * 1.25) +
      (tokens.cacheRead / 1_000_000) * pricing.cachedInputPerMillionUsd;
  }
  return Number(totalUsd.toFixed(4));
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

function recommendPlan(months, planProfiles = CODEX_PLAN_PROFILES) {
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
        "There is not enough usage in the selected period to justify a fixed plan.",
        "Without a recurring pattern, paying for a subscription is likely wasteful."
      ],
      comparedPlans: planProfiles
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

  const scored = planProfiles.map((plan) => {
    const costGap = Math.max(0, avgMonthlyCost - plan.monthlyCostCeilingUsd);
    const requestGap = Math.max(0, peakMonthlyRequests - plan.monthlyRequestsCeiling);
    const tokenPressure = peakMonthlyTokens > 0 ? peakMonthlyTokens / 1_000_000 : 0;
    const fixedCostPenalty = plan.monthlyPriceUsd > avgMonthlyCost * 1.5 ? 20 : 0;
    const businessPenalty =
      plan.id !== "business"
        ? 0
        : (ASSUME_TEAM_WORKSPACE ? 0 : 120) + (peakMonthlyRequests < 3000 ? 18 : 0);
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
    rationale.unshift(`Estimated average monthly cost: US$ ${avgMonthlyCost.toFixed(2)}.`);
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

  if (!ASSUME_TEAM_WORKSPACE) {
    rationale.push("Workspace or team plans receive an extra penalty in this heuristic by default.");
  }

  return {
    recommendedPlanId: best.id,
    confidence: activeMonths.length >= 3 ? "medium" : "low",
    rationale,
    comparedPlans: scored
  };
}

async function buildLocalReport(monthsBack) {
  return buildSnapshotReportFromSource({
    id: os.hostname(),
    machine: os.hostname(),
    dbPath: LOCAL_STATE_DB,
    historyPath: LOCAL_HISTORY_JSONL,
    configPath: LOCAL_CONFIG_TOML
  }, monthsBack);
}

async function buildClaudeReportFromSource(claudeHomePath, machineName, monthsBack) {
  const pythonScript = `
import json, sys, os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

claude_home, months_back, machine_name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
now = datetime.now(timezone.utc)
start_year = now.year
start_month = now.month - months_back + 1
while start_month <= 0:
    start_month += 12
    start_year -= 1
start = datetime(start_year, start_month, 1, tzinfo=timezone.utc)
start_iso = start.isoformat()

months = {}
day_activity = defaultdict(int)
projects = set()
session_ids = set()

def month_key_from_iso(ts_str):
    return ts_str[:7]

def ensure_month(key):
    return months.setdefault(key, {
        "month": key,
        "sessions": 0,
        "requests": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "activeDays": set(),
        "models": set(),
        "projects": set(),
        "sampleTitles": [],
        "tokensByModel": defaultdict(lambda: {"input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0})
    })

projects_dir = Path(claude_home) / "projects"
if projects_dir.exists():
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for session_file in project_dir.glob("*.jsonl"):
            session_id = session_file.stem
            session_first_ts = None
            session_cwd = None
            session_title = None
            session_user_msgs = 0
            session_month = None

            try:
                with open(session_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            row = json.loads(line)
                        except Exception:
                            continue

                        row_type = row.get("type", "")
                        ts = row.get("timestamp", "")

                        if not ts or ts < start_iso:
                            if row_type in ("assistant", "user") and not ts:
                                pass
                            elif ts and ts < start_iso:
                                continue

                        if row_type == "user":
                            if not session_first_ts and ts:
                                session_first_ts = ts
                                session_month = month_key_from_iso(ts)
                            session_user_msgs += 1
                            cwd = row.get("cwd", "")
                            if cwd:
                                session_cwd = cwd
                            msg_content = row.get("message", {}).get("content", "")
                            if isinstance(msg_content, str) and msg_content.strip() and not session_title:
                                session_title = msg_content.strip()[:140]

                        elif row_type == "assistant":
                            msg = row.get("message", {})
                            usage = msg.get("usage", {})
                            model = msg.get("model", "")
                            if not usage:
                                continue
                            if not ts:
                                continue
                            if ts < start_iso:
                                continue

                            key = month_key_from_iso(ts)
                            month = ensure_month(key)

                            input_t = usage.get("input_tokens", 0) or 0
                            output_t = usage.get("output_tokens", 0) or 0
                            cache_create = usage.get("cache_creation_input_tokens", 0) or 0
                            cache_read = usage.get("cache_read_input_tokens", 0) or 0

                            month["inputTokens"] += input_t
                            month["outputTokens"] += output_t
                            month["cacheCreationTokens"] += cache_create
                            month["cacheReadTokens"] += cache_read
                            month["requests"] += 1

                            if model and not model.startswith("<"):
                                month["models"].add(model)
                                by_model = month["tokensByModel"][model]
                                by_model["input"] += input_t
                                by_model["output"] += output_t
                                by_model["cacheCreation"] += cache_create
                                by_model["cacheRead"] += cache_read

                            day = ts[:10]
                            month["activeDays"].add(day)
                            day_activity[day] += 1

            except Exception:
                continue

            if session_first_ts and session_month:
                month = ensure_month(session_month)
                month["sessions"] += 1
                session_ids.add(f"{machine_name}:{session_id}")
                if session_cwd:
                    month["projects"].add(session_cwd)
                    projects.add(session_cwd)
                if session_title and len(month["sampleTitles"]) < 3 and session_title not in month["sampleTitles"]:
                    month["sampleTitles"].append(session_title)
                day = session_first_ts[:10]
                month["activeDays"].add(day)
                day_activity[day] += 1

history_path = Path(claude_home) / "history.jsonl"
if history_path.exists():
    with open(history_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            ts = row.get("timestamp", 0)
            if isinstance(ts, (int, float)):
                ts_ms = int(ts)
                dt = datetime.fromtimestamp(ts_ms / 1000, timezone.utc)
                ts_iso = dt.isoformat()
            else:
                ts_iso = str(ts)
            if ts_iso < start_iso:
                continue
            key = month_key_from_iso(ts_iso)
            ensure_month(key)

result_months = []
for month in months.values():
    tokens_by_model = {}
    for model, t in month["tokensByModel"].items():
        tokens_by_model[model] = dict(t)
    result_months.append({
        "month": month["month"],
        "sessions": month["sessions"],
        "requests": month["requests"],
        "inputTokens": month["inputTokens"],
        "outputTokens": month["outputTokens"],
        "cacheCreationTokens": month["cacheCreationTokens"],
        "cacheReadTokens": month["cacheReadTokens"],
        "totalCostUsd": 0,
        "models": sorted(month["models"]),
        "projects": sorted(month["projects"]),
        "activeDays": len(month["activeDays"]),
        "activeDayKeys": sorted(month["activeDays"]),
        "sampleTitles": month["sampleTitles"],
        "tokensByModel": tokens_by_model
    })

print(json.dumps({
    "machine": machine_name,
    "months": sorted(result_months, key=lambda item: item["month"]),
    "totals": {
        "distinctProjects": sorted(projects),
        "providers": ["claude-code"],
        "sessionCount": len(session_ids),
        "activeDays": len(day_activity),
        "activeDayKeys": sorted(day_activity.keys())
    }
}))
`;

  const localData = await runPythonJson(pythonScript, [
    claudeHomePath,
    String(monthsBack),
    machineName
  ]);
  const monthRange = buildMonthRange(monthsBack);
  const monthMap = new Map(localData.months.map((month) => [month.month, month]));
  const months = monthRange.map((monthKey) => {
    const month =
      monthMap.get(monthKey) || {
        month: monthKey,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cachedTokens: 0,
        totalCostUsd: 0,
        models: [],
        projects: [],
        activeDays: 0,
        activeDayKeys: [],
        sampleTitles: [],
        tokensByModel: {}
      };

    month.cachedTokens = month.cacheReadTokens || 0;
    const costUsd = estimateClaudePaygCost(month.tokensByModel || {});
    month.totalCostUsd = costUsd;
    month.paygEstimate = {
      optimisticUsd: costUsd,
      midpointUsd: costUsd,
      conservativeUsd: costUsd
    };
    return month;
  });

  const recommendation = recommendPlan(months, CLAUDE_PLAN_PROFILES);
  const totalCostUsd = months.reduce((sum, month) => sum + month.totalCostUsd, 0);
  const totalTokens = months.reduce(
    (sum, month) => sum + (month.inputTokens || 0) + (month.outputTokens || 0) + (month.cacheCreationTokens || 0) + (month.cacheReadTokens || 0),
    0
  );

  const pricingSummary = Object.entries(MODEL_PRICING)
    .filter(([key]) => key.startsWith("claude"))
    .map(([model, p]) =>
      `${model}: $${p.inputPerMillionUsd}/1M input, $${p.cachedInputPerMillionUsd}/1M cached read, $${p.cacheCreationPerMillionUsd || "n/a"}/1M cache write, $${p.outputPerMillionUsd}/1M output`
    )
    .join("; ");

  return {
    generatedAt: new Date().toISOString(),
    source: "claude-local",
    product: "claude",
    machine: machineName,
    period: {
      monthsBack,
      start: fromMonthsBack(monthsBack).toISOString(),
      end: new Date().toISOString()
    },
    plans: CLAUDE_PLAN_PROFILES,
    months,
    recommendation,
    totals: localData.totals,
    paygEstimate: {
      optimisticUsd: Number(totalCostUsd.toFixed(4)),
      midpointUsd: Number(totalCostUsd.toFixed(4)),
      conservativeUsd: Number(totalCostUsd.toFixed(4))
    },
    machines: [
      {
        machine: machineName,
        status: "ok",
        sessions: months.reduce((sum, month) => sum + (month.sessions || 0), 0),
        requests: months.reduce((sum, month) => sum + (month.requests || 0), 0),
        tokens: totalTokens
      }
    ],
    machineOptions: [],
    notes: [
      `This report reads Claude Code session files from ${machineName}.`,
      "Token usage is extracted per API call from each session's JSONL file, broken down by model (input, output, cache creation, cache read).",
      `PAYG cost is estimated using official API pricing: ${pricingSummary}.`,
      "Claude Code subscription plans (Max) have different pricing from API. This estimate shows what the same usage would cost on pay-as-you-go API billing.",
      "The token counts include prompt caching. Cached reads are significantly cheaper than fresh input tokens."
    ]
  };
}

function listClaudeSnapshotSources() {
  if (!fileExists(SNAPSHOTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(SNAPSHOTS_DIR, entry.name);
      const claudeProjectsDir = path.join(dirPath, ".claude", "projects");
      const hasClaudeProjects = fileExists(claudeProjectsDir);
      const statusPath = path.join(dirPath, "STATUS.txt");
      const status = fileExists(statusPath)
        ? fs.readFileSync(statusPath, "utf-8").trim() || "status-unknown"
        : "";

      return {
        id: entry.name,
        machine: entry.name,
        dirPath,
        claudeHome: path.join(dirPath, ".claude"),
        hasClaudeProjects,
        available: hasClaudeProjects,
        status: hasClaudeProjects ? "ok" : status || "missing-claude-data"
      };
    });
}

function buildClaudeMachineOptions(includeLocal = true) {
  const options = [];
  const seen = new Set();

  if (includeLocal) {
    const localMachine = os.hostname();
    options.push({ machine: localMachine, source: "local", available: true });
    seen.add(localMachine);
  }

  for (const source of listClaudeSnapshotSources()) {
    if (seen.has(source.machine)) {
      continue;
    }

    options.push({
      machine: source.machine,
      source: "snapshot",
      available: source.available,
      status: source.status
    });
    seen.add(source.machine);
  }

  return options;
}

async function buildClaudeLocalReport(monthsBack) {
  const report = await buildClaudeReportFromSource(CLAUDE_HOME, os.hostname(), monthsBack);
  report.machineOptions = buildClaudeMachineOptions(true);
  return report;
}

async function buildCombinedClaudeReport(monthsBack) {
  const snapshotSources = listClaudeSnapshotSources();
  const availableSources = snapshotSources.filter((source) => source.available);
  const unavailableSources = snapshotSources.filter((source) => !source.available);
  const reports = [await buildClaudeReportFromSource(CLAUDE_HOME, os.hostname(), monthsBack)];

  for (const source of availableSources) {
    if (source.machine === os.hostname()) {
      continue;
    }
    reports.push(await buildClaudeReportFromSource(source.claudeHome, source.machine, monthsBack));
  }

  const merged = mergeClaudeReports(reports, monthsBack, unavailableSources);
  merged.machineOptions = buildClaudeMachineOptions(true);
  return merged;
}

async function buildClaudeSnapshotSelectionReport(monthsBack, machineName) {
  if (machineName === os.hostname()) {
    return buildClaudeLocalReport(monthsBack);
  }

  const snapshotSources = listClaudeSnapshotSources();
  const selected = snapshotSources.find((source) => source.machine === machineName);

  if (!selected) {
    throw new Error(`Claude snapshot source not found: ${machineName}`);
  }

  if (!selected.available) {
    throw new Error(`Snapshot source does not contain Claude Code data: ${machineName}`);
  }

  const report = await buildClaudeReportFromSource(selected.claudeHome, selected.machine, monthsBack);
  report.machineOptions = buildClaudeMachineOptions(true);
  return report;
}

function mergeClaudeReports(reports, monthsBack, unavailableSources = []) {
  const monthMap = new Map();
  const providers = new Set();
  const distinctProjects = new Set();
  const globalActiveDays = new Set();
  const machineMap = new Map();
  let sessionCount = 0;

  for (const report of reports) {
    const totalTokens = report.months.reduce(
      (sum, month) => sum + (month.inputTokens || 0) + (month.outputTokens || 0) + (month.cacheCreationTokens || 0) + (month.cacheReadTokens || 0),
      0
    );
    machineMap.set(report.machine, {
      machine: report.machine,
      status: "ok",
      sessions: report.months.reduce((sum, month) => sum + (month.sessions || 0), 0),
      requests: report.months.reduce((sum, month) => sum + (month.requests || 0), 0),
      tokens: totalTokens
    });

    sessionCount += Number(report.totals?.sessionCount || 0);

    for (const provider of report.totals?.providers || []) {
      providers.add(provider);
    }

    for (const project of report.totals?.distinctProjects || []) {
      distinctProjects.add(project);
    }

    for (const day of report.totals?.activeDayKeys || []) {
      globalActiveDays.add(day);
    }

    for (const month of report.months) {
      const target = monthMap.get(month.month) || {
        month: month.month,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cachedTokens: 0,
        totalCostUsd: 0,
        models: new Set(),
        projects: new Set(),
        activeDayKeys: new Set(),
        sampleTitles: [],
        tokensByModel: {},
        paygEstimate: {
          optimisticUsd: 0,
          midpointUsd: 0,
          conservativeUsd: 0
        }
      };

      target.sessions += Number(month.sessions || 0);
      target.requests += Number(month.requests || 0);
      target.inputTokens += Number(month.inputTokens || 0);
      target.outputTokens += Number(month.outputTokens || 0);
      target.cacheCreationTokens += Number(month.cacheCreationTokens || 0);
      target.cacheReadTokens += Number(month.cacheReadTokens || 0);
      target.cachedTokens += Number(month.cachedTokens || 0);
      target.totalCostUsd += Number(month.totalCostUsd || 0);

      for (const model of month.models || []) {
        target.models.add(model);
      }

      for (const project of month.projects || []) {
        target.projects.add(project);
      }

      for (const day of month.activeDayKeys || []) {
        target.activeDayKeys.add(day);
      }

      target.paygEstimate.optimisticUsd += Number(month.paygEstimate?.optimisticUsd || 0);
      target.paygEstimate.midpointUsd += Number(month.paygEstimate?.midpointUsd || 0);
      target.paygEstimate.conservativeUsd += Number(month.paygEstimate?.conservativeUsd || 0);

      for (const [model, tokens] of Object.entries(month.tokensByModel || {})) {
        const existing = target.tokensByModel[model] || { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
        existing.input += tokens.input || 0;
        existing.output += tokens.output || 0;
        existing.cacheCreation += tokens.cacheCreation || 0;
        existing.cacheRead += tokens.cacheRead || 0;
        target.tokensByModel[model] = existing;
      }

      for (const title of month.sampleTitles || []) {
        if (target.sampleTitles.length >= 3) break;
        if (!target.sampleTitles.includes(title)) target.sampleTitles.push(title);
      }

      monthMap.set(month.month, target);
    }
  }

  const months = buildMonthRange(monthsBack).map((monthKey) => {
    const month = monthMap.get(monthKey);

    if (!month) {
      return {
        month: monthKey,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cachedTokens: 0,
        totalCostUsd: 0,
        models: [],
        projects: [],
        activeDays: 0,
        activeDayKeys: [],
        sampleTitles: [],
        tokensByModel: {},
        paygEstimate: { optimisticUsd: 0, midpointUsd: 0, conservativeUsd: 0 }
      };
    }

    return {
      month: month.month,
      sessions: month.sessions,
      requests: month.requests,
      inputTokens: month.inputTokens,
      outputTokens: month.outputTokens,
      cacheCreationTokens: month.cacheCreationTokens,
      cacheReadTokens: month.cacheReadTokens,
      cachedTokens: month.cachedTokens,
      totalCostUsd: Number(month.totalCostUsd.toFixed(4)),
      models: Array.from(month.models).sort(),
      projects: Array.from(month.projects).sort(),
      activeDays: month.activeDayKeys.size,
      activeDayKeys: Array.from(month.activeDayKeys).sort(),
      sampleTitles: month.sampleTitles,
      tokensByModel: month.tokensByModel,
      paygEstimate: {
        optimisticUsd: Number(month.paygEstimate.optimisticUsd.toFixed(4)),
        midpointUsd: Number(month.paygEstimate.midpointUsd.toFixed(4)),
        conservativeUsd: Number(month.paygEstimate.conservativeUsd.toFixed(4))
      }
    };
  });

  const recommendation = recommendPlan(months, CLAUDE_PLAN_PROFILES);
  const unavailable = unavailableSources
    .filter((source) => !machineMap.has(source.machine))
    .map((source) => ({ machine: source.machine, status: source.status }));
  const paygEstimate = months.reduce(
    (totals, month) => {
      totals.optimisticUsd += Number(month.paygEstimate?.optimisticUsd || 0);
      totals.midpointUsd += Number(month.paygEstimate?.midpointUsd || 0);
      totals.conservativeUsd += Number(month.paygEstimate?.conservativeUsd || 0);
      return totals;
    },
    { optimisticUsd: 0, midpointUsd: 0, conservativeUsd: 0 }
  );

  const machines = Array.from(machineMap.values()).sort((a, b) => a.machine.localeCompare(b.machine));
  machines.push(...unavailable);

  return {
    generatedAt: new Date().toISOString(),
    source: "claude-snapshot-aggregate",
    product: "claude",
    machine: os.hostname(),
    period: {
      monthsBack,
      start: fromMonthsBack(monthsBack).toISOString(),
      end: new Date().toISOString()
    },
    plans: CLAUDE_PLAN_PROFILES,
    months,
    recommendation,
    paygEstimate: {
      optimisticUsd: Number(paygEstimate.optimisticUsd.toFixed(4)),
      midpointUsd: Number(paygEstimate.midpointUsd.toFixed(4)),
      conservativeUsd: Number(paygEstimate.conservativeUsd.toFixed(4))
    },
    totals: {
      distinctProjects: Array.from(distinctProjects).sort(),
      providers: Array.from(providers).sort(),
      sessionCount,
      activeDays: globalActiveDays.size
    },
    machines,
    machineOptions: [],
    notes: [
      `This report consolidates ${reports.length} Claude Code source(s): local machine + imported snapshots.`,
      unavailable.length
        ? `The following sources did not contain Claude Code data: ${unavailable.map((item) => item.machine).join(", ")}.`
        : "All detected snapshot sources contained Claude Code data.",
      "Token usage is extracted per API call from each session's JSONL file, broken down by model.",
      "Claude Code subscription plans (Max) have different pricing from API. This estimate shows what the same usage would cost on pay-as-you-go API billing."
    ]
  };
}

async function buildSnapshotReportFromSource(source, monthsBack) {
  const configuredModel = getConfiguredModel(source.configPath);
  const pythonScript = `
import json, sqlite3, sys
from collections import defaultdict
from datetime import datetime, timezone

db_path, history_path, months_back, machine_name = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
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
    session_ids.add(f"{machine_name}:{thread_id}")
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
            day_activity[day] += 1
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
        "activeDayKeys": sorted(month["activeDays"]),
        "sampleTitles": month["sampleTitles"]
    })

print(json.dumps({
    "machine": machine_name,
    "months": sorted(result_months, key=lambda item: item["month"]),
    "totals": {
        "distinctProjects": sorted(all_cwds),
        "providers": sorted(providers),
        "sessionCount": len(session_ids),
        "activeDays": len(day_activity),
        "activeDayKeys": sorted(day_activity.keys())
    }
}))
`;

  const localData = await runPythonJson(pythonScript, [
    source.dbPath,
    source.historyPath || "",
    String(monthsBack),
    source.machine
  ]);
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
          activeDayKeys: [],
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
    machine: source.machine,
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
      `This report uses local Codex files from ${source.machine}.`,
      "For ChatGPT subscription accounts, this local approach is the most reliable way to measure real Codex CLI usage without depending on organization-level API endpoints.",
      `The pay-as-you-go estimate is based on the current official ${configuredModel} pricing: US$ ${paygEstimate.pricing.inputPerMillionUsd.toFixed(2)}/1M input tokens, US$ ${paygEstimate.pricing.cachedInputPerMillionUsd.toFixed(2)}/1M cached input tokens, and US$ ${paygEstimate.pricing.outputPerMillionUsd.toFixed(2)}/1M output tokens.`,
      "Because this machine's local data does not safely separate input and output tokens, the dashboard shows three estimates: optimistic, midpoint, and conservative.",
      "As far as current public documentation shows, there is no official API to automatically fetch total Codex usage for a ChatGPT subscription across all machines and accounts."
    ]
  };
}

function listSnapshotSources() {
  if (!fileExists(SNAPSHOTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(SNAPSHOTS_DIR, entry.name);
      const dbPath = path.join(dirPath, "state_5.sqlite");
      const historyPath = path.join(dirPath, "history.jsonl");
      const statusPath = path.join(dirPath, "STATUS.txt");
      const hasDatabase = fileExists(dbPath);
      const hasHistory = fileExists(historyPath);
      const status = fileExists(statusPath)
        ? fs.readFileSync(statusPath, "utf-8").trim() || "status-unknown"
        : "";
      const configPath = path.join(dirPath, "config.toml");

      return {
        id: entry.name,
        machine: entry.name,
        dirPath,
        dbPath,
        historyPath,
        configPath,
        hasDatabase,
        hasHistory,
        available: hasDatabase,
        status: hasDatabase ? "ok" : status || "missing-codex-data"
      };
    });
}

function buildMachineOptions(includeLocal = true) {
  const options = [];
  const seen = new Set();

  if (includeLocal) {
    const localMachine = os.hostname();
    options.push({ machine: localMachine, source: "local", available: true });
    seen.add(localMachine);
  }

  for (const source of listSnapshotSources()) {
    if (seen.has(source.machine)) {
      continue;
    }

    options.push({
      machine: source.machine,
      source: "snapshot",
      available: source.available,
      status: source.status
    });
    seen.add(source.machine);
  }

  return options;
}

function mergeLocalReports(reports, monthsBack, unavailableSources = []) {
  const monthMap = new Map();
  const providers = new Set();
  const distinctProjects = new Set();
  const globalActiveDays = new Set();
  const machineMap = new Map();
  let sessionCount = 0;

  for (const report of reports) {
    machineMap.set(report.machine, {
      machine: report.machine,
      status: "ok",
      sessions: report.months.reduce((sum, month) => sum + (month.sessions || 0), 0),
      requests: report.months.reduce((sum, month) => sum + (month.requests || 0), 0),
      tokens: report.months.reduce((sum, month) => sum + (month.outputTokens || 0), 0)
    });

    sessionCount += Number(report.totals?.sessionCount || 0);

    for (const provider of report.totals?.providers || []) {
      providers.add(provider);
    }

    for (const project of report.totals?.distinctProjects || []) {
      distinctProjects.add(project);
    }

    for (const day of report.totals?.activeDayKeys || []) {
      globalActiveDays.add(day);
    }

    for (const month of report.months) {
      const target = monthMap.get(month.month) || {
        month: month.month,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalCostUsd: 0,
        models: new Set(),
        projects: new Set(),
        activeDayKeys: new Set(),
        sampleTitles: [],
        paygEstimate: {
          optimisticUsd: 0,
          midpointUsd: 0,
          conservativeUsd: 0
        }
      };

      target.sessions += Number(month.sessions || 0);
      target.requests += Number(month.requests || 0);
      target.inputTokens += Number(month.inputTokens || 0);
      target.outputTokens += Number(month.outputTokens || 0);
      target.cachedTokens += Number(month.cachedTokens || 0);
      target.totalCostUsd += Number(month.totalCostUsd || 0);

      for (const model of month.models || []) {
        target.models.add(model);
      }

      for (const project of month.projects || []) {
        target.projects.add(project);
      }

      for (const day of month.activeDayKeys || []) {
        target.activeDayKeys.add(day);
      }

      target.paygEstimate.optimisticUsd += Number(month.paygEstimate?.optimisticUsd || 0);
      target.paygEstimate.midpointUsd += Number(month.paygEstimate?.midpointUsd || 0);
      target.paygEstimate.conservativeUsd += Number(month.paygEstimate?.conservativeUsd || 0);

      for (const title of month.sampleTitles || []) {
        if (target.sampleTitles.length >= 3) {
          break;
        }

        if (!target.sampleTitles.includes(title)) {
          target.sampleTitles.push(title);
        }
      }

      monthMap.set(month.month, target);
    }
  }

  const months = buildMonthRange(monthsBack).map((monthKey) => {
    const month = monthMap.get(monthKey);

    if (!month) {
      return {
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
        activeDayKeys: [],
        sampleTitles: [],
        paygEstimate: {
          optimisticUsd: 0,
          midpointUsd: 0,
          conservativeUsd: 0
        }
      };
    }

    return {
      month: month.month,
      sessions: month.sessions,
      requests: month.requests,
      inputTokens: month.inputTokens,
      outputTokens: month.outputTokens,
      cachedTokens: month.cachedTokens,
      totalCostUsd: Number(month.totalCostUsd.toFixed(4)),
      models: Array.from(month.models).sort(),
      projects: Array.from(month.projects).sort(),
      activeDays: month.activeDayKeys.size,
      activeDayKeys: Array.from(month.activeDayKeys).sort(),
      sampleTitles: month.sampleTitles,
      paygEstimate: {
        optimisticUsd: Number(month.paygEstimate.optimisticUsd.toFixed(4)),
        midpointUsd: Number(month.paygEstimate.midpointUsd.toFixed(4)),
        conservativeUsd: Number(month.paygEstimate.conservativeUsd.toFixed(4))
      }
    };
  });

  const recommendation = recommendPlan(months);
  const unavailable = unavailableSources
    .filter((source) => !machineMap.has(source.machine))
    .map((source) => ({
      machine: source.machine,
      status: source.status
    }));
  const paygEstimate = months.reduce(
    (totals, month) => {
      totals.optimisticUsd += Number(month.paygEstimate?.optimisticUsd || 0);
      totals.midpointUsd += Number(month.paygEstimate?.midpointUsd || 0);
      totals.conservativeUsd += Number(month.paygEstimate?.conservativeUsd || 0);
      return totals;
    },
    { optimisticUsd: 0, midpointUsd: 0, conservativeUsd: 0 }
  );

  const machines = Array.from(machineMap.values()).sort((a, b) => a.machine.localeCompare(b.machine));
  machines.push(...unavailable);

  return {
    generatedAt: new Date().toISOString(),
    source: "snapshot-aggregate",
    machine: os.hostname(),
    period: {
      monthsBack,
      start: fromMonthsBack(monthsBack).toISOString(),
      end: new Date().toISOString()
    },
    plans: PLAN_PROFILES,
    months,
    recommendation,
    paygEstimate: {
      optimisticUsd: Number(paygEstimate.optimisticUsd.toFixed(4)),
      midpointUsd: Number(paygEstimate.midpointUsd.toFixed(4)),
      conservativeUsd: Number(paygEstimate.conservativeUsd.toFixed(4))
    },
    totals: {
      distinctProjects: Array.from(distinctProjects).sort(),
      providers: Array.from(providers).sort(),
      sessionCount,
      activeDays: globalActiveDays.size
    },
    machines,
    machineOptions: buildMachineOptions(true),
    notes: [
      `This report consolidates ${reports.length} Codex snapshot(s) from ${SNAPSHOTS_DIR}.`,
      unavailable.length
        ? `The following sources did not contain Codex local data: ${unavailable.map((item) => item.machine).join(", ")}.`
        : "All detected snapshot sources contained Codex local data.",
      "For ChatGPT subscription accounts, aggregating local snapshots per machine is the most faithful way to estimate total Codex CLI usage.",
      "As far as current public documentation shows, there is no official API to automatically fetch total Codex usage for a ChatGPT subscription across all machines and accounts."
    ]
  };
}

async function buildCombinedSnapshotReport(monthsBack) {
  const snapshotSources = listSnapshotSources();
  const availableSources = snapshotSources.filter((source) => source.available);
  const unavailableSources = snapshotSources.filter((source) => !source.available);
  const reports = [await buildLocalReport(monthsBack)];

  for (const source of availableSources) {
    if (source.machine === os.hostname()) {
      continue;
    }
    reports.push(await buildSnapshotReportFromSource(source, monthsBack));
  }

  return mergeLocalReports(reports, monthsBack, unavailableSources);
}

async function buildImportedSnapshotSelectionReport(monthsBack, machineName) {
  if (machineName === os.hostname()) {
    const report = await buildLocalReport(monthsBack);
    return {
      ...report,
      machineOptions: buildMachineOptions(true)
    };
  }

  const snapshotSources = listSnapshotSources();
  const selected = snapshotSources.find((source) => source.machine === machineName);

  if (!selected) {
    throw new Error(`Snapshot source not found: ${machineName}`);
  }

  if (!selected.available) {
    throw new Error(`Snapshot source does not contain Codex local data: ${machineName}`);
  }

  const report = await buildSnapshotReportFromSource(selected, monthsBack);
  return {
    ...report,
    machineOptions: buildMachineOptions(true)
  };
}

const publicDir = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      mode: "local"
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/local-report") {
    const monthsBack = Math.max(1, Math.min(24, Number(requestUrl.searchParams.get("months") || 6)));
    const scope = String(requestUrl.searchParams.get("scope") || "all").toLowerCase();
    const machine = String(requestUrl.searchParams.get("machine") || "").trim();
    const product = String(requestUrl.searchParams.get("product") || "codex").toLowerCase();

    try {
      let report;

      if (product === "claude") {
        if (scope === "local") {
          report = await buildClaudeLocalReport(monthsBack);
        } else if (machine && machine !== "all") {
          report = await buildClaudeSnapshotSelectionReport(monthsBack, machine);
        } else {
          report = await buildCombinedClaudeReport(monthsBack);
        }
      } else if (scope === "local") {
        report = await buildLocalReport(monthsBack);
      } else if (machine && machine !== "all") {
        report = await buildImportedSnapshotSelectionReport(monthsBack, machine);
      } else {
        report = await buildCombinedSnapshotReport(monthsBack);
      }

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
