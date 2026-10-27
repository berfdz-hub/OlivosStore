import { businessDate, parseBusinessDate } from "./csv.js";
import { escapeHTML as H } from "./safe.js";
import {
  initGroupEditor,
  validateGroups,
  groupLabel,
  totalGames,
} from "./event-groups.js";
const editors = new WeakMap();
export function readPlannerAnswers(root = document) {
  const groups = editors.get(root)?.read() || [];
  return {
    targetDate: root.getElementById("predDate").value,
    groups,
    type: "mixto",
    games: totalGames(groups),
    team: "",
    safety: Number(root.getElementById("predSafety").value),
  };
}
export function plannerSummary(a) {
  const date = parseBusinessDate(a.targetDate + "T12:00");
  return [
    [
      "Fecha",
      date
        ? new Intl.DateTimeFormat("es-MX", {
            dateStyle: "full",
            timeZone: "America/Mexico_City",
          }).format(date)
        : "Elige la fecha",
    ],
    ...a.groups.map((g) => ["Actividad", groupLabel(g)]),
    [
      "Total",
      a.games == null ? "Hay cantidades por confirmar" : a.games + " partidos",
    ],
    ["Reserva adicional", Math.round(a.safety * 100) + "%"],
  ];
}
export function initPlanner({ onCalculate, onInvalidate, root = document }) {
  let step = 0,
    computed = false;
  const el = (id) => root.getElementById(id);
  const steps = [...root.querySelectorAll("[data-planner-step]")];
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
  function refresh() {
    const a = readPlannerAnswers(root),
      date = parseBusinessDate(a.targetDate + "T12:00");
    el("plannerDateHint").textContent = date
      ? "Es " +
        new Intl.DateTimeFormat("es-MX", {
          weekday: "long",
          timeZone: "America/Mexico_City",
        }).format(date) +
        ". Buscaremos primero jornadas del mismo día de la semana."
      : "Elige una fecha.";
    el("plannerReview").innerHTML =
      '<dl class="planner-review">' +
      plannerSummary(a)
        .map(
          ([label, value]) =>
            `<div><dt>${H(label)}</dt><dd>${H(value)}</dd></div>`,
        )
        .join("") +
      "</dl>";
  }
  function validate(index) {
    const a = readPlannerAnswers(root);
    if (
      !index &&
      (!parseBusinessDate(a.targetDate + "T00:00") ||
        a.targetDate < businessDate())
    )
      return "Elige hoy o una fecha futura.";
    if (index > 0) {
      try {
        validateGroups(a.groups);
      } catch (e) {
        return e.message;
      }
    }
    return "";
  }
  function show(index, focus = true) {
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
    el("plannerStepText").textContent = "Paso " + (index + 1) + " de 3";
    el("plannerBack").hidden = index === 0;
    el("plannerNext").hidden = index === 2;
    el("btnPredict").hidden = index !== 2;
    el("plannerNext").textContent =
      index === 1 ? "Revisar jornada" : "Elegir actividades";
    el("plannerError").textContent = "";
    refresh();
    if (focus) steps[index].querySelector("h3").focus?.();
  }
  function next() {
    const error = validate(step);
    if (error) {
      el("plannerError").textContent = error;
      return;
    }
    show(Math.min(step + 1, 2));
  }
  function calculate() {
    for (let i = 0; i < 2; i++) {
      const error = validate(i);
      if (error) {
        show(i);
        el("plannerError").textContent = error;
        return;
      }
    }
    computed = true;
    try {
      if (onCalculate() === false) {
        computed = false;
        el("plannerError").textContent ||=
          "No se pudo calcular. Revisa los datos.";
        return;
      }
    } catch (e) {
      computed = false;
      el("plannerError").textContent = e.message;
      return;
    }
    el("plannerQuestions").hidden = true;
    el("plannerResults").hidden = false;
    el("plannerEdit").hidden = false;
    el("plannerResultTitle").focus?.();
  }
  editors.set(
    root,
    initGroupEditor({
      root,
      id: "predActivities",
      onChange: () => {
        invalidate();
        refresh();
      },
    }),
  );
  el("plannerNext").addEventListener("click", next);
  el("plannerBack").addEventListener("click", () =>
    show(Math.max(step - 1, 0)),
  );
  el("btnPredict").addEventListener("click", calculate);
  el("plannerEdit").addEventListener("click", () => {
    invalidate();
    show(1);
  });
  el("plannerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    step < 2 ? next() : calculate();
  });
  for (const id of ["predDate", "predSafety"])
    for (const event of ["input", "change"])
      el(id).addEventListener(event, () => {
        invalidate();
        refresh();
      });
  show(0, false);
  return {
    hasResults: () => computed,
    refresh,
    set(a) {
      invalidate();
      el("predDate").value = a.targetDate;
      const safety = el("predSafety");
      for (const o of safety.options)
        o.selected = Number(o.value) === Number(a.safety ?? 0.1);
      editors.get(root).set(a.groups || []);
      show(2);
    },
    calculate,
  };
}
