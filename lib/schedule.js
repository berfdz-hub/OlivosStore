// Calendar entries describe intentions. Only confirmed sale_days train the model.
import { validateGroups } from "./event-groups.js";
export function scheduledActivity(row) {
  const activity = row.activity || {
    type: row.sport || "sin_especificar",
    teamMode: /club puebla/i.test(row.notes || "") ? "club_puebla" : "unknown",
    team: /club puebla/i.test(row.notes || "") ? "Club Puebla" : "",
    games: 1,
    slots: row.start_time
      ? [{ start: row.start_time.slice(0, 5), end: "" }]
      : [],
  };
  return {
    ...structuredClone(activity),
    scheduleId: row.id,
    scheduleVersion: row.version || 1,
  };
}
export function activitiesForDate(rows, date) {
  return rows
    .filter((r) => r.date === date && r.status !== "cancelled")
    .map(scheduledActivity);
}
export function scheduleFingerprint(rows, date) {
  return JSON.stringify(
    activitiesForDate(rows, date)
      .map((g) => ({ id: g.scheduleId, version: g.scheduleVersion }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
export function actualActivities(groups) {
  return groups.map(({ scheduleId, scheduleVersion, ...g }) => g);
}
export function dayClassification(groups) {
  validateGroups(groups);
  const types = [...new Set(groups.map((g) => g.type))];
  const tags = [
    ...new Set(
      groups.flatMap((g) => [
        g.type === "futbol" || g.type === "beisbol" ? g.type : "otro",
        ...(g.teamMode === "club_puebla" ? ["club_puebla"] : []),
      ]),
    ),
  ];
  return {
    sport:
      types.length === 1 && ["futbol", "beisbol"].includes(types[0])
        ? types[0]
        : "otro",
    day_type: groups.every((g) => g.type === "entrenamiento")
      ? "entrenamiento_normal"
      : groups.some((g) => g.teamMode === "club_puebla") || types.length > 1
        ? "evento_especial"
        : "dia_partido",
    event_tags: tags,
  };
}
