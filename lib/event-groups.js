import { escapeHTML as H } from "./safe.js";

export const eventLabels = {
  sin_especificar: "No lo sé todavía",
  futbol: "Fútbol",
  beisbol: "Béisbol / Softbol",
  entrenamiento: "Entrenamiento",
  otro: "Otro evento",
};
export const teamLabels = {
  unknown: "No lo sé todavía",
  none: "No aplica / sin equipo específico",
  club_puebla: "Club Puebla",
  academy: "Academia / escuela",
  non_club: "Otros equipos (sin Club Puebla)",
  named: "Un equipo específico",
};
export const normalizeTeam = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export const totalGames = (groups) =>
  groups.some((g) => g.games == null)
    ? null
    : groups.reduce((n, g) => n + g.games, 0);
export function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 12)
    throw new Error("Agrega entre 1 y 12 grupos de eventos.");
  for (const [i, g] of groups.entries()) {
    if (
      !g ||
      !Object.hasOwn(eventLabels, g.type) ||
      !Object.hasOwn(teamLabels, g.teamMode)
    )
      throw new Error("Revisa el tipo y equipo del grupo " + (i + 1) + ".");
    if (
      g.games !== null &&
      (!Number.isInteger(g.games) || g.games < 0 || g.games > 50)
    )
      throw new Error(
        "Revisa los partidos del grupo " +
          (i + 1) +
          ": entre 1 y 50, No lo sé o No aplica.",
      );
    if (
      typeof g.team !== "string" ||
      g.team.length > 120 ||
      (g.teamMode === "named" && !normalizeTeam(g.team))
    )
      throw new Error(
        "Escribe el equipo del grupo " +
          (i + 1) +
          ", o elige No lo sé / No aplica.",
      );
    if (
      (g.teamMode === "club_puebla" && g.team !== "Club Puebla") ||
      (!["named", "club_puebla"].includes(g.teamMode) && g.team !== "")
    )
      throw new Error("Revisa el equipo del grupo " + (i + 1) + ".");
    if (g.slots != null) {
      if (
        !Array.isArray(g.slots) ||
        g.slots.length > (g.games == null ? 0 : Math.max(1, g.games))
      )
        throw new Error("Revisa los horarios del grupo " + (i + 1) + ".");
      for (const slot of g.slots)
        if (
          !slot ||
          !["start", "end"].every(
            (k) =>
              typeof slot[k] === "string" &&
              (!slot[k] || /^([01]\d|2[0-3]):[0-5]\d$/.test(slot[k])),
          ) ||
          (slot.start && slot.end && slot.end <= slot.start)
        )
          throw new Error(
            "El fin debe ser posterior al inicio, dentro del mismo día, en el grupo " +
              (i + 1) +
              ".",
          );
    }
  }
  if (groups.reduce((n, g) => n + (g.games || 0), 0) > 50)
    throw new Error("El total del día no puede superar 50 partidos.");
  return groups;
}
export const groupLabel = (g) =>
  `${eventLabels[g.type] || "Evento"} · ${g.games == null ? "partidos por confirmar" : g.games === 0 ? "sin partidos" : g.games + " partido(s)"} · ${g.team || teamLabels[g.teamMode] || "equipo por confirmar"}${g.slots?.length ? " · " + (g.slots.every((s) => !s.start && !s.end) ? "horarios por confirmar" : g.slots.map((s) => (s.start || "inicio por confirmar") + "–" + (s.end || "fin por confirmar")).join(", ")) : ""}`;
const club = (g) =>
  g.teamMode === "club_puebla" || normalizeTeam(g.team) === "club puebla";
const nonClub = (g) =>
  ["non_club", "academy"].includes(g.teamMode) ||
  (g.teamMode === "named" && !club(g));
