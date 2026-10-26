import { businessDate, parseBusinessDate } from "./csv.js";
import { escapeHTML as H } from "./safe.js";
import { normalizeTeam } from "./prediction.js";

const typeLabels = {
  futbol: "Fútbol",
  beisbol: "Béisbol / Softbol",
  entrenamiento: "Entrenamiento",
  otro: "Otro evento",
  sin_especificar: "No lo sé todavía",
};
export function readPlannerAnswers(root = document) {
  const value = (id) => root.getElementById(id).value;
  const gamesMode = value("predGamesMode") || "unknown",
    teamMode = value("predTeamMode") || "none";
  return {
    targetDate: value("predDate"),
    type: value("predType") || "sin_especificar",
    games:
      gamesMode === "none"
        ? 0
        : gamesMode === "known" && value("predGames") !== ""
          ? Number(value("predGames"))
          : null,
    team:
      teamMode === "club_puebla"
        ? "Club Puebla"
        : teamMode === "named"
          ? value("predTeam").trim()
          : "",
    safety: Number(value("predSafety")),
    gamesMode,
    teamMode,
  };
}
export function plannerSummary(answers) {
  const date = parseBusinessDate(answers.targetDate + "T12:00");
  return [
    [
      "Fecha",
      date
        ? new Intl.DateTimeFormat("es-MX", {
            dateStyle: "full",
            timeZone: "America/Mexico_City",
          }).format(date)
        : "Falta elegir la fecha",
    ],
    ["Evento", typeLabels[answers.type] || "No lo sé todavía"],
    [
      "Partidos",
      answers.games == null
        ? "No lo sé; no se filtrará por cantidad"
        : answers.games === 0
          ? "No aplica: no habrá partidos"
          : String(answers.games),
    ],
    [
      "Equipo",
      answers.team ||
        (answers.teamMode === "none"
          ? "No aplica: sin equipo específico"
          : "No lo sé; no se filtrará por equipo"),
    ],
    ["Colchón", Math.round(answers.safety * 100) + "%"],
  ];
}
export function initPlanner({ onCalculate, onInvalidate, root = document }) {
  let step = 0,
    computed = false;
  const el = (id) => root.getElementById(id),
    steps = [...root.querySelectorAll("[data-planner-step]")];
  const tomorrow = parseBusinessDate(businessDate() + "T12:00");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  el("predDate").value = businessDate(tomorrow);
  el("predDate").min = businessDate();
  function invalidate() {
    computed = false;
    el("plannerResults").hidden = true;
    el("plannerEdit").hidden = true;
    onInvalidate();
  }
  function syncFields() {
    el("predGamesField").hidden = el("predGamesMode").value !== "known";
    el("predGames").disabled = el("predGamesMode").value !== "known";
    el("predTeamField").hidden = el("predTeamMode").value !== "named";
    el("predTeam").disabled = el("predTeamMode").value !== "named";
    const date = parseBusinessDate(el("predDate").value + "T12:00");
    el("plannerDateHint").textContent = date
      ? "Es " +
        new Intl.DateTimeFormat("es-MX", {
          weekday: "long",
          timeZone: "America/Mexico_City",
        }).format(date) +
        ". Buscaremos primero eventos del mismo día de la semana."
      : "La fecha permite distinguir entre semana y fin de semana.";
    el("plannerReview").innerHTML =
      '<dl class="planner-review">' +
      plannerSummary(readPlannerAnswers(root))
        .map(
          ([label, value]) =>
            "<div><dt>" + H(label) + "</dt><dd>" + H(value) + "</dd></div>",
        )
        .join("") +
      "</dl>";
  }
  function validate(index) {
    const a = readPlannerAnswers(root);
    if (
      index === 0 &&
      (!parseBusinessDate(a.targetDate + "T00:00") ||
        a.targetDate < businessDate())
    )
      return "Elige hoy o una fecha futura.";
    if (
      index === 2 &&
      a.gamesMode === "known" &&
      (!Number.isInteger(a.games) || a.games < 1 || a.games > 50)
    )
      return "Indica entre 1 y 50 partidos, o elige «No lo sé» / «No aplica».";
    if (
      index === 3 &&
      a.teamMode === "named" &&
      (!normalizeTeam(a.team) || a.team.length > 120)
    )
      return "Escribe el equipo, o elige «No lo sé» / «No aplica».";
    return "";
  }
  function show(index, { focus = true } = {}) {
    step = index;
    el("plannerQuestions").hidden = false;
    steps.forEach((node, i) => {
      node.hidden = i !== index;
    });
    root.querySelectorAll("[data-planner-progress]").forEach((node, i) => {
      node.classList.toggle("current", i === index);
      if (i === index) node.setAttribute("aria-current", "step");
      else node.removeAttribute("aria-current");
    });
    el("plannerStepText").textContent = "Paso " + (index + 1) + " de 5";
    el("plannerBack").hidden = index === 0;
    el("plannerNext").hidden = index === 4;
    el("btnPredict").hidden = index !== 4;
    el("plannerError").textContent = "";
    syncFields();
    if (focus) steps[index].querySelector("h3").focus?.();
  }
  function next() {
    const error = validate(step);
    if (error) {
      el("plannerError").textContent = error;
      return;
    }
    show(Math.min(step + 1, 4));
  }
  function calculate() {
    for (let i = 0; i < 4; i++) {
      const error = validate(i);
      if (error) {
        show(i);
        el("plannerError").textContent = error;
        return;
      }
    }
    computed = true;
    try {
      const ok = onCalculate();
      if (ok === false) {
        computed = false;
        el("plannerError").textContent ||=
          "No se pudo calcular la propuesta. Revisa los datos e inténtalo de nuevo.";
        return;
      }
    } catch (error) {
      computed = false;
      el("plannerError").textContent =
        error.message ||
        "No se pudo calcular la propuesta. Inténtalo de nuevo.";
      return;
    }
    el("plannerQuestions").hidden = true;
    el("plannerResults").hidden = false;
    el("plannerEdit").hidden = false;
    el("plannerResultTitle").focus?.();
  }
  el("plannerNext").addEventListener("click", next);
  el("plannerBack").addEventListener("click", () =>
    show(Math.max(0, step - 1)),
  );
  el("btnPredict").addEventListener("click", calculate);
  el("plannerEdit").addEventListener("click", () => {
    invalidate();
    show(4);
  });
  el("plannerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    step < 4 ? next() : calculate();
  });
  for (const id of [
    "predDate",
    "predType",
    "predGamesMode",
    "predGames",
    "predTeamMode",
    "predTeam",
    "predSafety",
  ]) {
    el(id).addEventListener("input", () => {
      invalidate();
      syncFields();
    });
    el(id).addEventListener("change", () => {
      invalidate();
      syncFields();
    });
  }
  show(0, { focus: false });
  return { hasResults: () => computed, refresh: syncFields };
}
