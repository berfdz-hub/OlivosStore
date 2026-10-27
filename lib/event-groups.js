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
export const periodLabels = {
  unknown: "Sin horario definido",
  morning: "Por la mañana",
  afternoon: "Por la tarde",
  evening: "Por la noche",
};
export function activityName(g) {
  if (g.teamMode === "club_puebla")
    return "Club Puebla · " + eventLabels[g.type];
  if (g.teamMode === "academy") return "Academia · " + eventLabels[g.type];
  return (g.team ? g.team + " · " : "") + (eventLabels[g.type] || "Actividad");
}
export function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 12)
    throw new Error("Agrega entre 1 y 12 actividades.");
  for (const [i, g] of groups.entries()) {
    if (
      !g ||
      !Object.hasOwn(eventLabels, g.type) ||
      !Object.hasOwn(teamLabels, g.teamMode)
    )
      throw new Error(
        "Revisa el tipo y equipo de la actividad " + (i + 1) + ".",
      );
    if (g.period != null && !Object.hasOwn(periodLabels, g.period))
      throw new Error("Revisa el horario de la actividad " + (i + 1) + ".");
    if (
      g.games !== null &&
      (!Number.isInteger(g.games) || g.games < 0 || g.games > 50)
    )
      throw new Error(
        "Revisa los partidos de la actividad " +
          (i + 1) +
          ": entre 1 y 50, No lo sé o No aplica.",
      );
    if (
      typeof g.team !== "string" ||
      g.team.length > 120 ||
      (g.teamMode === "named" && !normalizeTeam(g.team))
    )
      throw new Error(
        "Escribe el equipo de la actividad " +
          (i + 1) +
          ", o elige No lo sé / No aplica.",
      );
    if (
      (g.teamMode === "club_puebla" && g.team !== "Club Puebla") ||
      (!["named", "club_puebla"].includes(g.teamMode) && g.team !== "")
    )
      throw new Error("Revisa el equipo de la actividad " + (i + 1) + ".");
    if (g.slots != null) {
      if (
        !Array.isArray(g.slots) ||
        g.slots.length > (g.games == null ? 0 : Math.max(1, g.games))
      )
        throw new Error("Revisa los horarios de la actividad " + (i + 1) + ".");
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
            "El fin debe ser posterior al inicio, dentro del mismo día, en la actividad " +
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
  `${activityName(g)} · ${g.games == null ? "cantidad por confirmar" : g.games === 0 ? "sin partidos" : g.games + (g.games === 1 ? " partido" : " partidos")}${g.slots?.some((s) => s.start) ? " · inicios: " + g.slots.map((s) => s.start || "por confirmar").join(", ") : g.period && g.period !== "unknown" ? " · " + periodLabels[g.period] : " · horario opcional"}`;
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

export { initActivityEditor as initGroupEditor } from "./activity-editor.js";
