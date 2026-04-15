const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const recommendationEl = document.getElementById("recommendation");
const monthsBodyEl = document.getElementById("months-body");
const plansGridEl = document.getElementById("plans-grid");
const notesListEl = document.getElementById("notes-list");
const monthsSectionEl = document.getElementById("months-section");
const plansSectionEl = document.getElementById("plans-section");
const notesSectionEl = document.getElementById("notes-section");
const machineNameEl = document.getElementById("machine-name");
const machineListEl = document.getElementById("machine-list");

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
  machineNameEl.textContent = report.machine || "Unknown";
  machineListEl.textContent = (report.machines || []).map((item) => item.machine).join(", ") || "Unknown";
  const activeMonths = report.months.filter(
    (month) => month.requests > 0 || month.sessions > 0 || month.outputTokens > 0
  );
  const totalRequests = report.months.reduce((sum, month) => sum + month.requests, 0);
  const totalSessions = report.months.reduce((sum, month) => sum + (month.sessions || 0), 0);
  const totalTokens = report.months.reduce((sum, month) => sum + (month.outputTokens || 0), 0);
  const avgMonthlyRequests = average(activeMonths.map((month) => month.requests));
  const activeDays = report.months.reduce((sum, month) => sum + (month.activeDays || 0), 0);

  summaryEl.innerHTML = [
    metricCard("Sessions", formatInteger(totalSessions)),
    metricCard("Prompts", formatInteger(totalRequests)),
    metricCard("Tokens used", formatInteger(totalTokens)),
    metricCard("Estimated PAYG", formatUsd(report.paygEstimate?.midpointUsd || 0)),
    metricCard("Machines", formatInteger(report.totals?.machineCount || (report.machines || []).length || 0)),
    metricCard("Active days", formatInteger(activeDays)),
    metricCard("Avg monthly prompts", formatInteger(Math.round(avgMonthlyRequests)))
  ].join("");
}

function metricCard(label, value) {
  return `
    <article class="metric card">
      <p class="metric-label">${label}</p>
      <strong class="metric-value">${value}</strong>
    </article>
  `;
}

function renderRecommendation(report) {
  const selected = report.recommendation.comparedPlans.find(
    (plan) => plan.id === report.recommendation.recommendedPlanId
  );

  recommendationEl.classList.remove("hidden");
  recommendationEl.innerHTML = `
    <p class="eyebrow">Recommendation</p>
    <h2>${selected ? selected.name : report.recommendation.recommendedPlanId}</h2>
    <p class="lede small">
      Confidence: ${report.recommendation.confidence}. This recommendation is based on local Codex
      history from ${report.machine || "the current machine"}, not on any official published
      app-message limit.
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
  monthsBodyEl.innerHTML = report.months
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
  setStatus("Reading local Codex history from the current machine...", "loading");

  try {
    const response = await fetch(`/api/local-report?months=${encodeURIComponent(months)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load report.");
    }

    renderSummary(payload);
    renderRecommendation(payload);
    renderMonths(payload);
    renderPlans(payload);
    renderNotes(payload);
    setStatus(
      `Report updated at ${new Date(payload.generatedAt).toLocaleString("en-US")}.`,
      "success"
    );
  } catch (error) {
    machineNameEl.textContent = "Unavailable";
    machineListEl.textContent = "Unavailable";
    recommendationEl.classList.add("hidden");
    monthsSectionEl.classList.add("hidden");
    plansSectionEl.classList.add("hidden");
    notesSectionEl.classList.add("hidden");
    summaryEl.innerHTML = "";
    setStatus(error.message, "error");
  }
}

document.getElementById("load-report").addEventListener("click", loadReport);

loadReport();
