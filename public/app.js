const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const recommendationEl = document.getElementById("recommendation");
const monthsBodyEl = document.getElementById("months-body");
const plansGridEl = document.getElementById("plans-grid");
const notesListEl = document.getElementById("notes-list");
const monthsSectionEl = document.getElementById("months-section");
const plansSectionEl = document.getElementById("plans-section");
const notesSectionEl = document.getElementById("notes-section");

function formatInteger(value) {
  return new Intl.NumberFormat("pt-BR").format(value || 0);
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

  summaryEl.innerHTML = [
    metricCard("Sessoes", formatInteger(totalSessions)),
    metricCard("Prompts", formatInteger(totalRequests)),
    metricCard("Tokens usados", formatInteger(totalTokens)),
    metricCard("Dias ativos", formatInteger(activeDays)),
    metricCard("Media mensal de prompts", formatInteger(Math.round(avgMonthlyRequests)))
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
    <p class="eyebrow">Recomendacao</p>
    <h2>${selected ? selected.name : report.recommendation.recommendedPlanId}</h2>
    <p class="lede small">
      Confianca: ${report.recommendation.confidence}. Esta recomendacao e baseada no historico
      local do Codex nesta maquina, nao em um limite oficial publicado de mensagens do app.
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
          <p class="eyebrow">${active ? "Escolhido" : "Alternativa"}</p>
          <h3>${plan.name}</h3>
          <p class="plan-price">${formatUsd(plan.monthlyPriceUsd)}/mes</p>
          <p class="plan-copy">${plan.description}</p>
          <dl class="plan-stats">
            <div><dt>Teto de custo heuristico</dt><dd>${formatUsd(plan.monthlyCostCeilingUsd)}</dd></div>
            <div><dt>Teto de requests heuristico</dt><dd>${formatInteger(plan.monthlyRequestsCeiling)}</dd></div>
            <div><dt>Score</dt><dd>${plan.score?.toFixed ? plan.score.toFixed(2) : "n/a"}</dd></div>
          </dl>
        </article>
      `;
    })
    .join("");
}

function renderNotes(report) {
  notesSectionEl.classList.remove("hidden");
  notesListEl.innerHTML = report.notes.map((note) => `<li>${note}</li>`).join("");
}

async function loadReport() {
  const months = document.getElementById("months").value || "6";
  setStatus("Lendo o historico local do Codex nesta maquina...", "loading");

  try {
    const response = await fetch(`/api/local-report?months=${encodeURIComponent(months)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Falha ao carregar relatorio.");
    }

    renderSummary(payload);
    renderRecommendation(payload);
    renderMonths(payload);
    renderPlans(payload);
    renderNotes(payload);
    setStatus(
      `Relatorio atualizado em ${new Date(payload.generatedAt).toLocaleString("pt-BR")}.`,
      "success"
    );
  } catch (error) {
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
