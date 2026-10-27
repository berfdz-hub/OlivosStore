import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

export async function checkParkingCorrections(
  source,
  { admin, operator, inactive },
) {
  const db = new PGlite({ loadDataDir: await source.dumpDataDir() });
  const as = async (id, sql, args = []) => {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try {
      return await db.query(sql, args);
    } finally {
      await db.exec("reset role");
    }
  };
  const snapshot = async (id) =>
    (
      await db.query(
        "select olivos_private.parking_snapshot(g) value from games g where id=$1",
        [id],
      )
    ).rows[0].value;
  const move = (before, updates) => ({
    before,
    after: { ...before, ...updates },
  });
  const request = (
    actor,
    changes,
    ref = crypto.randomUUID(),
    reason = "Corrección verificada en prueba",
  ) =>
    as(actor, "select request_parking_correction($1,$2,$3) result", [
      changes,
      reason,
      ref,
    ]);
  const decide = (
    actor,
    id,
    approve = true,
    note = "Revisión y aprobación de la corrección",
  ) =>
    as(actor, "select review_parking_correction($1,$2,$3)", [
      id,
      approve,
      note,
    ]);
  try {
    const origin = crypto.randomUUID(),
      target = crypto.randomUUID(),
      collision = crypto.randomUUID(),
      closed = crypto.randomUUID(),
      hidden = crypto.randomUUID(),
      limited = crypto.randomUUID();
    for (const [id, date, type] of [
      [origin, "2002-02-20", "evento_especial"],
      [target, "2002-02-17", "evento_especial"],
      [collision, "2002-02-18", "evento_especial"],
      [closed, "2002-02-19", "evento_especial"],
      [hidden, "2002-02-16", "entrenamiento_normal"],
      [limited, "2002-02-15", "evento_especial"],
    ])
      await db.query(
        "insert into sale_days(id,date,sport,day_type,status,created_by) values($1,$2,'futbol',$3,'submitted',$4)",
        [id, date, type, admin],
      );
    await db.query("update sale_days set event_groups=$1 where id=$2", [
      [{ type: "futbol", teamMode: "unknown", team: "", games: 1, slots: [] }],
      limited,
    ]);
    const games = [];
    for (const [time, cars] of [
      ["09:00:00", 38],
      ["11:30:00", 39],
      ["15:45:00", 25],
    ]) {
      const id = crypto.randomUUID();
      games.push(id);
      await db.query(
        "insert into games(id,sale_day_id,start_time,cars_parked,cars_charged,parking_rate,notes) values($1,$2,$3,$4,$4,30,'Juego verificado')",
        [id, origin, time, cars],
      );
    }
    const ticket = crypto.randomUUID();
    await db.query(
      "insert into tickets(id,sale_day_id,ts,amount) values($1,$2,'2002-02-17T18:00:00Z',100)",
      [ticket, target],
    );
    const stableTables = [
      "tickets",
      "ticket_items",
      "inventory_counts",
      "inventory_movements",
      "products",
      "profiles",
      "sale_days",
    ];
    const capture = async (table) =>
      (
        await db.query(
          `select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') value from ${table} t`,
        )
      ).rows[0].value;
    const stable = {};
    for (const table of stableTables) stable[table] = await capture(table);
    const originals = await Promise.all(games.map(snapshot));
    const changes = originals.map((b) => move(b, { date: "2002-02-17" })),
      ref = crypto.randomUUID();
    const result = (await request(admin, changes, ref)).rows[0].result;
    assert.equal(result.applied, true);
    for (const [i, id] of games.entries())
      assert.deepEqual(await snapshot(id), {
        ...originals[i],
        date: "2002-02-17",
        revision: 2,
      });
    assert.equal(
      (
        await db.query(
          "select sum(cars_charged*parking_rate)::numeric total from games where id=any($1)",
          [games],
        )
      ).rows[0].total,
      "3060.00",
    );
    assert.equal(
      (await request(admin, changes, ref)).rows[0].result.id,
      result.id,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from audit_log where table_name='games' and operation='UPDATE' and record_id=any($1)",
          [games],
        )
      ).rows[0].n,
      3,
    );
    await assert.rejects(
      () =>
        request(admin, changes, ref, "Un motivo diferente para este reintento"),
      /reintento/,
    );
    await assert.rejects(() => request(admin, changes), /cambió/);
    await assert.rejects(
      () =>
        request(
          admin,
          [move(originals[0], { date: "2002-02-17" })],
          crypto.randomUUID(),
          "corto",
        ),
      /motivo/,
    );
    for (const actor of [inactive, crypto.randomUUID()])
      await assert.rejects(
        () => request(actor, changes),
        /Cuenta no autorizada/,
      );
    const current = await snapshot(games[0]);
    await assert.rejects(
      () =>
        request(admin, [
          move(current, { cars_charged: current.cars_parked + 1 }),
        ]),
      /Autos enteros/,
    );
    await assert.rejects(
      () => request(admin, [move(current, { cars_parked: 1.5 })]),
      /Autos enteros/,
    );
    await assert.rejects(
      () => request(admin, [move(current, { parking_rate: null })]),
      /Completa/,
    );
    await assert.rejects(
      () => request(admin, [move(current, { date: "2002-02-30" })]),
      /date|fecha/i,
    );
    await assert.rejects(
      () => request(admin, [move(current, { date: "2002-03-01" })]),
      /jornada registrada/,
    );
    await assert.rejects(
      () => request(admin, [move(current, { start_time: "25:00" })]),
      /fecha, hora/,
    );
    await assert.rejects(
      () => request(admin, [move(current, { parking_rate: 1.234 })]),
      /dos decimales/,
    );
    await assert.rejects(
      () =>
        request(admin, [
          move(current, { cars_parked: 40 }),
          move(current, { cars_parked: 40 }),
        ]),
      /repetidos/,
    );
    await assert.rejects(
      async () =>
        request(admin, [
          move(current, { cars_parked: 40 }),
          move(await snapshot(games[1]), { start_time: "09:00:00" }),
        ]),
      /repite fecha y hora/,
    );
    const collisionGame = crypto.randomUUID();
    await db.query(
      "insert into games(id,sale_day_id,start_time) values($1,$2,'09:00')",
      [collisionGame, collision],
    );
    await assert.rejects(
      () => request(admin, [move(current, { date: "2002-02-18" })]),
      /Ya existe estacionamiento/,
    );
    await assert.rejects(
      async () =>
        request(
          admin,
          await Promise.all(
            games.map(async (id) =>
              move(await snapshot(id), { date: "2002-02-15" }),
            ),
          ),
        ),
      /supera los partidos/,
    );
    for (const table of stableTables)
      assert.deepEqual(
        await capture(table),
        stable[table],
        `${table} untouched by parking correction`,
      );
    await db.query("update app_settings set operators_see_all_days=false");
    const hiddenGame = crypto.randomUUID();
    await db.query(
      "insert into games(id,sale_day_id,start_time) values($1,$2,'12:00')",
      [hiddenGame, hidden],
    );
    await assert.rejects(
      async () =>
        request(operator, [
          move(await snapshot(hiddenGame), { cars_parked: 1 }),
        ]),
      /No tienes acceso/,
    );
    await assert.rejects(
      () => request(operator, [move(current, { date: "2002-02-16" })]),
      /disponible para tu cuenta/,
    );
    const pending = (
      await request(operator, [
        move(current, { cars_parked: 40, cars_charged: 40 }),
      ])
    ).rows[0].result;
    assert.equal(pending.applied, false);
    assert.deepEqual(await snapshot(games[0]), current);
    assert.equal(
      (await as(operator, "select count(*)::int n from parking_corrections"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (await as(inactive, "select count(*)::int n from parking_corrections"))
        .rows[0].n,
      0,
    );
    await assert.rejects(
      () => decide(operator, pending.id),
      /Solo administración/,
    );
    await decide(admin, pending.id);
    await decide(admin, pending.id);
    assert.equal((await snapshot(games[0])).cars_charged, 40);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from parking_decisions where correction_id=$1",
          [pending.id],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () => decide(admin, pending.id, false),
      /ya fue resuelta/,
    );
    const beforeStale = await snapshot(games[0]);
    const stale = (
      await request(operator, [
        move(beforeStale, { notes: "Solicitud anterior" }),
      ])
    ).rows[0].result;
    await db.query("update games set notes=notes where id=$1", [games[0]]);
    await assert.rejects(() => decide(admin, stale.id), /cambió/);
    await decide(
      admin,
      stale.id,
      false,
      "Se rechaza porque cambió el registro",
    );
    await db.query("update sale_days set status='reviewed' where id=$1", [
      closed,
    ]);
    const closing = (
      await request(operator, [
        move(await snapshot(games[0]), { date: "2002-02-19" }),
      ])
    ).rows[0].result;
    await assert.rejects(() => decide(admin, closing.id), /Reabre/);
    await assert.rejects(
      async () =>
        request(admin, [
          move(await snapshot(games[0]), { date: "2002-02-19" }),
        ]),
      /Reabre/,
    );
    await decide(
      admin,
      closing.id,
      false,
      "Se conserva la fecha original verificada",
    );
    for (const table of ["parking_corrections", "parking_decisions"]) {
      await assert.rejects(
        () => db.query(`delete from ${table}`),
        /historial es permanente/,
      );
      await assert.rejects(
        () => as(admin, `delete from ${table}`),
        /permission denied/,
      );
      await assert.rejects(
        () => as(operator, `update ${table} set id=id`),
        /permission denied/,
      );
    }
    await assert.rejects(
      () =>
        as(admin, "select olivos_private.check_apply_parking('[]','[]',true)"),
      /permission denied/,
    );
    await assert.rejects(
      () => as(operator, "update games set cars_parked=0"),
      /permission denied/,
    );
    await db.exec("set role anon");
    await assert.rejects(
      () => db.query("select * from parking_corrections"),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        db.query(
          "select request_parking_correction('[]','Intento anónimo',$1)",
          [crypto.randomUUID()],
        ),
      /permission denied/,
    );
    await db.exec("reset role");
    return {
      batchMove: true,
      valuesAndTicketsPreserved: true,
      retriesAndAudit: true,
      operatorRequestAndAdminDecision: true,
      closedConflictStaleDenied: true,
      immutableHistory: true,
    };
  } finally {
    await db.close();
  }
}
