const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const recommendationEl = document.getElementById("recommendation");
const monthsBodyEl = document.getElementById("months-body");
const plansGridEl = document.getElementById("plans-grid");
const notesListEl = document.getElementById("notes-list");
const monthsSectionEl = document.getElementById("months-section");
const plansSectionEl = document.getElementById("plans-section");
const notesSectionEl = document.getElementById("notes-section");
const trendSectionEl = document.getElementById("trend-section");
const trendSummaryEl = document.getElementById("trend-summary");
const chartsSectionEl = document.getElementById("charts-section");
const tokensChartEl = document.getElementById("tokens-chart");
const promptsChartEl = document.getElementById("prompts-chart");
const paygChartEl = document.getElementById("payg-chart");
const machinesChartEl = document.getElementById("machines-chart");
const machineFilterEl = document.getElementById("machine-filter");

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(value || 0);
}

function setStatus(message, type = "info") {
  statusEl.className = `status ${type}`;
  statusEl.textContent = message;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderSummary(report) {
  const activeMonths = report.months.filter(
    (month) => month.requests > 0 || month.sessions > 0 || month.outputTokens > 0
  );
  const totalRequests = report.months.reduce((sum, month) => sum + month.requests, 0);
  const totalSessions = report.months.reduce((sum, month) => sum + (month.sessions || 0), 0);
  const totalTokens = report.months.reduce((sum, month) => sum + (month.outputTokens || 0), 0);
  const avgMonthlyRequests = average(activeMonths.map((month) => month.requests));
  const activeDays = report.months.reduce((sum, month) => sum + (month.activeDays || 0), 0);
  const machineCount = (report.machines || []).filter((machine) => machine.status === "ok").length;

  summaryEl.innerHTML = [
    machineCount ? metricCard("Machines", formatInteger(machineCount)) : "",
    metricCard("Sessions", formatInteger(totalSessions)),
    metricCard("Prompts", formatInteger(totalRequests)),
    metricCard("Tokens used", formatInteger(totalTokens)),
    metricCard("Estimated PAYG", formatUsd(report.paygEstimate?.midpointUsd || 0)),
    metricCard("Active days", formatInteger(activeDays)),
    metricCard("Avg monthly prompts", formatInteger(Math.round(avgMonthlyRequests)))
  ].join("");
}

function updateMachineFilter(report) {
  const currentValue = machineFilterEl.value;
  const machines = (report.machineOptions || [])
    .filter((machine) => machine.available)
    .map((machine) => machine.machine);
  const unique = Array.from(new Set(machines)).sort();

  machineFilterEl.innerHTML = [
    `<option value="all">All imported snapshots</option>`,
    ...unique.map((machine) => `<option value="${machine}">${machine}</option>`)
  ].join("");

  if (unique.includes(currentValue)) {
    machineFilterEl.value = currentValue;
  } else if (report.machine && unique.includes(report.machine) && currentValue !== "all") {
    machineFilterEl.value = report.machine;
  } else {
    machineFilterEl.value = "all";
  }
}

function metricCard(label, value) {
  return `
    <article class="metric card">
      <p class="metric-label">${label}</p>
      <strong class="metric-value">${value}</strong>
    </article>
  `;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value || 0);
}

function computeTrend(series) {
  const points = series.map((value, index) => ({ x: index, y: Number(value || 0) }));
  if (!points.length) {
    return { direction: "flat", label: "No data", slope: 0, changePct: 0 };
  }

  const n = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator ? (n * sumXY - sumX * sumY) / denominator : 0;
  const split = Math.max(1, Math.floor(n / 2));
  const firstAvg = average(points.slice(0, split).map((point) => point.y));
  const secondAvg = average(points.slice(split).map((point) => point.y));
  const changePct = firstAvg ? ((secondAvg - firstAvg) / firstAvg) * 100 : (secondAvg > 0 ? 100 : 0);
  const maxValue = Math.max(...points.map((point) => point.y), 0);
  const normalizedSlope = maxValue ? slope / maxValue : 0;

  if (Math.abs(normalizedSlope) < 0.03 && Math.abs(changePct) < 8) {
    return { direction: "flat", label: "Stable", slope, changePct };
  }

  if (normalizedSlope > 0) {
    return { direction: "up", label: changePct > 25 ? "Growing fast" : "Growing", slope, changePct };
  }

  return { direction: "down", label: changePct < -25 ? "Declining fast" : "Declining", slope, changePct };
}

