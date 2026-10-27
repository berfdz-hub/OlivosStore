import test from "node:test";
import assert from "node:assert/strict";
import { predictPurchase, evaluatePlans } from "../lib/prediction.js";
import { validateGroups } from "../lib/event-groups.js";
const now = new Date("2026-10-30T18:00Z");
const group = (type, teamMode, games, slots = []) => ({
  type,
  teamMode,
  team: teamMode === "club_puebla" ? "Club Puebla" : "",
  games,
  slots,
});
function fixture() {
  const club = group("futbol", "club_puebla", 3, [
    { start: "09:00", end: "11:00" },
    { start: "11:30", end: "13:30" },
    { start: "15:45", end: "17:45" },
  ]);
  const days = [
    {
      id: "club",
      date: "2026-10-03",
      sport: "futbol",
      event_name: "Juegos Club Puebla",
      event_groups: [club],
    },
    {
      id: "academy",
      date: "2026-10-10",
      sport: "futbol",
      event_groups: [group("futbol", "academy", 2)],
    },
    {
      id: "base",
      date: "2026-10-17",
      sport: "beisbol",
      event_groups: [group("beisbol", "none", 3)],
    },
    {
      id: "wed",
      date: "2026-10-07",
      sport: "futbol",
      event_groups: [
        group("futbol", "club_puebla", 1, [{ start: "11:30", end: "13:30" }]),
      ],
    },
  ].map((d) => ({ ...d, status: "reviewed" }));
  const tickets = [
    ["c1", "club", "2026-10-03T15:15Z", 10],
    ["c2", "club", "2026-10-03T18:00Z", 30],
    ["c3", "club", "2026-10-03T22:00Z", 50],
    ["a", "academy", "2026-10-10T18:00Z", 12],
    ["b", "base", "2026-10-17T18:00Z", 15],
    ["w", "wed", "2026-10-07T18:00Z", 90],
  ];
  return {
    days,
    games: [],
    tickets: tickets.map(([id, sale_day_id, ts]) => ({ id, sale_day_id, ts })),
    items: tickets.map(([ticket_id, , , qty]) => ({
      ticket_id,
      product_id: "p",
      qty,
    })),
    counts: [
      {
        sale_day_id: "base",
        product_id: "p",
        physical_count: 10,
        counted_at: "2026-10-29T18:00Z",
        count_source: "manual",
      },
    ],
    movements: [],
  };
}
const wanted = [
  group("futbol", "club_puebla", 1, [{ start: "12:00", end: "14:00" }]),
  group("futbol", "academy", 2),
  group("beisbol", "none", 3),
];
const run = (history = fixture(), groups = wanted, extra = {}) =>
  predictPurchase({
    history,
    groups,
    products: [{ id: "p", name: "Agua", active: true }],
    targetDate: "2026-10-31",
    safety: 0.1,
    now,
    ...extra,
  });

test("one Puebla + two academy + three baseball use independent histories and deduct inventory once", () => {
  const result = run();
  assert.equal(result.components.length, 6);
  assert.equal(result.rows[0].expected, 57); // 30 + 2*(12/2) + 3*(15/3)
  assert.equal(result.rows[0].demand, 63);
  assert.equal(result.rows[0].buy, 53);
  assert.deepEqual(
    result.rows[0].contributions.map((c) => c.expected),
    [30, 6, 6, 5, 5, 5],
  );
  assert.equal(result.partial, false);
  assert.equal(
    run(fixture(), [wanted[0]], { targetDate: "2026-11-04" }).rows[0].expected,
    90,
  );
  assert(result.components[0].references.every((r) => r.date === "2026-10-03"));
});
test("legacy Puebla windows are inferred transparently without inventing end times in stored data", () => {
  const h = fixture();
  delete h.days[0].event_groups;
  h.games = ["09:00", "11:30", "15:45"].map((start_time) => ({
    sale_day_id: "club",
    start_time,
  }));
  const result = run(h, [wanted[0]]);
  assert.equal(result.rows[0].expected, 30);
  assert.match(result.components[0].references[0].method, /inferida/);
  assert.equal(h.games[0].end_time, undefined);
});
test("unidentified football is not silently treated as academy and missing baseball counts block a total purchase", () => {
  const h = fixture();
  delete h.days[1].event_groups;
  delete h.days[2].event_groups;
  h.games.push(
    { sale_day_id: "academy", start_time: "09:00" },
    { sale_day_id: "academy", start_time: "11:00" },
  );
  const result = run(h);
  assert.equal(result.partial, true);
  assert.equal(result.rows[0].expected, 30);
  assert.equal(result.rows[0].buy, null);
  assert(result.components.slice(1).every((c) => c.references.length === 0));
  assert.match(result.warnings.join(" "), /No se toman como cero/);
});
test("mixed historical days with missing or overlapping windows cannot be divided among categories", () => {
  const h = fixture();
  h.days = [
    {
      ...h.days[0],
      event_groups: [
        group("futbol", "club_puebla", 1),
        group("futbol", "academy", 1),
      ],
    },
  ];
  assert.equal(run(h).rows.length, 0);
  h.days[0].event_groups[0].slots = [{ start: "09:00", end: "13:00" }];
  h.days[0].event_groups[1].slots = [{ start: "11:00", end: "14:00" }];
  assert.equal(run(h).rows.length, 0);
  h.days[0].event_groups[0].slots = [{ start: "09:00", end: "11:00" }];
  h.days[0].event_groups[1].slots = [{ start: "11:30", end: "13:30" }];
  const result = run(h, [group("futbol", "academy", 1)]);
  assert.equal(result.rows[0].expected, 30);
});
test("unknown counts and invalid hours remain explicit; partial plans cannot calibrate", () => {
  const g = group("futbol", "club_puebla", null);
  assert.equal(run(fixture(), [g]).partial, true);
  assert.throws(
    () =>
      validateGroups([
        group("futbol", "club_puebla", 1, [{ start: "12:00", end: "11:00" }]),
      ]),
    /posterior/,
  );
  assert.throws(() => validateGroups([group("futbol", "academy", 51)]), /50/);
  const h = fixture();
  const p = {
    event_date: "2026-10-03",
    event_type: "mixto",
    games: 3,
    created_at: "2026-10-02T18:00Z",
    summary: { partial: true, groups: h.days[0].event_groups },
    rows: [],
  };
  const evaluated = evaluatePlans([p], h, "2026-10-30");
  assert.equal(evaluated[0].complete, false);
  assert.equal(evaluated[0].wape, null);
});

