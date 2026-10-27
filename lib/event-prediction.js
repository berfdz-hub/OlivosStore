import { businessDate, parseBusinessDate } from "./csv.js";
import { inventoryAt } from "./accounting.js";
import {
  normalizeTeam,
  groupLabel,
  totalGames,
  compositionKey,
} from "./event-groups.js";

const weekday = (d) => new Date(d + "T12:00Z").getUTCDay();
const weekend = (d) => [0, 6].includes(weekday(d));
const minute = (s) =>
  /^\d\d:\d\d/.test(s || "")
    ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
    : null;
const epoch = (date, time) => parseBusinessDate(date + "T" + time)?.getTime();
const stamp = (t) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(t));
const club = (g) =>
  g.teamMode === "club_puebla" || normalizeTeam(g.team) === "club puebla";
function identity(g) {
  return (
    g.type +
    "|" +
    (club(g)
      ? "club_puebla"
      : g.teamMode === "named"
        ? normalizeTeam(g.team)
        : g.teamMode)
  );
}
function compatible(w, a) {
  if ((w.games === 0) !== (a.games === 0)) return false;
  if (w.type !== "sin_especificar" && w.type !== a.type) return false;
  if (club(w)) return club(a);
  if (w.teamMode === "academy") return a.teamMode === "academy";
  if (w.teamMode === "named")
    return normalizeTeam(w.team) === normalizeTeam(a.team);
  if (w.teamMode === "non_club")
    return (
      a.teamMode === "non_club" ||
      a.teamMode === "academy" ||
      (a.teamMode === "named" && !club(a))
    );
  return true;
}
function legacyGroups(day, games) {
  const sports = new Set(
    (day.event_tags || []).filter((t) => ["futbol", "beisbol"].includes(t)),
  );
  if (sports.size > 1) return [];
  if (!games.length)
    return day.day_type === "entrenamiento_normal"
      ? [
          {
            type: "entrenamiento",
            teamMode: "none",
            team: "",
            games: 0,
            slots: [],
          },
        ]
      : [];
  return games.map((g) => {
    const name = [day.event_name, g.notes].filter(Boolean).join(" ");
    const isClub =
      (day.event_tags || []).includes("club_puebla") ||
      /club\s*puebla/i.test(name);
    const academy = /academia|escuela/i.test(name);
    return {
      type: isClub ? "futbol" : day.sport,
      teamMode: isClub ? "club_puebla" : academy ? "academy" : "unknown",
      team: isClub ? "Club Puebla" : "",
      games: 1,
      slots: [{ start: (g.start_time || "").slice(0, 5), end: "" }],
    };
  });
}
function expand(groups) {
  return groups.flatMap((g, gi) =>
    Array.from(
      { length: g.games == null ? 1 : Math.max(1, g.games) },
      (_, i) => ({
        group: g,
        groupIndex: gi,
        number: i + 1,
        start: g.slots?.[i]?.start || "",
        end: g.slots?.[i]?.end || "",
        unknownCount: g.games == null,
      }),
    ),
  );
}
function historicalSamples(history, today, targetDate) {
  const byTicket = new Map(),
    samples = [],
    wholeDays = [];
  let ambiguousDays = 0,
    incompleteDays = 0;
  for (const line of history.items) {
    if (!byTicket.has(line.ticket_id)) byTicket.set(line.ticket_id, []);
    byTicket.get(line.ticket_id).push(line);
  }
  const units = (receipts) => {
    const result = new Map();
    for (const t of receipts)
      for (const l of byTicket.get(t.id) || [])
        result.set(
          l.product_id,
          (result.get(l.product_id) || 0) + Number(l.qty),
        );
    for (const [id, n] of result) result.set(id, Math.max(0, n));
    return result;
  };
  for (const day of history.days) {
    if (day.date >= today || day.date >= targetDate) continue;
    const tickets = history.tickets.filter((t) => t.sale_day_id === day.id);
    if (
      !tickets.length ||
      tickets.some(
        (t) =>
          !byTicket.get(t.id)?.length ||
          byTicket
            .get(t.id)
            .some(
              (l) =>
                !l.product_id ||
                l.qty == null ||
                !Number.isFinite(Number(l.qty)),
            ),
      )
    ) {
      incompleteDays++;
      continue;
    }
    const games = history.games
      .filter((g) => g.sale_day_id === day.id)
      .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
    const groups = day.event_groups?.length
      ? day.event_groups
      : legacyGroups(day, games);
    if (!groups.length || groups.some((g) => g.games == null)) continue;
    const events = expand(groups),
      homogeneous = new Set(groups.map(identity)).size === 1;
    const receiptsTimes = tickets.map((t) => Date.parse(t.ts));
    if (receiptsTimes.some((t) => !Number.isFinite(t))) {
      incompleteDays++;
      continue;
    }
    wholeDays.push({
      day,
      groups,
      units: units(tickets),
      start: "",
      end: "",
      inferred: false,
      method: "Jornada completa con la misma combinación de actividades",
    });
    const allTimed = events.every((e) => e.start && e.end);
    // Exact windows are safe only if every event in the day is timed and non-overlapping.
    if (allTimed) {
      for (const e of events) {
        const start = epoch(day.date, e.start),
          end = epoch(day.date, e.end);
        if (
          events.some(
            (other) =>
              other !== e &&
              epoch(day.date, other.start) < end &&
              epoch(day.date, other.end) > start,
          )
        ) {
          ambiguousDays++;
          continue;
        }
        samples.push({
          day,
          group: e.group,
          start: e.start,
          end: e.end,
          method: "Ventana de consumo registrada",
          inferred: false,
          units: units(
            tickets.filter(
              (t) => Date.parse(t.ts) >= start && Date.parse(t.ts) < end,
            ),
          ),
        });
      }
    } else if (
      homogeneous &&
      events.every((e) => e.start) &&
      new Set(events.map((e) => e.start)).size === events.length
    ) {
      // Authorized inference: boundaries are next start, with first/last receipts at the edges.
      const ordered = [...events].sort((a, b) =>
        a.start.localeCompare(b.start),
      );
      for (const [i, e] of ordered.entries()) {
        const start =
          i === 0
            ? Math.min(epoch(day.date, e.start), ...receiptsTimes)
            : epoch(day.date, e.start);
        const end = ordered[i + 1]
          ? epoch(day.date, ordered[i + 1].start)
          : Math.max(epoch(day.date, e.start), ...receiptsTimes) + 60000;
        samples.push({
          day,
          group: e.group,
          start: e.start,
          end: stamp(end),
          method:
            "Ventana de consumo inferida; no indica el fin real del partido",
          inferred: true,
          units: units(
            tickets.filter(
              (t) => Date.parse(t.ts) >= start && Date.parse(t.ts) < end,
            ),
          ),
        });
      }
    } else if (homogeneous) {
      const perGame = units(tickets);
      for (const [id, n] of perGame)
        perGame.set(id, n / Math.max(1, totalGames(groups)));
      // One observation per day; duplicating it N times would exaggerate evidence.
      samples.push({
        day,
        group: groups[0],
        start: "",
        end: "",
        method:
          totalGames(groups) === 0
            ? "Día de actividad sin partidos"
            : "Promedio del día por partido (sin horarios)",
        inferred: true,
        units: perGame,
      });
    } else ambiguousDays++;
  }
  return { samples, wholeDays, ambiguousDays, incompleteDays };
}