function trendCard(title, trend, detail) {
  return `
    <article class="trend-card">
      <span class="trend-badge ${trend.direction}">${trend.label}</span>
      <h3>${title}</h3>
      <p class="lede small">${detail}</p>
    </article>
  `;
}

function renderTrend(report) {
  trendSectionEl.classList.remove("hidden");
  const tokenTrend = computeTrend(report.months.map((month) => month.outputTokens || 0));
  const promptTrend = computeTrend(report.months.map((month) => month.requests || 0));
  const paygTrend = computeTrend(report.months.map((month) => month.paygEstimate?.midpointUsd || 0));

  trendSummaryEl.innerHTML = [
    trendCard(
      "Token usage trend",
      tokenTrend,
      `Estimated change from the earlier half of the period to the later half: ${tokenTrend.changePct.toFixed(1)}%.`
    ),
    trendCard(
      "Prompt trend",
      promptTrend,
      `Average request slope per month step: ${formatInteger(Math.round(promptTrend.slope))}.`
    ),
    trendCard(
      "Estimated PAYG trend",
      paygTrend,
      `Midpoint pay-as-you-go estimate trend over time: ${paygTrend.changePct.toFixed(1)}%.`
    )
  ].join("");
}

function renderLineChart(container, months, getValue, formatter, lineColor = "#b14d1d", areaColor = "rgba(177, 77, 29, 0.14)") {
  const values = months.map(getValue);
  const max = Math.max(...values, 0);
  if (!max) {
    container.innerHTML = `<div class="chart-empty">No activity in the selected period.</div>`;
    return;
  }

  const width = 560;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 34, left: 52 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const xStep = values.length > 1 ? innerWidth / (values.length - 1) : 0;
  const baseline = padding.top + innerHeight;

  const points = values.map((value, index) => {
    const x = padding.left + (values.length > 1 ? index * xStep : innerWidth / 2);
    const y = baseline - (value / max) * innerHeight;
    return { x, y, value, label: months[index].month };
  });

  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${path} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = padding.top + ratio * innerHeight;
    const value = max - ratio * max;
    return `
      <line class="chart-grid" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line>
      <text class="chart-label" x="10" y="${y + 4}">${formatter(value)}</text>
    `;
  }).join("");
  const labels = points
    .map((point, index) =>
      index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2)
        ? `<text class="chart-label" x="${point.x}" y="${height - 10}" text-anchor="middle">${point.label}</text>`
        : ""
    )
    .join("");
  const dots = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${lineColor}"></circle>`).join("");

  container.innerHTML = `
    <div class="chart-shell">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Time series chart">
        ${grid}
        <line class="chart-axis" x1="${padding.left}" y1="${baseline}" x2="${width - padding.right}" y2="${baseline}"></line>
        <path class="chart-area" d="${areaPath}" style="fill:${areaColor};"></path>
        <path class="chart-line" d="${path}" style="stroke:${lineColor};"></path>
        ${dots}
        ${labels}
      </svg>
    </div>
  `;
}