test("same mixed agenda without end times uses the entire day once, including overlapping starts", () => {
  const h = fixture();
  h.days = [
    {
      ...h.days[0],
      event_groups: wanted.map((g) => ({
        ...g,
        slots: Array.from({ length: g.games }, () => ({
          start: "12:00",
          end: "",
        })),
      })),
    },
  ];
  const target = h.days[0].event_groups;
  const result = run(h, target);
  assert.equal(result.jointMode, true);
  assert.equal(result.partial, false);
  assert.equal(result.rows[0].expected, 90);
  assert.equal(result.rows[0].demand, 99);
  assert.equal(result.components.length, 1);
  assert.equal(result.days.length, 1);
  assert.equal(
    run(h, [...target.slice(0, 2), { ...target[2], games: 4, slots: [] }])
      .partial,
    true,
  );
});

test("a day with several windows does not count as several independent days", () => {
  const h = fixture();
  h.days = h.days.filter((d) => d.id === "club");
  h.days.push({
    ...h.days[0],
    id: "other",
    date: "2026-10-10",
    event_groups: [group("futbol", "club_puebla", 2)],
  });
  h.tickets.push({
    id: "other",
    sale_day_id: "other",
    ts: "2026-10-10T18:00Z",
  });
  h.items.push({ ticket_id: "other", product_id: "p", qty: 20 });
  const result = run(h, [group("futbol", "club_puebla", 1)]);
  assert.equal(result.rows[0].expected, 20); // mean(day A 30, day B 10), not mean(10,30,50,10)
  assert.equal(result.confidence, "baja");
});

test("morning versus evening uses starts without asking for ends", () => {
  const h = fixture();
  delete h.days[0].event_groups;
  h.games = ["09:00", "11:30", "15:45"].map((start_time) => ({
    sale_day_id: "club",
    start_time,
  }));
  const result = run(h, [
    { ...group("futbol", "club_puebla", 1), period: "afternoon" },
  ]);
  assert.equal(result.rows[0].expected, 50);
  assert.equal(result.components[0].timeMatched, true);
});

test("zero-game training days can support a future training activity without invented match counts", () => {
  const h = fixture();
  h.days = [
    { ...h.days[1], day_type: "entrenamiento_normal", event_groups: null },
  ];
  const result = run(h, [group("entrenamiento", "none", 0)]);
  assert.equal(result.partial, false);
  assert.equal(result.games, 0);
  assert.equal(result.rows[0].expected, 12);
});

test("manual and draft plans never become calibration evidence", () => {
  const h = fixture();
  for (const flags of [{ manual: true }, { draft: true }]) {
    const plan = {
      event_date: "2026-10-03",
      event_type: "mixto",
      games: 3,
      created_at: "2026-10-02T18:00Z",
      summary: { groups: h.days[0].event_groups, ...flags },
      rows: [{ productId: "p", expected: 90 }],
    };
    const result = evaluatePlans([plan], h, "2026-10-30")[0];
    assert.equal(result.complete, false);
    assert.equal(result.wape, null);
    assert.match(result.status, /manual/);
  }
});
