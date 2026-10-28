import assert from "node:assert/strict";
export async function checkProductEquivalences(
  source,
  { admin, operator, inactive },
) {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite({ loadDataDir: await source.dumpDataDir() });
  const id = crypto.randomUUID(),
    old = crypto.randomUUID(),
    suffix = crypto.randomUUID();
  async function as(actor, sql, args = []) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      actor,
    ]);
    try {
      return await db.query(sql, args);
    } finally {
      await db.exec("reset role");
    }
  }
  try {
    await db.query(
      "insert into products(id,name,sell_price,cost_price,external_ref) values($1,$2,20,5,$3)",
      [id, "Canonical " + suffix, "SKU-" + suffix],
    );
    await db.query(
      "insert into products(id,name,sell_price,active,merged_into) values($1,$2,20,false,$3)",
      [old, "Old " + suffix, id],
    );
    const view = (
      await as(operator, "select * from products_view where id=$1", [id])
    ).rows[0];
    assert.equal(view.aliases[0].name, "Old " + suffix);
    assert.equal(view.merged_into, null);
    const count = {
      product_id: old,
      raw: "Old " + suffix,
      source_file: "old-stock.csv",
      physical_count: 4,
      count_source: "pos",
      counted_on: "2020-01-20",
    };
    await as(operator, "select save_inventory_count($1,$2)", [
      [count],
      crypto.randomUUID(),
    ]);
    assert.equal(
      (
        await db.query(
          "select product_id from inventory_counts where source_file='old-stock.csv'",
        )
      ).rows[0].product_id,
      id,
    );
    const ticket = {
      ticket_number: "ALIAS-" + suffix,
      ts: "2020-01-21T18:00:00Z",
      amount: 20,
      items: [
        { raw: "Old " + suffix, qty: 1, unit_price: 20, line_net_amount: 20 },
      ],
    };
    await as(admin, "select save_sale_day($1,$2)", [
      {
        date: "2020-01-21",
        sport: "futbol",
        day_type: "evento_especial",
        event_tags: [],
      },
      [ticket],
    ]);
    assert.equal(
      (
        await db.query(
          "select product_id from ticket_items i join tickets t on t.id=i.ticket_id where t.ticket_number=$1",
          [ticket.ticket_number],
        )
      ).rows[0].product_id,
      id,
    );
    assert.equal(
      (
        await as(operator, "select register_imported_product($1,$2,$3,$4) id", [
          "Old " + suffix,
          "Otro",
          20,
          null,
        ])
      ).rows[0].id,
      id,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from products where id=any($1)",
          [[id, old]],
        )
      ).rows[0].n,
      2,
    );
    await assert.rejects(
      () => db.query("update products set active=true where id=$1", [old]),
      /merged_product_archived/,
    );
    await assert.rejects(
      () =>
        as(
          operator,
          "insert into product_reconciliations(performed_by,reason,source_product,target_product,before_data,after_data) values($1,$2,$3,$4,$5,$6)",
          ["operator", "Invalid mutation", old, id, {}, {}],
        ),
      /permission denied/,
    );
    await db.query(
      "insert into product_reconciliations(performed_by,reason,source_product,target_product,before_data,after_data) values('Test','Test reconciliation',$1,$2,'{}','{}')",
      [old, id],
    );
    assert.equal(
      (await as(operator, "select * from product_reconciliations")).rows.length,
      0,
    );
    assert.equal(
      (await as(inactive, "select * from product_reconciliations")).rows.length,
      0,
    );
    assert.equal(
      (await as(admin, "select * from product_reconciliations")).rows.length,
      1,
    );
    await assert.rejects(
      () =>
        db.query("update product_reconciliations set reason=$1", [
          "Change immutable history",
        ]),
      /permanente/,
    );
    await db.exec("set role anon");
    await assert.rejects(
      () => db.query("select * from product_reconciliations"),
      /permission denied/,
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
}