function renderBarChart(container, months, getValue, formatter) {
  const values = months.map(getValue);
  const max = Math.max(...values, 0);
  if (!max) {
    container.innerHTML = `<div class="chart-empty">No activity in the selected period.</div>`;
    return;
  }

  const width = 560;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 34, left: 52 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const slot = innerWidth / Math.max(1, months.length);
  const barWidth = Math.max(12, slot - 10);
  const baseline = padding.top + innerHeight;

  const bars = months.map((month, index) => {
    const value = getValue(month);
    const x = padding.left + index * slot + (slot - barWidth) / 2;
    const barHeight = max ? (value / max) * innerHeight : 0;
    const y = baseline - barHeight;
    const label = index === 0 || index === months.length - 1 || index === Math.floor(months.length / 2)
      ? `<text class="chart-label" x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle">${month.month}</text>`
      : "";
    return `<rect class="chart-bar" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="6"></rect>${label}`;
  }).join("");

  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = padding.top + ratio * innerHeight;
    const value = max - ratio * max;
    return `
      <line class="chart-grid" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line>
      <text class="chart-label" x="10" y="${y + 4}">${formatter(value)}</text>
    `;
  }).join("");

  container.innerHTML = `
    <div class="chart-shell">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bar chart">
        ${grid}
        <line class="chart-axis" x1="${padding.left}" y1="${baseline}" x2="${width - padding.right}" y2="${baseline}"></line>
        ${bars}
      </svg>
    </div>
  `;
}

