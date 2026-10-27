import { inventoryAt } from "./accounting.js";
import { businessDate, parseBusinessDate } from "./csv.js";
import {
  normalizeTeam,
  validateGroups,
  totalGames,
  matchesComposition,
} from "./event-groups.js";
import { predictByEvent } from "./event-prediction.js";
export { normalizeTeam } from "./event-groups.js";

export const MODEL_VERSION = "eventos-2026-10-v4";
export const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const weekend = (date) => [0, 6].includes(weekday(date));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const finite = (value) => value != null && Number.isFinite(Number(value));
function matchesTeam(day, team) {
  if (!team) return true;
  if (!normalizeTeam(team)) return false;
  const named = normalizeTeam(day.event_name);
  if ((" " + named + " ").includes(" " + normalizeTeam(team) + " "))
    return true;
  return (
    normalizeTeam(team) === "club puebla" &&
    (day.event_tags || []).includes("club_puebla")
  );
}
function recordedGames(index, day) {
  if (day.event_groups?.length) return totalGames(day.event_groups);
  return index.games.has(day.id)
    ? index.games.get(day.id)
    : day.day_type === "entrenamiento_normal"
      ? 0
      : null;
}
export function eventType(day) {
  if (day.event_groups?.length) {
    const keys = new Set(
      day.event_groups.map(
        (g) => g.type + "|" + (normalizeTeam(g.team) || g.teamMode),
      ),
    );
    if (keys.size > 1) return "mixto";
    const g = day.event_groups[0];
    return normalizeTeam(g.team) === "club puebla" && g.type === "futbol"
      ? "club_puebla"
      : g.type;
  }
  if (
    (day.event_tags || []).includes("futbol") &&
    (day.event_tags || []).includes("beisbol")
  )
    return "mixto";
  if (
    (day.event_tags || []).includes("club_puebla") ||
    /club\s*puebla/i.test(day.event_name || "")
  )
    return "club_puebla";
  if (day.day_type === "entrenamiento_normal") return "entrenamiento";
  return ["futbol", "beisbol"].includes(day.sport) ? day.sport : "otro";
}

function historyIndex(history) {
  const games = new Map(),
    tickets = new Map(),
    lines = new Map();
  for (const game of history.games)
    games.set(game.sale_day_id, (games.get(game.sale_day_id) || 0) + 1);
  for (const ticket of history.tickets) {
    if (!tickets.has(ticket.sale_day_id)) tickets.set(ticket.sale_day_id, []);
    tickets.get(ticket.sale_day_id).push(ticket);
  }
  for (const item of history.items) {
    if (!lines.has(item.ticket_id)) lines.set(item.ticket_id, []);
    lines.get(item.ticket_id).push(item);
  }
  const units = new Map(),
    complete = new Set();
  for (const day of history.days) {
    const receipts = tickets.get(day.id) || [];
    if (
      !receipts.length ||
      receipts.some(
        (t) =>
          !lines.get(t.id)?.length ||
          lines.get(t.id).some((i) => !i.product_id || !finite(i.qty)),
      )
    )
      continue;
    complete.add(day.id);
    const byProduct = new Map();
    for (const ticket of receipts)
      for (const item of lines.get(ticket.id)) {
        byProduct.set(
          item.product_id,
          (byProduct.get(item.product_id) || 0) + Number(item.qty),
        );
      }
    for (const [id, value] of byProduct) byProduct.set(id, Math.max(0, value));
    units.set(day.id, byProduct);
  }
  return { games, units, complete };
}