const sum = (groups) => totalGames(groups);
// Compare whole days. A product's sales are never added once per event group.
export function matchesComposition(wanted, actual, tolerance = 0) {
  if (!actual?.length) return false;
  const knownTypes = new Set(
    wanted.filter((g) => g.type !== "sin_especificar").map((g) => g.type),
  );
  const unknownType = wanted.some((g) => g.type === "sin_especificar");
  if ([...knownTypes].some((t) => !actual.some((g) => g.type === t)))
    return false;
  if (!unknownType && actual.some((g) => !knownTypes.has(g.type))) return false;
  const close = (a, b) =>
    a == null ||
    (b != null && Math.abs(a - b) <= tolerance && (a === 0 ? b === 0 : b > 0));
  if (!close(sum(wanted), sum(actual))) return false;
  for (const type of new Set(wanted.map((g) => g.type))) {
    const w = wanted.filter((g) => g.type === type),
      a = actual.filter((g) => type === "sin_especificar" || g.type === type);
    if (!close(sum(w), sum(a))) return false;
    if (
      w.some(club) &&
      (!a.some(club) || !close(sum(w.filter(club)), sum(a.filter(club))))
    )
      return false;
    if (
      w.some((g) => g.teamMode === "academy") &&
      (!a.some((g) => g.teamMode === "academy") ||
        !close(
          sum(w.filter((g) => g.teamMode === "academy")),
          sum(a.filter((g) => g.teamMode === "academy")),
        ))
    )
      return false;
    if (
      w.some((g) => g.teamMode === "non_club") &&
      (!a.some(nonClub) ||
        !close(sum(w.filter(nonClub)), sum(a.filter(nonClub))))
    )
      return false;
    for (const name of new Set(
      w
        .filter((g) => g.teamMode === "named" && !club(g))
        .map((g) => normalizeTeam(g.team)),
    )) {
      const peers = a.filter((g) => normalizeTeam(g.team) === name);
      if (
        !peers.length ||
        !close(sum(w.filter((g) => normalizeTeam(g.team) === name)), sum(peers))
      )
        return false;
    }
  }
  return true;
}
export function compositionKey(groups) {
  const buckets = new Map();
  for (const g of groups || []) {
    const key =
      g.type +
      "|" +
      (club(g)
        ? "club_puebla"
        : g.teamMode === "named"
          ? normalizeTeam(g.team)
          : g.teamMode);
    const prior = buckets.get(key);
    buckets.set(
      key,
      prior === null || g.games === null ? null : (prior || 0) + g.games,
    );
  }
  return JSON.stringify([...buckets].sort(([a], [b]) => a.localeCompare(b)));
}

