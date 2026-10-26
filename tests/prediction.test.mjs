import test from "node:test";
import assert from "node:assert/strict";
import {
  predictPurchase,
  evaluatePlans,
  MODEL_VERSION,
} from "../lib/prediction.js";
const now = new Date("2026-10-20T18:00:00Z");
function dataset() {
  const days = [
    "2026-09-02",
    "2026-09-09",
    "2026-09-16",
    "2026-09-05",
    "2026-09-12",
    "2026-09-19",
  ].map((date, i) => ({
    id: "d" + i,
    date,
    sport: "futbol",
    day_type: "dia_partido",
    event_tags: [],
    status: "reviewed",
  }));
  return {
    days,
    tickets: days.map((d) => ({
      id: "t" + d.id,
      sale_day_id: d.id,
      ts: d.date + "T18:00:00Z",
    })),
    items: days.map((d, i) => ({
      ticket_id: "t" + d.id,
      product_id: "p",
      qty: i < 3 ? 10 : 100,
    })),
    games: days.flatMap((d) =>
      [0, 1, 2].map((i) => ({ id: d.id + i, sale_day_id: d.id })),
    ),
    counts: [
      {
        product_id: "p",
        sale_day_id: "d5",
        physical_count: 5,
        counted_at: "2026-09-19T23:00:00Z",
        count_source: "manual",
      },
    ],
    movements: [],
  };
}
const product = { id: "p", name: "Agua", active: true };
const predict = (history, extra = {}) =>
  predictPurchase({
    history,
    products: [product],
    targetDate: "2026-10-21",
    type: "futbol",
    games: 3,
    now,
    ...extra,
  });
test("three Wednesday games use Wednesday sales; three Saturday games use Saturday sales", () => {
  const history = dataset();
  const wed = predict(history),
    sat = predict(history, { targetDate: "2026-10-24" });
  assert.equal(wed.rows[0].expected, 10);
  assert.equal(sat.rows[0].expected, 100);
  assert.equal(wed.days.length, 3);
  assert.equal(wed.tier, 0);
  assert.equal(wed.rows[0].buy, 6);
  assert.equal(sat.rows[0].demand, 110);
  assert.equal(sat.rows[0].buy, 105);
});
test("no weekday/weekend cross-over or linear scaling when no comparable games exist", () => {
  const history = dataset();
  history.days = history.days.filter(
    (d) =>
      d.date.endsWith("05") || d.date.endsWith("12") || d.date.endsWith("19"),
  );
  assert.equal(predict(history).rows.length, 0);
  assert.equal(predict(dataset(), { games: 8 }).rows.length, 0);
});
test("fallback broadens to similar weekdays, labels the basis and keeps low confidence", () => {
  const history = dataset();
  history.days[1].date = "2026-09-08";
  history.days[2].date = "2026-09-15";
  const result = predict(history);
  assert.equal(result.tier, 2);
  assert.equal(result.confidence, "baja");
  assert(result.days.every((d) => !d.date.endsWith("19")));
  assert.equal(result.rows[0].expected, 10);
});
test("Club Puebla keeps its own event group", () => {
  const history = dataset();
  assert.equal(predict(history, { type: "club_puebla" }).rows.length, 0);
  history.days[0].event_tags = ["club_puebla"];
  const result = predict(history, { type: "club_puebla" });
  assert.equal(result.days.length, 1);
  assert.equal(result.confidence, "baja");
});
test("food limits include existing stock and missing limits block purchase quantity", () => {
  const food = {
    ...product,
    perishable: true,
    storage_limit: 12,
    perishable_limit: 10,
  };
  const result = predict(dataset(), {
    targetDate: "2026-10-24",
    products: [food],
  });
  assert.equal(result.rows[0].buy, 5);
  assert.equal(result.rows[0].capped, true);
  assert.equal(
    predict(dataset(), { products: [{ ...food, storage_limit: null }] }).rows[0]
      .buy,
    null,
  );
  assert.equal(
    predict(dataset(), { products: [{ ...food, storage_limit: 0 }] }).rows[0]
      .buy,
    0,
  );
});
test("unknown and negative inventory never become zero stock", () => {
  const history = dataset();
  history.counts = [];
  assert.equal(predict(history).rows[0].buy, null);
  history.counts = [
    {
      product_id: "p",
      sale_day_id: "d5",
      physical_count: 5,
      counted_at: "2026-09-19T17:00:00Z",
      count_source: "manual",
    },
  ];
  assert.equal(predict(history).rows[0].inventory, null);
});
test("incomplete receipt details and current-day captures are excluded", () => {
  const history = dataset();
  history.items = history.items.filter((i) => i.ticket_id !== "td0");
  const result = predict(history);
  assert.equal(result.days.length, 2);
  assert.equal(result.excludedIncomplete, 1);
  history.days[1].date = "2026-10-20";
  assert.equal(predict(history).days.length, 1);
});
test("evaluation uses latest pre-event snapshot, requires a closed day and counts missed products", () => {
  const history = dataset();
  const base = {
    event_date: "2026-09-02",
    event_type: "futbol",
    games: 3,
    model_version: MODEL_VERSION,
  };
  const plans = [
    {
      ...base,
      id: "a",
      created_at: "2026-09-01T12:00:00Z",
      rows: [{ productId: "p", expected: 20 }],
    },
    {
      ...base,
      id: "b",
      created_at: "2026-09-01T13:00:00Z",
      rows: [{ productId: "p", expected: 10 }],
    },
  ];
  const evaluated = evaluatePlans(plans, history, "2026-10-20");
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].plan.id, "b");
  assert.equal(evaluated[0].wape, 0);
  plans.push({
    ...base,
    id: "too-late",
    created_at: "2026-09-02T23:00:00Z",
    rows: [{ productId: "p", expected: 999 }],
  });
  assert.equal(
    evaluatePlans(plans, history, "2026-10-20")[0].plan.id,
    "b",
    "a post-event estimate cannot replace the genuine forecast",
  );
  history.items.push({ ticket_id: "td0", product_id: "q", qty: 10 });
  assert.equal(evaluatePlans(plans, history, "2026-10-20")[0].wape, 0.5);
  history.days[0].status = "submitted";
  assert.equal(evaluatePlans(plans, history, "2026-10-20")[0].complete, false);
});
test("calibration waits for three comparable outcomes and caps the adjustment", () => {
  const history = dataset();
  const plans = history.days.slice(0, 3).map((d, i) => ({
    id: String(i),
    event_date: d.date,
    event_type: "futbol",
    games: 3,
    model_version: MODEL_VERSION,
    created_at: d.date + "T07:00:00Z",
    rows: [{ productId: "p", expected: 100 }],
  }));
  assert.equal(
    predict(history, { plans: plans.slice(0, 2) }).rows[0].factor,
    1,
  );
  assert.equal(predict(history, { plans }).rows[0].factor, 0.75);
});
test("future or past leakage and invalid game counts are rejected", () => {
  assert.throws(
    () => predict(dataset(), { targetDate: "2026-09-19" }),
    /futura/,
  );
  assert.throws(() => predict(dataset(), { games: 1.5 }), /partidos/);
  assert.throws(() => predict(dataset(), { games: -1 }), /partidos/);
  assert.throws(() => predict(dataset(), { games: 51 }), /partidos/);
});