export function evaluatePlans(plans, history, today = businessDate()) {
  const index = historyIndex(history);
  const latest = new Map();
  for (const plan of plans) {
    if (
      plan.event_date >= today ||
      businessDate(new Date(plan.created_at)) > plan.event_date
    )
      continue;
    const day = history.days.find((d) => d.date === plan.event_date);
    const starts = history.games
      .filter((g) => g.sale_day_id === day?.id && g.start_time)
      .map((g) =>
        parseBusinessDate(plan.event_date + "T" + g.start_time)?.getTime(),
      )
      .filter(Number.isFinite);
    const sales = history.tickets
      .filter((t) => t.sale_day_id === day?.id)
      .map((t) => Date.parse(t.ts))
      .filter(Number.isFinite);
    const cutoff = starts.length
      ? Math.min(...starts)
      : sales.length
        ? Math.min(...sales)
        : parseBusinessDate(plan.event_date + "T00:00").getTime();
    if (Date.parse(plan.created_at) >= cutoff) continue;
    const current = latest.get(plan.event_date);
    if (!current || plan.created_at > current.created_at)
      latest.set(plan.event_date, plan);
  }
  return [...latest.values()]
    .map((plan) => {
      const day = history.days.find((d) => d.date === plan.event_date);
      const sameContext =
        day &&
        (plan.summary?.groups?.length
          ? matchesComposition(plan.summary.groups, day.event_groups)
          : (plan.event_type === "sin_especificar" ||
              eventType(day) === plan.event_type) &&
            (plan.games == null ||
              recordedGames(index, day) === Number(plan.games)) &&
            matchesTeam(day, plan.summary?.team));
      const complete = !!(
        !plan.summary?.partial &&
        !plan.summary?.manual &&
        !plan.summary?.draft &&
        day &&
        day.status === "reviewed" &&
        index.complete.has(day.id) &&
        sameContext
      );
      const actual = index.units.get(day?.id) || new Map();
      const predicted = new Map(
        (plan.rows || []).map((row) => [row.productId, Number(row.expected)]),
      );
      const ids = new Set([...actual.keys(), ...predicted.keys()]);
      const rows = [...ids].map((productId) => ({
        productId,
        expected: predicted.get(productId) || 0,
        actual: actual.get(productId) || 0,
      }));
      const error = rows.reduce(
        (s, r) => s + Math.abs(r.actual - r.expected),
        0,
      );
      const totalActual = rows.reduce((s, r) => s + r.actual, 0);
      return {
        plan,
        complete,
        rows,
        totalActual,
        error,
        wape: complete && totalActual > 0 ? error / totalActual : null,
        status:
          plan.summary?.manual || plan.summary?.draft
            ? "Borrador o decisión manual; no entrena el predictor"
            : plan.summary?.partial
              ? "Propuesta parcial; faltaron referencias"
              : !day
                ? "Falta capturar el día"
                : !sameContext
                  ? "Cambió el evento; revisar comparación"
                  : !complete
                    ? "Cerrar y completar el día para evaluar"
                    : "Evaluado",
      };
    })
    .sort((a, b) => b.plan.event_date.localeCompare(a.plan.event_date));
}