function renderMachineBarChart(container, machines) {
  const machineStats = (machines || [])
    .filter((machine) => machine.status === "ok" || machine.tokens || machine.sessions)
    .map((machine) => ({
      label: machine.machine,
      value: machine.tokens || 0
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const max = Math.max(...machineStats.map((item) => item.value), 0);
  if (!max) {
    container.innerHTML = `<div class="chart-empty">No machine-level token data available.</div>`;
    return;
  }

  container.innerHTML = machineStats
    .map((item) => {
      const pct = (item.value / max) * 100;
      return `
        <div style="margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:6px;">
            <span style="color:var(--text); font-size:0.92rem;">${item.label}</span>
            <span style="color:var(--muted); font-size:0.85rem;">${formatCompactNumber(item.value)}</span>
          </div>
          <div style="height:10px; border-radius:999px; background:rgba(37,22,11,0.08); overflow:hidden;">
            <div style="height:100%; width:${pct}%; background:linear-gradient(90deg, #547859, #b14d1d); border-radius:999px;"></div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderCharts(report) {
  chartsSectionEl.classList.remove("hidden");
  renderLineChart(tokensChartEl, report.months, (month) => month.outputTokens || 0, formatCompactNumber);
  renderBarChart(promptsChartEl, report.months, (month) => month.requests || 0, formatInteger);
  renderLineChart(
    paygChartEl,
    report.months,
    (month) => month.paygEstimate?.midpointUsd || 0,
    formatUsd,
    "#245c3c",
    "rgba(36, 92, 60, 0.16)"
  );
  renderMachineBarChart(machinesChartEl, report.machines || []);
}

function renderRecommendation(report) {
  const selected = report.recommendation.comparedPlans.find(
    (plan) => plan.id === report.recommendation.recommendedPlanId
  );
  const scopeLabel =
    report.source === "snapshot-aggregate"
      ? "imported snapshots across machines plus the current machine"
      : `Codex history from ${report.machine || "the selected machine"}`;

  recommendationEl.classList.remove("hidden");
  recommendationEl.innerHTML = `
    <p class="eyebrow">Recommendation</p>
    <h2>${selected ? selected.name : report.recommendation.recommendedPlanId}</h2>
    <p class="lede small">
      Confidence: ${report.recommendation.confidence}. This recommendation is based on
      ${scopeLabel}, not on any official published app-message limit.
    </p>
    <p class="lede small">
      If this same volume had been billed as pay-as-you-go, the midpoint estimate for the period
      would be ${formatUsd(report.paygEstimate?.midpointUsd || 0)}.
    </p>
    <ul class="notes-list">
      ${report.recommendation.rationale.map((item) => `<li>${item}</li>`).join("")}
    </ul>
  `;
}

function renderMonths(report) {
  monthsSectionEl.classList.remove("hidden");
  const visibleMonths = report.months.filter(
    (month) =>
      (month.sessions || 0) > 0 ||
      (month.requests || 0) > 0 ||
      (month.outputTokens || 0) > 0 ||
      (month.paygEstimate?.midpointUsd || 0) > 0
  );

  monthsBodyEl.innerHTML = visibleMonths
    .map(
      (month) => `
        <tr>
          <td>${month.month}</td>
          <td>${formatInteger(month.sessions || 0)}</td>
          <td>${formatInteger(month.requests)}</td>
          <td>${formatInteger(month.outputTokens)}</td>
          <td>${formatUsd(month.paygEstimate?.midpointUsd || 0)}</td>
          <td>${formatInteger(month.activeDays || 0)}</td>
          <td>${month.models.length ? month.models.join(", ") : "-"}</td>
        </tr>
      `
    )
    .join("");

  if (!visibleMonths.length) {
    monthsBodyEl.innerHTML = `
      <tr>
        <td colspan="7">No monthly usage found in the selected period.</td>
      </tr>
    `;
  }
}

function renderPlans(report) {
  plansSectionEl.classList.remove("hidden");
  plansGridEl.innerHTML = report.recommendation.comparedPlans
    .map((plan) => {
      const active = plan.id === report.recommendation.recommendedPlanId;
      return `
        <article class="plan card ${active ? "plan-active" : ""}">
          <p class="eyebrow">${active ? "Selected" : "Alternative"}</p>
          <h3>${plan.name}</h3>
          <p class="plan-price">${formatUsd(plan.monthlyPriceUsd)}/month</p>
          <p class="plan-copy">${plan.description}</p>
          <dl class="plan-stats">
            <div><dt>Heuristic cost ceiling</dt><dd>${formatUsd(plan.monthlyCostCeilingUsd)}</dd></div>
            <div><dt>Heuristic request ceiling</dt><dd>${formatInteger(plan.monthlyRequestsCeiling)}</dd></div>
            <div><dt>Score</dt><dd>${plan.score?.toFixed ? plan.score.toFixed(2) : "n/a"}</dd></div>
          </dl>
        </article>
      `;
    })
    .join("");
}

function renderNotes(report) {
  notesSectionEl.classList.remove("hidden");
  const estimate = report.paygEstimate || {};
  notesListEl.innerHTML = [
    `<li>Estimated pay-as-you-go for the period: optimistic ${formatUsd(estimate.optimisticUsd || 0)}, midpoint ${formatUsd(estimate.midpointUsd || 0)}, and conservative ${formatUsd(estimate.conservativeUsd || 0)}.</li>`,
    ...report.notes.map((note) => `<li>${note}</li>`)
  ].join("");
}

async function loadReport() {
  const months = document.getElementById("months").value || "6";
  const machine = machineFilterEl.value || "all";
  const loadingLabel =
    machine !== "all"
      ? `Reading Codex snapshot for ${machine}...`
      : "Reading imported Codex snapshots across machines...";
  setStatus(loadingLabel, "loading");

  try {
    const response = await fetch(
      `/api/local-report?months=${encodeURIComponent(months)}&scope=all&machine=${encodeURIComponent(machine)}`
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load report.");
    }

    updateMachineFilter(payload);
    renderSummary(payload);
    renderRecommendation(payload);
    renderTrend(payload);
    renderCharts(payload);
    renderMonths(payload);
    renderPlans(payload);
    renderNotes(payload);
    setStatus(
      `Report updated at ${new Date(payload.generatedAt).toLocaleString("en-US")}.`,
      "success"
    );
  } catch (error) {
    recommendationEl.classList.add("hidden");
    trendSectionEl.classList.add("hidden");
    chartsSectionEl.classList.add("hidden");
    monthsSectionEl.classList.add("hidden");
    plansSectionEl.classList.add("hidden");
    notesSectionEl.classList.add("hidden");
    summaryEl.innerHTML = "";
    setStatus(error.message, "error");
  }
}

document.getElementById("load-report").addEventListener("click", loadReport);

loadReport();
