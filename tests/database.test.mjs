import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import assert from "node:assert/strict";
import { businessDate, parseBusinessDate } from "../lib/csv.js";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create schema auth;
create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
for (const name of [
  "schema.sql",
  "permiso_operador_costos.sql",
  "venta_fuerte_por_dia.sql",
  "categoria_dia.sql",
  "nombre_evento.sql",
  "calendario_partidos.sql",
  "ventana_dinero_operador.sql",
]) {
  let sql = fs
    .readFileSync(new URL("../supabase/" + name, import.meta.url), "utf8")
    .replace(/create extension if not exists "pgcrypto";/, "");
  await db.exec(sql);
}
await db.exec(
  "grant all on all tables in schema public to anon,authenticated;",
);
const admin = "00000000-0000-0000-0000-000000000001",
  operator = "00000000-0000-0000-0000-000000000002",
  inactive = "00000000-0000-0000-0000-000000000003";
for (const id of [admin, operator, inactive])
  await db.query("insert into auth.users(id) values($1)", [id]);
await db.query("update public.profiles set role='admin' where id=$1", [admin]);
await db.query("update public.profiles set active=false where id=$1", [
  inactive,
]);
for (const name of [
  "2026100501_security.sql",
  "2026100502_integrity.sql",
  "2026102001_planning_corrections.sql",
  "2026102101_guided_planning.sql",
  "2026102601_event_groups.sql",
]) {
  try {
    await db.exec(
      fs.readFileSync(
        new URL("../supabase/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  } catch (e) {
    console.error("MIGRATION", name, e.message, "position", e.position);
    await db.close();
    process.exit(1);
  }
}
async function as(id, fn) {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.sub','',false)");
  }
}
const date = businessDate(),
  ts = parseBusinessDate(date + "T00:01").toISOString();
const day = {
  date,
  sport: "futbol",
  day_type: "evento_especial",
  event_tags: ["futbol"],
};
const receipt = (number = "R1") => ({
  ticket_number: number,
  ts,
  amount: 80,
  receipt_type: "sale",
  source_terminal: "POS1",
  items: [
    {
      raw: "Agua 600 ml",
      qty: 2,
      unit_price: 50,
      unit_cost: 20,
      line_net_amount: 80,
      line_cost_amount: 40,
    },
  ],
});
const save = (tickets, extra = {}) =>
  db.query("select public.save_sale_day($1,$2,$3,$4,$5) as result", [
    day,
    tickets,
    extra.games || [],
    extra.counts || [],
    extra.replace || false,
  ]);
const first = await as(admin, () => save([receipt()]));
assert.equal(first.rows[0].result.inserted, 1);
const again = await as(admin, () => save([receipt()]));
assert.equal(again.rows[0].result.skipped, 1);
assert.equal(
  (await db.query("select count(*)::int n from tickets")).rows[0].n,
  1,
);
const bad = receipt("FAIL");
bad.items.push({
  raw: "Bad",
  qty: 0,
  unit_price: 20,
  unit_cost: 10,
  line_net_amount: 0,
});
await assert.rejects(
  () => as(admin, () => save([receipt("BEFORE-FAIL"), bad])),
  /Cantidad/,
);
assert.equal(
  (await db.query("select count(*)::int n from tickets")).rows[0].n,
  1,
  "whole day rolls back",
);
const ret = receipt("REFUND");
ret.amount = -40;
ret.receipt_type = "refund";
ret.items = [
  {
    raw: "Agua 600 ml",
    qty: -1,
    unit_price: 50,
    unit_cost: 20,
    line_net_amount: -40,
    line_cost_amount: -20,
  },
];
await as(operator, () => save([ret]));
assert.equal(
  Number((await db.query("select sum(amount) n from tickets")).rows[0].n),
  40,
);
await assert.rejects(
  () => as(inactive, () => save([receipt("INACTIVE")])),
  /Cuenta no autorizada/,
);
await db.exec("set role anon");
for (const table of [
  "tickets",
  "ticket_items",
  "sale_days",
  "games",
  "inventory_counts",
  "products_view",
  "tickets_view",
  "ticket_items_view",
])
  await assert.rejects(
    () => db.query("select * from " + table),
    /permission denied/,
  );
await assert.rejects(() => save([]), /permission denied/);
await db.exec("reset role");
await db.exec("update app_settings set operators_see_costs=false");
const hidden = await as(operator, () =>
  db.query("select unit_cost from ticket_items_view"),
);
assert(hidden.rows.length > 0);
assert(hidden.rows.every((r) => r.unit_cost === null));
assert.equal(
  (await as(inactive, () => db.query("select * from ticket_items_view"))).rows
    .length,
  0,
);
assert.equal(
  (await as(operator, () => db.query("select * from ticket_items"))).rows
    .length,
  0,
);
const before = (
  await as(admin, () =>
    db.query("select unit_cost from ticket_items_view order by id"),
  )
).rows;
await db.exec("update products set cost_price=999,sell_price=1999");
const after = (
  await as(admin, () =>
    db.query("select unit_cost from ticket_items_view order by id"),
  )
).rows;
assert.deepEqual(after, before);
const changed = receipt();
changed.amount = 60;
changed.items[0].line_net_amount = 60;
await assert.rejects(() => as(admin, () => save([changed])), /otro contenido/);
await as(admin, () => save([changed], { replace: true }));
const pid = (await db.query("select id from products limit 1")).rows[0].id;
await assert.rejects(
  () =>
    as(operator, () =>
      db.query(
        "insert into tickets(sale_day_id,ts,amount) select id,now(),100 from sale_days limit 1",
      ),
    ),
  /permission denied/,
);
const dayId = first.rows[0].result.day_id;
await as(admin, () => db.query("select set_day_reviewed($1,true)", [dayId]));
await assert.rejects(
  () => as(operator, () => save([receipt("CLOSED")])),
  /cerrado/,
);
await as(admin, () => db.query("select set_day_reviewed($1,false)", [dayId]));
const clientRef = "00000000-0000-0000-0000-000000000099";
const move = () =>
  db.query(
    "select record_inventory_movement($1,$2,10,'purchase','Recepción de compra',$3)",
    [pid, ts, clientRef],
  );
await as(operator, move);
await as(operator, move);
assert.equal(
  (await db.query("select count(*)::int n from inventory_movements")).rows[0].n,
  1,
);
const newUser = "00000000-0000-0000-0000-000000000004";
await db.query("insert into auth.users(id) values($1)", [newUser]);
assert.equal(
  (await db.query("select active from profiles where id=$1", [newUser])).rows[0]
    .active,
  false,
);
assert((await db.query("select count(*)::int n from audit_log")).rows[0].n > 0);
const wrongCost = receipt("BAD-COST");
wrongCost.items[0].line_cost_amount = -40;
await assert.rejects(
  () => as(admin, () => save([wrongCost])),
  /Signo del importe/,
);
const countAt = parseBusinessDate(date + "T00:00").toISOString();
const count = {
  raw: "Agua 600 ml",
  unit_price: 50,
  physical_count: 12.5,
  counted_at: countAt,
  count_source: "manual",
};
await as(operator, () => save([], { counts: [count] }));
await as(operator, () => save([], { counts: [count] }));
await assert.rejects(
  () =>
    as(operator, () =>
      save([], { counts: [{ ...count, physical_count: 13 }] }),
    ),
  /Administración debe corregir el conteo/,
);
assert.equal(
  (await db.query("select count(*)::int n from inventory_counts")).rows[0].n,
  1,
);
assert.equal(
  Number(
    (await db.query("select physical_count from inventory_counts")).rows[0]
      .physical_count,
  ),
  12.5,
);
await assert.rejects(
  () =>
    as(admin, () =>
      save([receipt("BAD-COUNT-ROLLBACK")], {
        counts: [{ ...count, physical_count: -1 }],
      }),
    ),
  /Conteo/,
);
assert.equal(
  (
    await db.query(
      "select count(*)::int n from tickets where ticket_number='BAD-COUNT-ROLLBACK'",
    )
  ).rows[0].n,
  0,
);
await db.query(
  "insert into tickets(sale_day_id,ticket_number,ts,amount) values($1,'LEGACY',$2,80)",
  [dayId, ts],
);
await assert.rejects(
  () => as(operator, () => save([receipt("LEGACY")])),
  /Administración debe conciliarlo/,
);
assert.equal(
  (await as(admin, () => save([receipt("LEGACY")]))).rows[0].result.repaired,
  1,
);
await assert.rejects(
  () =>
    as(admin, () =>
      db.query("update profiles set active=false where id=$1", [admin]),
    ),
  /al menos un administrador/,
);
const metadata = async () =>
  (
    await db.query(
      "select day_metadata(d) as value from sale_days d where id=$1",
      [dayId],
    )
  ).rows[0].value;
const request = (
  after,
  before,
  ref,
  reason = "Corregí la clasificación equivocada",
) =>
  db.query("select request_day_correction($1,$2,$3,$4,$5) as result", [
    dayId,
    after,
    before,
    reason,
    ref,
  ]);
const beforeCorrection = await metadata();
const proposed = {
  ...beforeCorrection,
  event_name: "Club Puebla",
  event_tags: ["club_puebla"],
};
const correctionRef = "00000000-0000-0000-0000-000000000201";
const pending = (
  await as(operator, () => request(proposed, beforeCorrection, correctionRef))
).rows[0].result;
assert.equal(pending.applied, false, "other user's day requires approval");
assert.deepEqual(
  await metadata(),
  beforeCorrection,
  "request does not apply data prematurely",
);
assert.equal(
  (await as(operator, () => request(proposed, beforeCorrection, correctionRef)))
    .rows[0].result.id,
  pending.id,
  "retry keeps one request",
);
await assert.rejects(
  () =>
    as(operator, () =>
      db.query(
        "select review_day_correction($1,true,'Revisado contra el evento')",
        [pending.id],
      ),
    ),
  /Solo administración/,
);
await assert.rejects(
  () =>
    as(operator, () =>
      db.query(
        "update sale_days set event_name='Sin autorización' where id=$1",
        [dayId],
      ),
    ),
  /permission denied/,
);
await as(admin, () => db.query("select set_day_reviewed($1,true)", [dayId]));
await assert.rejects(
  () =>
    as(admin, () =>
      db.query(
        "select review_day_correction($1,true,'Revisado contra el evento')",
        [pending.id],
      ),
    ),
  /Reabre/,
);
await as(admin, () => db.query("select set_day_reviewed($1,false)", [dayId]));
await as(admin, () =>
  db.query(
    "select review_day_correction($1,true,'Revisado contra el evento')",
    [pending.id],
  ),
);
assert.deepEqual(await metadata(), proposed);
await db.query("update sale_days set created_by=$1 where id=$2", [
  operator,
  dayId,
]);
const ownAfter = { ...proposed, day_type: "entrenamiento_normal" };
const direct = (
  await as(operator, () =>
    request(ownAfter, proposed, "00000000-0000-0000-0000-000000000202"),
  )
).rows[0].result;
assert.equal(direct.applied, true, "own open day can be corrected immediately");
assert.deepEqual(
  (await metadata()).event_tags,
  ["club_puebla"],
  "tags remain independent of category",
);
await assert.rejects(
  () =>
    as(operator, () =>
      request(
        proposed,
        beforeCorrection,
        "00000000-0000-0000-0000-000000000203",
      ),
    ),
  /cambió/,
);
await assert.rejects(
  () =>
    as(admin, () =>
      request(proposed, ownAfter, "00000000-0000-0000-0000-000000000204", ""),
    ),
  /motivo/,
);
await assert.rejects(
  () => db.query("delete from day_corrections where id=$1", [pending.id]),
  /permanente/,
);
await assert.rejects(
  () => db.exec("update audit_log set actor=null"),
  /permanente/,
);
await assert.rejects(
  () => as(admin, () => db.exec("delete from correction_decisions")),
  /permission denied/,
);
const plan = {
  event_date: date,
  event_type: "club_puebla",
  games: 3,
  model_version: "eventos-2026-10-v1",
  summary: { confidence: "baja" },
  rows: [{ productId: pid, expected: 10, demand: 11, buy: 6, chosen: 6 }],
};
const planRef = "00000000-0000-0000-0000-000000000210";
const savePlan = () =>
  db.query("select save_purchase_plan($1,$2) as id", [plan, planRef]);
const savedPlan = (await as(operator, savePlan)).rows[0].id;
assert.equal((await as(operator, savePlan)).rows[0].id, savedPlan);
const guidedPlan = {
  ...plan,
  event_type: "sin_especificar",
  games: null,
  model_version: "eventos-2026-10-v2",
  summary: {
    confidence: "baja",
    team: "",
    answers: { gamesMode: "unknown", teamMode: "none" },
  },
};
const guidedRef = "00000000-0000-0000-0000-000000000211";
const saveGuided = (value = guidedPlan) =>
  as(operator, () =>
    db.query("select save_purchase_plan($1,$2) as id", [value, guidedRef]),
  );
const guidedId = (await saveGuided()).rows[0].id;
assert.equal((await saveGuided()).rows[0].id, guidedId);
const storedGuided = (
  await db.query(
    "select games,event_type,summary from purchase_plans where id=$1",
    [guidedId],
  )
).rows[0];
assert.equal(storedGuided.games, null);
assert.equal(storedGuided.event_type, "sin_especificar");
assert.deepEqual(storedGuided.summary, guidedPlan.summary);
await assert.rejects(
  () => saveGuided({ ...guidedPlan, games: 0 }),
  /otra propuesta/,
);
await assert.rejects(
  () => saveGuided({ ...guidedPlan, model_version: "eventos-2026-10-v1" }),
  /otra propuesta/,
);
await assert.rejects(
  () => saveGuided({ ...guidedPlan, games: 1.5 }),
  /Partidos inválidos/,
);
const zeroId = (
  await as(operator, () =>
    db.query("select save_purchase_plan($1,$2) as id", [
      { ...guidedPlan, event_type: "entrenamiento", games: 0 },
      "00000000-0000-0000-0000-000000000212",
    ]),
  )
).rows[0].id;
assert.equal(
  (await db.query("select games from purchase_plans where id=$1", [zeroId]))
    .rows[0].games,
  0,
);
await assert.rejects(() => as(inactive, savePlan), /Cuenta no autorizada/);
await assert.rejects(
  () => db.query("delete from purchase_plans where id=$1", [savedPlan]),
  /permanente/,
);
await db.exec("set role anon");
for (const table of [
  "day_corrections",
  "correction_decisions",
  "purchase_plans",
])
  await assert.rejects(
    () => db.query("select * from " + table),
    /permission denied/,
  );
await db.exec("reset role");
const mixedGroups = [
  {
    type: "futbol",
    teamMode: "club_puebla",
    team: "Club Puebla",
    games: 1,
    slots: [{ start: "09:00", end: "11:00" }],
  },
  { type: "futbol", teamMode: "academy", team: "", games: 2, slots: [] },
  { type: "beisbol", teamMode: "none", team: "", games: 3, slots: [] },
];
const newGroupedDay = (
  await as(admin, () =>
    db.query("select save_sale_day($1) as result", [
      {
        date: "2001-01-01",
        sport: "otro",
        day_type: "evento_especial",
        event_groups: mixedGroups,
      },
    ]),
  )
).rows[0].result.day_id;
assert.deepEqual(
  (
    await db.query("select event_groups from sale_days where id=$1", [
      newGroupedDay,
    ])
  ).rows[0].event_groups,
  mixedGroups,
);
await assert.rejects(
  () =>
    as(admin, () =>
      db.query("select save_sale_day($1,$2,$3)", [
        { date: "2001-01-02", sport: "otro", event_groups: mixedGroups },
        [],
        [{ start_time: "09:00" }],
      ]),
    ),
  /estacionamiento/,
);
const mixedPlan = {
  ...plan,
  event_type: "mixto",
  games: 6,
  model_version: "eventos-2026-10-v3",
  summary: { groups: mixedGroups, partial: false },
};
const mixedRef = "00000000-0000-0000-0000-000000000220";
const mixedId = (
  await as(operator, () =>
    db.query("select save_purchase_plan($1,$2) as id", [mixedPlan, mixedRef]),
  )
).rows[0].id;
assert.deepEqual(
  (await db.query("select summary from purchase_plans where id=$1", [mixedId]))
    .rows[0].summary.groups,
  mixedGroups,
);
await assert.rejects(
  () =>
    as(operator, () =>
      db.query("select save_purchase_plan($1,$2)", [
        { ...mixedPlan, games: 7 },
        mixedRef,
      ]),
    ),
  /total no coincide/,
);
const beforeGroups = await metadata();
const afterGroups = { ...beforeGroups, event_groups: mixedGroups };
await as(admin, () =>
  request(afterGroups, beforeGroups, "00000000-0000-0000-0000-000000000221"),
);
assert.deepEqual((await metadata()).event_groups, mixedGroups);
assert.deepEqual(
  (
    await db.query(
      "select after_data from day_corrections where client_ref=$1",
      ["00000000-0000-0000-0000-000000000221"],
    )
  ).rows[0].after_data.event_groups,
  mixedGroups,
);
const invalidGroups = structuredClone(mixedGroups);
invalidGroups[0].slots[0].end = "08:00";
await assert.rejects(
  () =>
    as(admin, () =>
      request(
        { ...afterGroups, event_groups: invalidGroups },
        afterGroups,
        "00000000-0000-0000-0000-000000000222",
      ),
    ),
  /Desglose/,
);
await assert.rejects(
  () =>
    db.query("update sale_days set event_groups=$1 where id=$2", [
      invalidGroups,
      dayId,
    ]),
  /sale_days_event_groups_check/,
);
const snapshot = (await db.query("select id,amount from tickets order by id"))
  .rows;
const backup = await db.dumpDataDir();
await db.close();
const restored = new PGlite({ loadDataDir: backup });
assert.deepEqual(
  (await restored.query("select id,amount from tickets order by id")).rows,
  snapshot,
);
await restored.exec("set role anon");
await assert.rejects(
  () => restored.query("select * from tickets"),
  /permission denied/,
);
await restored.close();
console.log(
  "OK: SQL migrations, anonymous denial, roles, snapshots, refunds, rollback, retry, counts, legacy repair, closing days, movements, audit log and local backup restore.",
);