// The same editor records the actual day and asks the planner's three questions.
export function initGroupEditor({
  root = document,
  id,
  containers,
  groups = [],
  onChange = () => {},
}) {
  const el = (name) => root.getElementById(name);
  const staged = !!containers;
  const targets = staged ? containers : { types: id, games: id, teams: id };
  let rows = groups.map((g) => ({ ...g }));
  const blank = () => ({
    type: "sin_especificar",
    games: null,
    teamMode: "unknown",
    team: "",
  });
  const field = (i, key) => `${id}-${i}-${key}`;
  function read() {
    return rows.map((_, i) => {
      const mode = el(field(i, "gamesMode")).value,
        teamMode = el(field(i, "teamMode")).value;
      return {
        type: el(field(i, "type")).value,
        games:
          mode === "none"
            ? 0
            : mode === "known"
              ? el(field(i, "games")).value === ""
                ? NaN
                : Number(el(field(i, "games")).value)
              : null,
        teamMode,
        team:
          teamMode === "club_puebla"
            ? "Club Puebla"
            : teamMode === "named"
              ? el(field(i, "team")).value.trim()
              : "",
        slots:
          mode === "unknown"
            ? []
            : [...el(field(i, "slots")).querySelectorAll("[data-slot]")].map(
                (row) => ({
                  start: row.querySelector("[data-start]").value,
                  end: row.querySelector("[data-end]").value,
                }),
              ),
      };
    });
  }
  const select = (i, key, label, options, value) =>
    `<div class="field"><label for="${field(i, key)}">${label} · grupo ${i + 1}</label><select id="${field(i, key)}">${Object.entries(
      options,
    )
      .map(
        ([v, t]) =>
          `<option value="${v}" ${value === v ? "selected" : ""}>${H(t)}</option>`,
      )
      .join("")}</select></div>`;
  function parts(g, i) {
    return {
      types:
        select(i, "type", "Tipo de evento", eventLabels, g.type) +
        `<button class="btn sec sm" type="button" data-remove-group="${i}" aria-label="Quitar grupo ${i + 1}">Quitar grupo</button>`,
      games:
        select(
          i,
          "gamesMode",
          "Cantidad",
          {
            unknown: "No lo sé todavía",
            known: "Sí sé cuántos",
            none: "No aplica: cero partidos",
          },
          g.games == null ? "unknown" : g.games === 0 ? "none" : "known",
        ) +
        `<div class="field" id="${field(i, "gamesField")}"><label for="${field(i, "games")}">Partidos · grupo ${i + 1}</label><input type="number" min="1" max="50" step="1" id="${field(i, "games")}" value="${g.games > 0 ? g.games : ""}"></div><div id="${field(i, "slots")}"></div>`,
      teams:
        select(i, "teamMode", "Equipo", teamLabels, g.teamMode) +
        `<div class="field" id="${field(i, "teamField")}"><label for="${field(i, "team")}">Nombre del equipo · grupo ${i + 1}</label><input id="${field(i, "team")}" maxlength="120" value="${H(g.team)}" placeholder="Ej. Tigres"></div>`,
    };
  }
  function sync() {
    for (let i = 0; i < rows.length; i++) {
      const gamesKnown = el(field(i, "gamesMode")).value === "known",
        named = el(field(i, "teamMode")).value === "named";
      el(field(i, "gamesField")).hidden = !gamesKnown;
      el(field(i, "games")).disabled = !gamesKnown;
      el(field(i, "teamField")).hidden = !named;
      el(field(i, "team")).disabled = !named;
      const host = el(field(i, "slots")),
        mode = el(field(i, "gamesMode")).value;
      const n =
        mode === "unknown"
          ? 0
          : mode === "none"
            ? 1
            : Math.max(
                0,
                Math.min(50, Number(el(field(i, "games")).value) || 0),
              );
      host.hidden = !n;
      if (n && host.querySelectorAll("[data-slot]").length !== n) {
        const existing = [...host.querySelectorAll("[data-slot]")].map(
          (row) => ({
            start: row.querySelector("[data-start]").value,
            end: row.querySelector("[data-end]").value,
          }),
        );
        host.innerHTML =
          Array.from({ length: n }, (_, j) => {
            const s = existing[j] || rows[i].slots?.[j] || {};
            return `<div data-slot="${j}" class="grid grid2"><div class="field"><label for="${field(i, "start" + j)}">Inicio · grupo ${i + 1}, ${mode === "none" ? "actividad" : "partido"} ${j + 1}</label><input type="time" data-start id="${field(i, "start" + j)}" value="${H(s.start || "")}"></div><div class="field"><label for="${field(i, "end" + j)}">Fin · grupo ${i + 1}, ${mode === "none" ? "actividad" : "partido"} ${j + 1}</label><input type="time" data-end id="${field(i, "end" + j)}" value="${H(s.end || "")}"></div></div>`;
          }).join("") +
          '<p class="hint">Franja de ventas asociada al partido. Incluye atención antes y después si corresponde. Puedes dejar horarios por confirmar; sin una franja comparable no habrá una estimación individual fiable.</p>';
      }
      root
        .querySelectorAll(`[data-group-title="${id}-${i}"]`)
        .forEach(
          (n) =>
            (n.textContent = `Grupo ${i + 1} · ${eventLabels[el(field(i, "type")).value]}`),
        );
    }
  }
  function render() {
    const html = { types: [], games: [], teams: [] };
    rows.forEach((g, i) => {
      const p = parts(g, i);
      for (const k of Object.keys(html))
        html[k].push(
          `<fieldset class="event-group"><legend data-group-title="${id}-${i}">Grupo ${i + 1}</legend>${staged ? p[k] : Object.values(p).join("")}</fieldset>`,
        );
    });
    const add = `<button type="button" class="btn sec" id="${id}-add" ${rows.length >= 12 ? "disabled" : ""}>+ Agregar grupo</button><p class="hint">Cada partido se cuenta una sola vez. Separa Club Puebla de otros equipos y agrega otro grupo para cada deporte o equipo.</p>`;
    if (staged) {
      for (const k of Object.keys(html))
        el(targets[k]).innerHTML =
          html[k].join("") + (k === "types" ? add : "");
    } else el(id).innerHTML = html.types.join("") + add;
    el(id + "-add").addEventListener("click", () => {
      rows = read();
      if (rows.length < 12) rows.push(blank());
      render();
      onChange();
    });
    el(targets.types)
      .querySelectorAll("[data-remove-group]")
      .forEach((b) =>
        b.addEventListener("click", () => {
          rows = read();
          rows.splice(Number(b.dataset.removeGroup), 1);
          render();
          onChange();
        }),
      );
    sync();
  }
  for (const container of new Set(Object.values(targets)))
    for (const event of ["input", "change"])
      el(container).addEventListener(event, () => {
        sync();
        onChange();
      });
  render();
  return {
    read,
    set(groups) {
      rows = groups.map((g) => ({ ...g }));
      render();
    },
    validate() {
      return validateGroups(read());
    },
  };
}
