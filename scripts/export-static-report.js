const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = process.env.CODEX_USAGE_BASE_URL || "http://127.0.0.1:3000";
const months = Math.max(1, Math.min(24, Number(process.argv[2] || 6)));
const scope = String(process.argv[3] || "all").toLowerCase() === "local" ? "local" : "all";
const outputPath =
  process.argv[4] ||
  path.join(
    __dirname,
    "..",
    "exports",
    `codex-usage-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`
  );

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metricCard(label, value) {
  return `
    <article class="metric card">
      <p class="metric-label">${escapeHtml(label)}</p>
      <strong class="metric-value">${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderRows(rows, columns) {
  return rows
    .map(
      (row) => `
        <tr>
          ${columns.map((column) => `<td>${column(row)}</td>`).join("")}
        </tr>
      `
    )
    .join("");
}

async function main() {
  const endpoint = `${DEFAULT_BASE_URL}/api/local-report?months=${encodeURIComponent(months)}&scope=${encodeURIComponent(scope)}`;
  const response = await fetch(endpoint);
  const report = await response.json();

  if (!response.ok) {
    throw new Error(report.error || `Failed to fetch report from ${endpoint}`);
  }

  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const activeMonths = report.months.filter(
    (month) => month.requests > 0 || month.sessions > 0 || month.outputTokens > 0
  );
  const totalRequests = report.months.reduce((sum, month) => sum + Number(month.requests || 0), 0);
  const totalSessions = report.months.reduce((sum, month) => sum + Number(month.sessions || 0), 0);
  const totalTokens = report.months.reduce((sum, month) => sum + Number(month.outputTokens || 0), 0);
  const totalActiveDays = report.months.reduce((sum, month) => sum + Number(month.activeDays || 0), 0);
  const avgMonthlyPrompts = activeMonths.length
    ? Math.round(activeMonths.reduce((sum, month) => sum + Number(month.requests || 0), 0) / activeMonths.length)
    : 0;
  const okMachines = (report.machines || []).filter((machine) => machine.status === "ok");
  const selectedPlan =
    report.recommendation?.comparedPlans?.find(
      (plan) => plan.id === report.recommendation?.recommendedPlanId
    ) || null;
  const rawJson = JSON.stringify(report, null, 2);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codex Usage Static Report</title>
    <style>
${styles}
details.card { margin-top: 16px; padding: 24px; }
pre.raw-json {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 13px/1.5 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  color: var(--text);
}
code.inline-path {
  font: inherit;
  background: rgba(37, 22, 11, 0.06);
  padding: 2px 6px;
  border-radius: 8px;
}
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <p class="eyebrow">Codex Static Report</p>
        <h1>Full local Codex usage snapshot</h1>
        <p class="lede">
          Static export generated from <code class="inline-path">${escapeHtml(endpoint)}</code>.
          Source scope: ${escapeHtml(scope)}. Generated at ${escapeHtml(new Date(report.generatedAt).toLocaleString("en-US"))}.
        </p>
      </section>

      <section class="card" style="padding:24px;">
        <p class="eyebrow">Recommendation</p>
        <h2>${escapeHtml(selectedPlan ? selectedPlan.name : report.recommendation?.recommendedPlanId || "n/a")}</h2>
        <p class="lede small">
          Confidence: ${escapeHtml(report.recommendation?.confidence || "n/a")}. Estimated midpoint PAYG for the selected period:
          ${escapeHtml(formatUsd(report.paygEstimate?.midpointUsd || 0))}.
        </p>
        <ul class="notes-list">
          ${(report.recommendation?.rationale || [])
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}
        </ul>
      </section>

      <section class="summary-grid" style="margin-top:16px;">
        ${okMachines.length ? metricCard("Machines", formatInteger(okMachines.length)) : ""}
        ${metricCard("Sessions", formatInteger(totalSessions))}
        ${metricCard("Prompts", formatInteger(totalRequests))}
        ${metricCard("Tokens used", formatInteger(totalTokens))}
        ${metricCard("Estimated PAYG", formatUsd(report.paygEstimate?.midpointUsd || 0))}
        ${metricCard("Active days", formatInteger(totalActiveDays))}
        ${metricCard("Avg monthly prompts", formatInteger(avgMonthlyPrompts))}
      </section>

      <section class="card" id="months-section">
        <div class="section-heading">
          <h2>Monthly usage</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Sessions</th>
                <th>Requests</th>
                <th>Tokens</th>
                <th>Estimated PAYG</th>
                <th>Active days</th>
                <th>Providers</th>
              </tr>
            </thead>
            <tbody>
              ${renderRows(report.months || [], [
                (row) => escapeHtml(row.month),
                (row) => escapeHtml(formatInteger(row.sessions || 0)),
                (row) => escapeHtml(formatInteger(row.requests || 0)),
                (row) => escapeHtml(formatInteger(row.outputTokens || 0)),
                (row) => escapeHtml(formatUsd(row.paygEstimate?.midpointUsd || 0)),
                (row) => escapeHtml(formatInteger(row.activeDays || 0)),
                (row) => escapeHtml((row.models || []).join(", ") || "-")
              ])}
            </tbody>
          </table>
        </div>
      </section>

      ${
        report.machines?.length
          ? `
      <section class="card" id="machines-section">
        <div class="section-heading">
          <h2>Machine sources</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Machine</th>
                <th>Status</th>
                <th>Sessions</th>
                <th>Requests</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              ${renderRows(report.machines, [
                (row) => escapeHtml(row.machine),
                (row) => escapeHtml(row.status || "ok"),
                (row) => escapeHtml(formatInteger(row.sessions || 0)),
                (row) => escapeHtml(formatInteger(row.requests || 0)),
                (row) => escapeHtml(formatInteger(row.tokens || 0))
              ])}
            </tbody>
          </table>
        </div>
      </section>
      `
          : ""
      }

      <section class="card" id="plans-section">
        <div class="section-heading">
          <h2>Plan comparison</h2>
        </div>
        <div class="plans-grid">
          ${(report.recommendation?.comparedPlans || [])
            .map((plan) => {
              const active = plan.id === report.recommendation?.recommendedPlanId;
              return `
                <article class="plan card ${active ? "plan-active" : ""}">
                  <p class="eyebrow">${active ? "Selected" : "Alternative"}</p>
                  <h3>${escapeHtml(plan.name)}</h3>
                  <p class="plan-price">${escapeHtml(formatUsd(plan.monthlyPriceUsd))}/month</p>
                  <p class="plan-copy">${escapeHtml(plan.description)}</p>
                  <dl class="plan-stats">
                    <div><dt>Heuristic cost ceiling</dt><dd>${escapeHtml(formatUsd(plan.monthlyCostCeilingUsd))}</dd></div>
                    <div><dt>Heuristic request ceiling</dt><dd>${escapeHtml(formatInteger(plan.monthlyRequestsCeiling))}</dd></div>
                    <div><dt>Score</dt><dd>${escapeHtml(plan.score?.toFixed ? plan.score.toFixed(2) : "n/a")}</dd></div>
                  </dl>
                </article>
              `;
            })
            .join("")}
        </div>
      </section>

      <section class="card" id="notes-section">
        <div class="section-heading">
          <h2>Notes</h2>
        </div>
        <ul class="notes-list">
          <li>Estimated pay-as-you-go for the period: optimistic ${escapeHtml(formatUsd(report.paygEstimate?.optimisticUsd || 0))}, midpoint ${escapeHtml(formatUsd(report.paygEstimate?.midpointUsd || 0))}, and conservative ${escapeHtml(formatUsd(report.paygEstimate?.conservativeUsd || 0))}.</li>
          ${(report.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
        </ul>
      </section>

      <details class="card">
        <summary>Raw JSON payload</summary>
        <pre class="raw-json">${escapeHtml(rawJson)}</pre>
      </details>
    </main>
  </body>
</html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html);
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