test("unknown games broaden references, while no games requires a confirmed zero", () => {
  const history = dataset();
  history.games = [];
  const unknown = predict(history, { games: null });
  assert.equal(unknown.rows[0].expected, 10);
  assert.equal(unknown.confidence, "baja");
  assert.equal(unknown.days[0].games, null);
  assert(unknown.warnings.some((w) => w.includes("desconocido")));
  assert.equal(predict(history, { games: 0 }).rows.length, 0);
  assert.equal(predict(history, { games: 3 }).rows.length, 0);
  history.days.forEach((d) => (d.day_type = "entrenamiento_normal"));
  assert.equal(
    predict(history, { games: 0, type: "entrenamiento" }).rows[0].expected,
    10,
  );
});

test("unknown event type is explicit and does not cross weekdays and weekends", () => {
  const history = dataset();
  history.days[0].sport = "beisbol";
  const result = predict(history, { type: "", games: null });
  assert.equal(result.type, "sin_especificar");
  assert.equal(result.days.length, 3);
  assert.equal(result.rows[0].expected, 10);
  assert.equal(result.confidence, "baja");
  assert.equal(result.warnings.length, 2);
});

test("named teams match event names without accents, with no silent replacement", () => {
  const history = dataset();
  history.days[0].event_name = "Tígres vs Leones";
  const result = predict(history, { team: " TIGRES " });
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].id, "d0");
  const missing = predict(history, { team: "Águilas" });
  assert.equal(missing.rows.length, 0);
  assert(missing.warnings.some((w) => w.includes("ese equipo")));
  assert.throws(() => predict(history, { team: "!!!" }), /equipo válido/);
  history.days[1].event_tags = ["club_puebla"];
  const club = predict(history, { team: "Club Puebla" });
  assert.equal(club.type, "club_puebla");
  assert.deepEqual(
    club.days.map((d) => d.id),
    ["d1"],
  );
});

test("saved unknown context evaluates without turning missing game records into zero", () => {
  const history = dataset();
  history.games = [];
  const plan = {
    id: "p1",
    event_date: "2026-09-02",
    created_at: "2026-09-01T12:00:00Z",
    event_type: "sin_especificar",
    games: null,
    summary: { team: "" },
    rows: [{ productId: "p", expected: 10 }],
  };
  assert.equal(evaluatePlans([plan], history, "2026-10-20")[0].complete, true);
  assert.equal(
    evaluatePlans([{ ...plan, games: 0 }], history, "2026-10-20")[0].complete,
    false,
  );
  assert.equal(
    evaluatePlans(
      [{ ...plan, summary: { team: "Tigres" } }],
      history,
      "2026-10-20",
    )[0].complete,
    false,
  );
});
