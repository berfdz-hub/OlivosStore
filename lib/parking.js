import { businessDate } from "./csv.js";

const amount = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);
const minutes = (time) => {
  const [h, m] = String(time || "")
    .split(":")
    .map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const ticketMinutes = (ts) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  return (
    Number(parts.find((p) => p.type === "hour").value) * 60 +
    Number(parts.find((p) => p.type === "minute").value)
  );
};

export function parkingRows(days, games, tickets) {
  const dayById = new Map(days.map((d) => [d.id, d]));
  const rows = games.map((g) => {
    const start = minutes(g.start_time),
      cobra = g.charges_parking !== false;
    const autosLote = amount(g.cars_parked),
      autosCobrados = amount(g.cars_charged),
      tarifa = cobra ? amount(g.parking_rate) : 0;
    const ingreso = !cobra
      ? 0
      : autosCobrados === null || tarifa === null
        ? null
        : autosCobrados * tarifa;
    return {
      id: g.id,
      dayId: g.sale_day_id,
      fecha: dayById.get(g.sale_day_id)?.date || "",
      hora: g.start_time || "",
      start,
      desde: start === null ? null : start - 60,
      hasta: start === null ? null : start + 150,
      autosLote,
      autosCobrados,
      tarifa,
      cobra,
      ingreso,
      venta: 0,
      ambiguous: false,
      nota: g.notes || "",
    };
  });
  for (const row of rows) {
    const next = rows
      .filter((r) => r.dayId === row.dayId && r.start > row.start)
      .sort((a, b) => a.start - b.start)[0];
    if (next) row.hasta = Math.min(row.hasta, next.start - 60);
    if (
      row.start === null ||
      rows.some(
        (r) => r !== row && r.dayId === row.dayId && r.start === row.start,
      )
    )
      row.ambiguous = true;
  }
  for (const t of tickets) {
    if (!Number.isFinite(Date.parse(t.ts))) continue;
    const min = ticketMinutes(t.ts),
      date = businessDate(new Date(t.ts));
    const matches = rows.filter(
      (r) =>
        r.dayId === t.sale_day_id &&
        r.fecha === date &&
        r.start !== null &&
        min >= r.desde &&
        min < r.hasta,
    );
    if (matches.length !== 1) continue;
    const sale = amount(t.amount);
    if (sale === null) matches[0].ambiguous = true;
    else matches[0].venta += sale;
  }
  return rows
    .map((r) => {
      if (r.ambiguous) r.venta = null;
      const total =
        r.venta === null || r.ingreso === null ? null : r.venta + r.ingreso;
      return {
        ...r,
        total,
        ventaPorAuto:
          r.autosLote > 0 && r.venta !== null ? r.venta / r.autosLote : null,
        parkingPorAuto:
          r.autosLote > 0 && r.ingreso !== null
            ? r.ingreso / r.autosLote
            : null,
        totalPorAuto:
          r.autosLote > 0 && total !== null ? total / r.autosLote : null,
      };
    })
    .sort(
      (a, b) => b.fecha.localeCompare(a.fecha) || a.hora.localeCompare(b.hora),
    );
}