export function predictPurchase({
  history,
  products,
  plans = [],
  targetDate,
  type,
  games,
  groups = null,
  team = "",
  safety = 0.1,
  now = new Date(),
}) {
  const today = businessDate(now);
  type = type || "sin_especificar";
  if (groups) {
    validateGroups(groups);
    type = "mixto";
    games = totalGames(groups);
    team = "";
  }
  team = String(team).trim();
  if (team.length > 120)
    throw new Error("El nombre del equipo es demasiado largo.");
  if (team && !normalizeTeam(team))
    throw new Error("Escribe un nombre de equipo válido.");
  if (
    normalizeTeam(team) === "club puebla" &&
    ["futbol", "sin_especificar"].includes(type)
  )
    type = "club_puebla";
  if (!parseBusinessDate(targetDate + "T00:00") || targetDate < today)
    throw new Error("Elige hoy o una fecha futura para preparar la compra.");
  if (
    ![
      "club_puebla",
      "futbol",
      "beisbol",
      "entrenamiento",
      "otro",
      "sin_especificar",
      "mixto",
    ].includes(type) ||
    (games != null && (!Number.isInteger(games) || games < 0 || games > 50))
  )
    throw new Error("Revisa el tipo de evento y el número de partidos.");
  if (!Number.isFinite(safety) || safety < 0 || safety > 0.5)
    throw new Error("El colchón debe estar entre 0% y 50%.");
  if (type === "mixto" && !groups)
    throw new Error("Agrega los grupos del día.");
  if (groups)
    return predictByEvent({
      history,
      products,
      targetDate,
      groups,
      safety,
      now,
      modelVersion: MODEL_VERSION,
    });
  const index = historyIndex(history);
  const warnings = [];
  if (type === "sin_especificar")
    warnings.push(
      "No se indicó el tipo de evento: se comparan distintos tipos y la confianza es baja.",
    );
  if (games == null)
    warnings.push(
      "El número de partidos es desconocido; no se usa como filtro y no se interpreta como cero.",
    );
  const typeMatch = (d) => type === "sin_especificar" || eventType(d) === type;
  const count = (d) => recordedGames(index, d);
  const candidates = history.days.filter(
    (d) =>
      d.date < targetDate &&
      d.date < today &&
      typeMatch(d) &&
      matchesTeam(d, team) &&
      index.complete.has(d.id) &&
      (games == null || count(d) != null),
  );
  if (team && !candidates.length)
    warnings.push(
      "No hay referencias completas de ese equipo. Puedes volver y elegir «No lo sé» para calcular sin filtrar por equipo; no se sustituyen sus datos automáticamente.",
    );
  const sameDay = (d) => weekday(d.date) === weekday(targetDate);
  const sameGroup = (d) => weekend(d.date) === weekend(targetDate);
  const closeCount = (d) =>
    games == null ||
    (Math.abs(count(d) - games) <= 1 &&
      (games === 0 ? count(d) === 0 : count(d) > 0));
  const tiers =
    games == null
      ? [
          {
            label:
              "Mismo día de la semana; cantidad de partidos sin especificar",
            days: candidates.filter(sameDay),
          },
          {
            label: weekend(targetDate)
              ? "Fin de semana; cantidad de partidos sin especificar"
              : "Entre semana; cantidad de partidos sin especificar",
            days: candidates.filter(sameGroup),
          },
        ]
      : [
          {
            label: "Mismo día de la semana y mismo número de partidos",
            days: candidates.filter((d) => sameDay(d) && count(d) === games),
          },
          {
            label: "Mismo día de la semana y hasta un partido de diferencia",
            days: candidates.filter((d) => sameDay(d) && closeCount(d)),
          },
          {
            label: weekend(targetDate)
              ? "Fin de semana y mismo número de partidos"
              : "Entre semana y mismo número de partidos",
            days: candidates.filter((d) => sameGroup(d) && count(d) === games),
          },
          {
            label: weekend(targetDate)
              ? "Fin de semana y hasta un partido de diferencia"
              : "Entre semana y hasta un partido de diferencia",
            days: candidates.filter((d) => sameGroup(d) && closeCount(d)),
          },
        ];
  const tier = tiers.findIndex((t) => t.days.length >= 3);
  const chosen = tier >= 0 ? tier : tiers.findIndex((t) => t.days.length > 0);
  const comparison =
    chosen < 0
      ? {
          days: [],
          label: "No hay eventos comparables con información completa",
        }
      : tiers[chosen];
  const sample = [...comparison.days]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 12);
  const evaluations = evaluatePlans(plans, history, today)
    .filter(
      (e) =>
        e.complete &&
        games != null &&
        type !== "sin_especificar" &&
        e.plan.event_type === type &&
        normalizeTeam(e.plan.summary?.team) === normalizeTeam(team) &&
        weekday(e.plan.event_date) === weekday(targetDate) &&
        e.plan.games != null &&
        Number(e.plan.games) === games &&
        e.plan.model_version === MODEL_VERSION,
    )
    .slice(0, 12);
  const stock = inventoryAt(history, now.toISOString());
  const rows = products
    .filter((p) => p.active !== false)
    .flatMap((product) => {
      const values = sample.map(
        (d) => index.units.get(d.id).get(product.id) || 0,
      );
      if (!values.some((v) => v > 0)) return [];
      const corrections = evaluations.flatMap((e) => {
        const row = e.rows.find((r) => r.productId === product.id);
        return row?.expected > 0 ? [row.actual / row.expected] : [];
      });
      const factor =
        corrections.length >= 3
          ? Math.max(0.75, Math.min(1.25, median(corrections)))
          : 1;
      const base = values.reduce((a, b) => a + b, 0) / values.length;
      const expected = Math.round(base * factor * 100) / 100;
      // Avoid adding a unit when e.g. 100 * 1.1 is 110.00000000000001.
      const demand = Math.ceil(Math.round(expected * (1 + safety) * 1e8) / 1e8);
      const reference = stock.get(product.id);
      const inventory =
        reference && !reference.uncertain && !reference.inconsistent
          ? reference.value
          : null;
      const rawBuy =
        inventory == null ? null : Math.max(0, Math.ceil(demand - inventory));
      const limits = [
        product.storage_limit,
        product.perishable ? product.perishable_limit : null,
      ]
        .filter(finite)
        .map(Number);
      const limit = limits.length ? Math.min(...limits) : null;
      const missingLimit =
        !!product.perishable &&
        (!finite(product.storage_limit) || !finite(product.perishable_limit));
      const buy =
        rawBuy == null || missingLimit
          ? null
          : limit == null
            ? rawBuy
            : Math.min(rawBuy, Math.max(0, Math.floor(limit - inventory)));
      return [
        {
          productId: product.id,
          name: product.name,
          expected,
          demand,
          low: Math.floor(Math.min(...values)),
          high: Math.ceil(Math.max(...values)),
          inventory,
          stockDate: reference?.date || null,
          rawBuy,
          buy,
          limit,
          missingLimit,
          capped: buy != null && buy < rawBuy,
          factor,
          observedDays: values.filter((v) => v > 0).length,
        },
      ];
    })
    .sort((a, b) => b.demand - a.demand);
  const confidence =
    chosen === 0 &&
    games != null &&
    type !== "sin_especificar" &&
    sample.length >= 5 &&
    sample.every((d) => d.status === "reviewed")
      ? "media"
      : "baja";
  return {
    modelVersion: MODEL_VERSION,
    targetDate,
    type,
    games,
    team,
    warnings,
    safety,
    comparison: comparison.label,
    tier: chosen,
    confidence,
    days: sample.map((d) => ({
      id: d.id,
      date: d.date,
      games: count(d),
      closed: d.status === "reviewed",
    })),
    rows,
    evaluations,
    excludedIncomplete: history.days.filter(
      (d) =>
        d.date < today &&
        d.date < targetDate &&
        typeMatch(d) &&
        matchesTeam(d, team) &&
        !index.complete.has(d.id),
    ).length,
  };
}
