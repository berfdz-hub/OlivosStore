import assert from "node:assert/strict";
import { businessDate } from "../lib/csv.js";

export async function checkInventoryImport(db, { admin, operator, inactive }) {
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
  const suffix = crypto.randomUUID(),
    date = businessDate();
  const row = (name, extra = {}) => ({
    raw: name + suffix,
    product_id: null,
    physical_count: 12.5,
    count_source: "pos",
    counted_at: null,
    counted_on: date,
    source_file: "export_items (2).csv",
    category: "Bebidas",
    sell_price: 25,
    cost_price: 12,
    external_ref: name + suffix,
    ...extra,
  });
  const save = (rows, ref = crypto.randomUUID()) =>
    db.query("select save_inventory_count($1,$2) n", [rows, ref]);
  const data = [
      row("Coca cola lata 355ml"),
      row("Powerade naranja", { cost_price: null }),
    ],
    ref = crypto.randomUUID();
  const before = (await db.query("select count(*)::int n from products"))
    .rows[0].n;
  assert.equal((await as(operator, () => save(data, ref))).rows[0].n, 2);
  assert.equal((await as(operator, () => save(data, ref))).rows[0].n, 2);
  assert.equal(
    (await db.query("select count(*)::int n from products")).rows[0].n,
    before + 2,
  );
  const counts = (
    await db.query("select * from inventory_counts where client_ref=$1", [ref])
  ).rows;
  assert.equal(counts.length, 2);
  assert(
    counts.every(
      (c) =>
        c.source_file === data[0].source_file &&
        c.created_by === operator &&
        c.created_at,
    ),
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from audit_log where table_name='inventory_counts' and record_id=any($1)",
        [counts.map((c) => c.id)],
      )
    ).rows[0].n,
    2,
  );
  const product = (
    await db.query("select * from products where external_ref=$1", [
      data[0].external_ref,
    ])
  ).rows[0];
  assert.equal(Number(product.cost_price), 12);
  assert.equal(Number(product.sell_price), 25);
  // Different filename/time: use the same SKU without rewriting catalogue prices or costs.
  const again = {
    ...data[0],
    raw: "Nombre del archivo cambiado",
    sell_price: 999,
    cost_price: 999,
    counted_on: "2020-01-15",
  };
  await as(admin, () => save([again]));
  assert.deepEqual(
    (await db.query("select * from products where id=$1", [product.id]))
      .rows[0],
    product,
  );
  // A matching name can reuse an item even if the old catalogue has no SKU.
  const plain = row("Nombre exacto", { external_ref: null });
  await as(admin, () => save([plain]));
  const plainProduct = (
    await db.query("select * from products where name=$1", [plain.raw])
  ).rows[0];
  await as(operator, () =>
    save([
      {
        ...plain,
        raw: "  " + plain.raw.toUpperCase() + "  ",
        external_ref: "new-ref-" + suffix,
        counted_on: "2020-01-16",
      },
    ]),
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from inventory_counts where product_id=$1",
        [plainProduct.id],
      )
    ).rows[0].n,
    2,
  );
  // All failure cases roll back new products, counts and their audit entries together.
  const size = async () =>
    (
      await db.query(
        "select (select count(*)::int from products) p,(select count(*)::int from inventory_counts) c,(select count(*)::int from audit_log) a",
      )
    ).rows[0];
  const baseline = await size();
  for (const bad of [
    row("Sin precio", { sell_price: null }),
    row("Costo negativo", { cost_price: -1 }),
    row("Cantidad negativa", { physical_count: -1 }),
    row("Futuro", { counted_on: "2099-01-01" }),
    row("Sin archivo", { source_file: null }),
    row("Ruta", { source_file: "C:/inventario.csv" }),
    { ...data[0], external_ref: "conflict-" + suffix },
    { ...data[0], product_id: plainProduct.id },
  ]) {
    await assert.rejects(() =>
      as(operator, () => save([row("Debe revertirse"), bad])),
    );
    assert.deepEqual(await size(), baseline);
  }
  await assert.rejects(
    () => as(operator, () => save(data)),
    /Ya hay un conteo/,
  );
  await assert.rejects(
    () => as(operator, () => save([{ ...data[0], physical_count: 3 }], ref)),
    /reintento/,
  );
  await assert.rejects(
    () => as(inactive, () => save([row("Inactivo")])),
    /no autorizada/,
  );
  await db.exec("set role anon");
  await assert.rejects(() => save([row("Anónimo")]), /permission denied/);
  await db.exec("reset role");
  await db.query("update products set active=false where id=$1", [product.id]);
  await assert.rejects(
    () => as(operator, () => save([{ ...data[0], counted_on: "2020-01-17" }])),
    /no disponible/,
  );
  await db.query("update products set active=true where id=$1", [product.id]);
  return {
    atomic: true,
    retrySafe: true,
    operatorAndAdmin: true,
    anonymousAndInactiveDenied: true,
    sourceRecorded: true,
    existingProductsPreserved: true,
  };
}
