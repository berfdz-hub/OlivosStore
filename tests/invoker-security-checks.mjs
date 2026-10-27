import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

// Work on a clone: permission probes and synthetic history never touch source data.
export async function checkInvokerSecurity(
  source,
  { admin, operator, inactive },
) {
  const db = new PGlite({ loadDataDir: await source.dumpDataDir() });
  const as = async (id, sql, params = []) => {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec("reset role");
    }
  };
  try {
    const pid = crypto.randomUUID();
    await as(
      admin,
      "insert into products(id,name,sell_price,cost_price) values($1,'Security fixture',12,4)",
      [pid],
    );
    await as(
      admin,
      "update products set cost_price=5,sell_price=15 where id=$1",
      [pid],
    );
    assert.equal(
      Number(
        (
          await as(admin, "select cost_price from products_view where id=$1", [
            pid,
          ])
        ).rows[0].cost_price,
      ),
      5,
    );
    const normal = crypto.randomUUID(),
      special = crypto.randomUUID();
    const normalItem = crypto.randomUUID(),
      specialItem = crypto.randomUUID();
    for (const [day, item, date, kind] of [
      [normal, normalItem, "2001-04-01", "dia_partido"],
      [special, specialItem, "2001-04-02", "evento_especial"],
    ]) {
      const ticket = crypto.randomUUID();
      await db.query(
        "insert into sale_days(id,date,sport,day_type,created_by) values($1,$2,'futbol',$3,$4)",
        [day, date, kind, admin],
      );
      await db.query(
        "insert into tickets(id,sale_day_id,ts,amount) values($1,$2,$3,15)",
        [ticket, day, date + "T18:00:00Z"],
      );
      await db.query(
        "insert into ticket_items(id,ticket_id,product_id,product_name_raw,qty,unit_price,unit_cost,line_net_amount,line_cost_amount) values($1,$2,$3,'Security fixture',1,15,5,15,5)",
        [item, ticket, pid],
      );
    }
    for (const costs of [false, true])
      for (const allDays of [false, true]) {
        await db.query(
          "update app_settings set operators_see_costs=$1,operators_see_all_days=$2",
          [costs, allDays],
        );
        const product = (
          await as(
            operator,
            "select cost_price from products_view where id=$1",
            [pid],
          )
        ).rows[0];
        assert.equal(
          product.cost_price === null ? null : Number(product.cost_price),
          costs ? 5 : null,
        );
        for (const [id, visible] of [
          [normalItem, allDays],
          [specialItem, true],
        ]) {
          const rows = (
            await as(operator, "select * from ticket_items_view where id=$1", [
              id,
            ])
          ).rows;
          assert.equal(rows.length, visible ? 1 : 0);
          if (visible)
            assert.equal(
              rows[0].unit_cost === null ? null : Number(rows[0].unit_cost),
              costs ? 5 : null,
            );
          const direct = (
            await as(
              operator,
              "select * from olivos_private.ticket_item_costs($1)",
              [id],
            )
          ).rows;
          assert.equal(
            direct.length,
            visible && costs ? 1 : 0,
            "Helper cannot bypass day/cost scope",
          );
        }
        const adminRows = (
          await as(admin, "select * from ticket_items_view where id=$1", [
            normalItem,
          ])
        ).rows;
        assert.equal(adminRows.length, 1);
        assert.equal(Number(adminRows[0].unit_cost), 5);
      }
    for (const id of [operator, inactive]) {
      await assert.rejects(
        () => as(id, "select cost_price from products"),
        /permission denied/,
      );
      await assert.rejects(
        () => as(id, "select id from products where cost_price>0"),
        /permission denied/,
      );
      await assert.rejects(
        () => as(id, "select to_jsonb(p) from products p"),
        /permission denied/,
      );
      await assert.rejects(
        () => as(id, "select unit_cost,line_cost_amount from ticket_items"),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          as(id, "update products_view set sell_price=1 where id=$1", [pid]),
        /permission denied/,
      );
      assert.equal(
        (
          await as(
            id,
            "update products set sell_price=1 where id=$1 returning id",
            [pid],
          )
        ).rows.length,
        0,
      );
      await assert.rejects(
        () =>
          as(
            id,
            "insert into products(name,sell_price) values('Unauthorized',1)",
          ),
        /row-level security/,
      );
    }
    assert.equal(
      (await as(inactive, "select * from products_view")).rows.length,
      0,
    );
    assert.equal(
      (await as(inactive, "select * from ticket_items_view")).rows.length,
      0,
    );
    assert.equal(
      (await as(inactive, "select olivos_private.product_cost($1) cost", [pid]))
        .rows[0].cost,
      null,
    );
    assert.equal(
      (
        await as(
          inactive,
          "select * from olivos_private.ticket_item_costs($1)",
          [specialItem],
        )
      ).rows.length,
      0,
    );
    const noProfile = crypto.randomUUID();
    assert.equal(
      (await as(noProfile, "select * from products_view")).rows.length,
      0,
    );
    assert.equal(
      (await as(noProfile, "select * from ticket_items_view")).rows.length,
      0,
    );
    await db.exec("set role anon");
    for (const sql of [
      "select * from products_view",
      "select * from ticket_items_view",
      `select olivos_private.product_cost('${pid}')`,
      `select * from olivos_private.ticket_item_costs('${specialItem}')`,
    ])
      await assert.rejects(() => db.query(sql), /permission denied/);
    await db.exec("reset role");
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and not coalesce(c.reloptions @> array['security_invoker=true'],false)",
        )
      ).rows[0].n,
      0,
    );
    return {
      costSettings: 2,
      daySettings: 2,
      adminCatalogWrites: true,
      scopePreserved: true,
      rawCostAccessDenied: true,
      inactiveAndAnonymousDenied: true,
    };
  } finally {
    await db.close();
  }
}