const period = (start) => {
  const n = minute(start);
  return n == null
    ? "unknown"
    : n < 12 * 60
      ? "morning"
      : n < 18 * 60
        ? "afternoon"
        : "evening";
};
const recentDays = (refs) => {
  const ids = [
    ...new Set(
      [...refs]
        .sort((a, b) => b.day.date.localeCompare(a.day.date))
        .map((r) => r.day.id),
    ),
  ].slice(0, 12);
  return refs.filter((r) => ids.includes(r.day.id));
};
// A day with three windows is one independent day of evidence, not three days.
function dayAverage(refs, productId) {
  const days = new Map();
  for (const ref of refs) {
    if (!days.has(ref.day.id)) days.set(ref.day.id, []);
    days.get(ref.day.id).push(ref.units.get(productId) || 0);
  }
  const values = [...days.values()]
    .map((v) => v.reduce((a, b) => a + b, 0) / v.length)
    .sort((a, b) => a - b);
  const kept = values.length >= 5 ? values.slice(1, -1) : values;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export function predictByEvent({
  history,
  products,
  targetDate,
  groups,
  safety,
  now,
  modelVersion,
}) {
  const today = businessDate(now),
    source = historicalSamples(history, today, targetDate);
  let components = expand(groups).map((e) => {
    let refs = e.unknownCount
      ? []
      : source.samples.filter(
          (s) =>
            compatible(e.group, s.group) &&
            weekend(s.day.date) === weekend(targetDate),
        );
    const start = minute(e.start);
    const sameDay = refs.filter(
      (s) => weekday(s.day.date) === weekday(targetDate),
    );
    if (sameDay.length) refs = sameDay;
    let timeMatched = false;
    if (start != null) {
      const timed = refs.filter(
        (s) =>
          minute(s.start) != null && Math.abs(minute(s.start) - start) <= 90,
      );
      if (timed.length) {
        refs = timed;
        timeMatched = true;
      }
    } else if (e.group.period && e.group.period !== "unknown") {
      const timed = refs.filter(
        (s) => (s.start ? period(s.start) : s.group.period) === e.group.period,
      );
      if (timed.length) {
        refs = timed;
        timeMatched = true;
      }
    }
    refs = recentDays(refs);
    return {
      ...e,
      refs,
      timeMatched,
      basis: !refs.length
        ? "Falta historial de esta categoría con cantidad de partidos"
        : refs.some((s) => s.inferred)
          ? "Estimación con datos inferidos o promedio por partido"
          : "Ventas de franjas registradas",
      label:
        groupLabel({
          ...e.group,
          games: e.group.games === 0 ? 0 : 1,
          slots: [],
        }) +
        (e.group.games === 0 ? " · actividad" : " · partido " + e.number) +
        (e.start ? " · inicio " + e.start : " · hora por confirmar"),
    };
  });
  // Mixed days without end times are useful as whole-day references. Never
  // pretend their receipts can be attributed to each team from timestamps alone.
  let joint = source.wholeDays.filter(
    (r) =>
      totalGames(groups) != null &&
      compositionKey(r.groups) === compositionKey(groups) &&
      weekend(r.day.date) === weekend(targetDate),
  );
  const sameWeekday = joint.filter(
    (r) => weekday(r.day.date) === weekday(targetDate),
  );
  if (sameWeekday.length) joint = sameWeekday;
  const timedJoint = joint.filter((r) =>
    groups.every((g) => {
      const actual = r.groups.filter((a) => identity(a) === identity(g));
      const wantedStarts = (g.slots || [])
        .map((s) => minute(s.start))
        .filter((n) => n != null);
      const actualStarts = actual
        .flatMap((a) => (a.slots || []).map((s) => minute(s.start)))
        .filter((n) => n != null)
        .sort((a, b) => a - b);
      if (wantedStarts.length)
        return (
          wantedStarts.length === actualStarts.length &&
          [...wantedStarts]
            .sort((a, b) => a - b)
            .every((n, i) => Math.abs(n - actualStarts[i]) <= 90)
        );
      if (g.period && g.period !== "unknown")
        return actual.every(
          (a) =>
            a.period === g.period ||
            (a.slots?.length &&
              a.slots.every((s) => period(s.start) === g.period)),
        );
      return true;
    }),
  );
  if (timedJoint.length) joint = timedJoint;
  joint = recentDays(joint);
  const jointMode = joint.length > 0;
  if (jointMode)
    components = [
      {
        label: "Jornada completa · misma combinación de actividades",
        refs: joint,
        timeMatched: timedJoint.length > 0,
        basis:
          "Incluye las ventas del día una sola vez, también cuando coinciden actividades.",
        start: "",
        end: "",
      },
    ];
  const missing = components.filter((c) => !c.refs.length),
    complete = missing.length === 0;
  const stock = inventoryAt(history, now.toISOString());
  const rows = products
    .filter((p) => p.active !== false)
    .flatMap((p) => {
      const contributions = components.map((c) => {
        const values = c.refs.map((r) => r.units.get(p.id) || 0);
        return {
          label: c.label,
          expected: values.length ? dayAverage(c.refs, p.id) : null,
          low: values.length ? Math.min(...values) : 0,
          high: values.length ? Math.max(...values) : 0,
        };
      });
      if (!contributions.some((c) => c.expected > 0)) return [];
      const expected =
        Math.round(
          contributions.reduce((n, c) => n + (c.expected || 0), 0) * 100,
        ) / 100;
      const demand = Math.ceil(Math.round(expected * (1 + safety) * 1e8) / 1e8),
        reference = stock.get(p.id);
      const inventory =
        reference && !reference.uncertain && !reference.inconsistent
          ? reference.value
          : null;
      const rawBuy =
        !complete || inventory == null
          ? null
          : Math.max(0, Math.ceil(demand - inventory));
      const limits = [p.storage_limit, p.perishable ? p.perishable_limit : null]
        .filter((n) => n != null && Number.isFinite(Number(n)))
        .map(Number);
      const limit = limits.length ? Math.min(...limits) : null;
      const missingLimit =
        !!p.perishable &&
        (p.storage_limit == null || p.perishable_limit == null);
      const buy =
        rawBuy == null || missingLimit
          ? null
          : limit == null
            ? rawBuy
            : Math.min(rawBuy, Math.max(0, Math.floor(limit - inventory)));
      return [
        {
          productId: p.id,
          name: p.name,
          expected,
          demand,
          low: Math.floor(contributions.reduce((n, c) => n + c.low, 0)),
          high: Math.ceil(contributions.reduce((n, c) => n + c.high, 0)),
          inventory,
          stockDate: reference?.date || null,
          rawBuy,
          buy,
          limit,
          missingLimit,
          capped: buy != null && buy < rawBuy,
          factor: 1,
          observedDays: new Set(
            components.flatMap((c) =>
              c.refs
                .filter((r) => (r.units.get(p.id) || 0) > 0)
                .map((r) => r.day.id),
            ),
          ).size,
          partial: !complete,
          contributions: contributions.map((c) => ({
            ...c,
            expected:
              c.expected == null ? null : Math.round(c.expected * 100) / 100,
          })),
        },
      ];
    })
    .sort((a, b) => b.demand - a.demand);
  const refs = components.flatMap((c) => c.refs),
    days = [
      ...new Map(
        refs.map((r) => [
          r.day.id,
          {
            id: r.day.id,
            date: r.day.date,
            games:
              history.games.filter((g) => g.sale_day_id === r.day.id).length ||
              totalGames(r.day.event_groups || []),
            closed: r.day.status === "reviewed",
          },
        ]),
      ).values(),
    ];
  const warnings = [
    jointMode
      ? "Se usa la venta de jornadas completas con la misma combinación y cantidades. No se atribuyen tickets a equipos por coincidir en horario."
      : "Se suman referencias independientes de cada actividad. La venta habitual y los asistentes compartidos no se pueden separar con certeza; revisa la suma. El inventario se descuenta una sola vez.",
  ];
  if (missing.length)
    warnings.push(
      "Estimación parcial: faltan referencias para " +
        missing.length +
        " partido(s) o actividades. No se toman como cero. Las cantidades manuales se guardan como borrador.",
    );
  if (refs.some((s) => s.inferred))
    warnings.push(
      "Las ventanas inferidas aproximan periodos de consumo entre inicios y tickets; no son horas reales de finalización. Solo se separan así días de una misma categoría. Sin horarios se usa el promedio por partido de esa categoría.",
    );
  if (components.some((c) => c.refs.length && !c.timeMatched))
    warnings.push(
      "Algunos partidos no tienen una referencia de horario parecido; usan el promedio de su categoría y se indica confianza baja.",
    );
  if (source.ambiguousDays)
    warnings.push(
      "Las jornadas mezcladas sin atribución clara solo se usan como referencia de la jornada completa cuando coincide su composición.",
    );
  if (
    components.some(
      (e, i) =>
        e.start &&
        components.some(
          (other, j) =>
            i !== j &&
            other.start &&
            Math.abs(minute(other.start) - minute(e.start)) < 120,
        ),
    )
  )
    warnings.push(
      "Hay inicios cercanos: puede haber público compartido. Sin finales registrados no se confirma el traslape; revisa las cantidades.",
    );
  return {
    modelVersion,
    targetDate,
    type: "mixto",
    games: totalGames(groups),
    team: "",
    groups,
    safety,
    comparison: jointMode
      ? "Jornadas con las mismas actividades y cantidades; prioridad al mismo día de la semana"
      : "Estimación por actividad, día de la semana e inicio disponible",
    confidence:
      complete &&
      components.every(
        (c) =>
          new Set(c.refs.map((r) => r.day.id)).size >= 3 &&
          c.refs.every(
            (r) =>
              r.day.status === "reviewed" &&
              weekday(r.day.date) === weekday(targetDate),
          ),
      )
        ? "media"
        : "baja",
    jointMode,
    tier: 0,
    days,
    rows,
    evaluations: [],
    excludedIncomplete: source.incompleteDays,
    warnings,
    partial: !complete,
    components: components.map((c) => ({
      label: c.label,
      basis: c.basis,
      timeMatched: c.timeMatched,
      references: c.refs.map((r) => ({
        date: r.day.date,
        start: r.start,
        end: r.end,
        method: r.method,
        closed: r.day.status === "reviewed",
      })),
    })),
  };
}
