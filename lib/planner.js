import { businessDate, parseBusinessDate } from "./csv.js";
import { escapeHTML as H } from "./safe.js";
import { normalizeTeam } from "./prediction.js";
import {
  initGroupEditor,
  validateGroups,
  groupLabel,
  totalGames,
} from "./event-groups.js";

const editors = new WeakMap();

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
  const groups =
    value("predComposition") === "groups"
      ? editors.get(root)?.read() || []
      : null;
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
    ...(groups
      ? { groups, type: "mixto", games: totalGames(groups), team: "" }
      : {}),
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
    [
      "Evento",
      answers.groups
        ? "Combinación de " + answers.groups.length + " grupos"
        : typeLabels[answers.type] || "No lo sé todavía",
    ],
    ...(answers.groups || []).map((g, i) => [
      "Grupo " + (i + 1),
      groupLabel(g),
    ]),
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
      answers.groups
        ? "Indicado en cada grupo"
        : answers.team ||
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
    const mixed = el("predComposition").value === "groups";
    for (const [one, many] of [
      ["predSingleType", "predGroupTypes"],
      ["predSingleGames", "predGroupGames"],
      ["predSingleTeam", "predGroupTeams"],
    ]) {
      el(one).hidden = mixed;
      el(many).hidden = !mixed;
    }
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
    if (a.groups && index > 0 && index < 4) {
      if (index === 1 && !a.groups.length)
        return "Agrega al menos un grupo de eventos.";
      try {
        // Validate only the question being answered; later answers remain optional.
        validateGroups(
          a.groups.map((g) => ({
            ...g,
            games: index < 2 ? null : g.games,
            slots: index < 2 ? [] : g.slots,
            teamMode: index < 3 ? "unknown" : g.teamMode,
            team: index < 3 ? "" : g.team,
          })),
        );
      } catch (error) {
        return error.message;
      }
      return "";
    }
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
    "predComposition",
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
  editors.set(
    root,
    initGroupEditor({
      root,
      id: "predGroups",
      containers: {
        types: "predGroupTypes",
        games: "predGroupGames",
        teams: "predGroupTeams",
      },
      groups: [
        { type: "futbol", games: null, teamMode: "unknown", team: "" },
        { type: "futbol", games: null, teamMode: "unknown", team: "" },
      ],
      onChange: () => {
        invalidate();
        syncFields();
      },
    }),
  );
  show(0, { focus: false });
  return { hasResults: () => computed, refresh: syncFields };
}
