import test from "node:test";
import assert from "node:assert/strict";
import {
  parseReceipts,
  parseInventory,
  parseBusinessDate,
  businessDate,
  parseCSV,
} from "../lib/csv.js";
import { monetaryBreakdown, inventoryAt } from "../lib/accounting.js";
import { selectAll, escapeHTML } from "../lib/safe.js";
import { saveDay, checkSchema } from "../lib/importer.js";
const header =
  "Fecha,Número de recibo,Tipo de recibo,Artículo,Cantidad,Ventas brutas,Ventas netas,Costo de los bienes\n";
test("exact size identity and unknown names never use fuzzy matches", () => {
  const catalog = [
    { id: "small", name: "Agua 600 ml" },
    { id: "large", name: "Agua 1500 ml" },
  ];
  const p = parseReceipts(
    header + "19/9/2026 12:00,R1,Venta,Agua 600 ml,1,10,10,4\n",
    catalog,
  );
  assert.equal(p.tickets[0].items[0].product_id, "small");
  const q = parseReceipts(
    header + "19/9/2026 12:00,R1,Venta,Agua 6000 ml,1,10,10,4\n",
    catalog,
  );
  assert.equal(q.tickets[0].items[0].product_id, null);
});
test("refunds retain signed sales, units and historical costs", () => {
  const p = parseReceipts(
    header +
      "19/9/2026 12:00,R1,Venta,Agua,2,100,80,40\n19/9/2026 13:00,R2,Reembolso,Agua,1,50,40,20\n",
  );
  assert.equal(
    p.tickets.reduce((s, t) => s + t.amount, 0),
    40,
  );
  assert.equal(p.tickets[1].items[0].qty, -1);
  assert.equal(p.tickets[1].items[0].unit_cost, 20);
});
test("one receipt number reused on different dates remains distinct", () => {
  const p = parseReceipts(
    header +
      "19/9/2026 12:00,R1,Venta,A,1,10,10,4\n20/9/2026 12:00,R1,Venta,A,1,10,10,4\n",
  );
  assert.equal(p.tickets.length, 2);
});
test("timezone independent Mexican business date and invalid dates", () => {
  assert.equal(
    parseBusinessDate("19/9/2026 11:59 p. m.").toISOString(),
    "2026-09-20T05:59:00.000Z",
  );
  assert.equal(
    businessDate(parseBusinessDate("19/9/2026 11:59 p. m.")),
    "2026-09-19",
  );
  assert.equal(parseBusinessDate("31/2/2026 12:00"), null);
  assert.equal(parseBusinessDate("19/9/2026 25:00"), null);
});
test("bad rows fail visibly instead of importing zero or rolled-over dates", () => {
  assert.throws(
    () => parseReceipts(header + "31/2/2026 12:00,R1,Venta,A,1,10,10,4\n"),
    /Fecha inválida/,
  );
  assert.throws(
    () => parseReceipts(header + "19/9/2026 12:00,R1,Venta,A,1,no,no,4\n"),
    /importe/,
  );
  assert.throws(() => parseCSV('a,b\n"unclosed'), /comillas/);
});
test("inventory never inherits a previous product cost and preserves fractional quantities", () => {
  const p = parseInventory(
    "Name,Cost,Price,In stock [Tienda]\nProducto A,15,30,10\nProducto B,,50,5.5\n",
  );
  assert.equal(p.productsToCreate[1].cost_price, null);
  assert.equal(p.counts[1].physical_count, 5.5);
});
test("multiple stores, duplicate product rows and negative counts require review", () => {
  assert.throws(
    () => parseInventory("Name,In stock [A],In stock [B]\nAgua,2,3"),
    /varias tiendas/,
  );
  assert.throws(
    () => parseInventory("Name,In stock [A]\nAgua,2\nAgua,3"),
    /repetido/,
  );
  assert.throws(() => parseInventory("Name,In stock [A]\nAgua,-2"), /negativa/);
});
test("low stock thresholds are not treated as stock", () => {
  const p = parseInventory(
    "Name,Price,In stock [A],Low stock [A]\nAgua,20,8,3",
  );
  assert.equal(p.counts[0].physical_count, 8);
});
test("historical accounting does not use a mutable catalogue", () => {
  const ts = [{ id: "t", amount: 80 }],
    is = [
      {
        ticket_id: "t",
        product_id: "p",
        qty: 2,
        line_net_amount: 80,
        unit_cost: 20,
        unit_price: 50,
      },
    ];
  const a = monetaryBreakdown(ts, is);
  assert.equal(a.ventaConCosto - a.costoTotal, 40);
  assert.equal(a.productCosts.get("p"), 40);
  const b = monetaryBreakdown(ts, is);
  assert.deepEqual(a, b);
});
test("old receipts without original amounts are explicitly unallocated", () => {
  const r = monetaryBreakdown(
    [{ id: "a", amount: 100 }],
    [{ ticket_id: "a", product_id: "p", qty: 1 }],
  );
  assert.equal(r.ventaSinCosto, 100);
  assert.equal(r.costoTotal, 0);
  assert.equal(r.unallocatedTickets, 1);
  assert.equal(r.productSales.size, 0);
});
test("line costs keep original cents when fractional unit cost needs rounding", () => {
  const parsed = parseReceipts(
    header + "19/9/2026 12:00,R1,Venta,Agua,3,30,30,10\n",
  );
  const item = parsed.tickets[0].items[0];
  assert.equal(item.line_cost_amount, 10);
  assert.equal(
    monetaryBreakdown([{ id: "t", amount: 30 }], [{ ...item, ticket_id: "t" }])
      .costoTotal,
    10,
  );
});
test("known/unknown costs reconcile including refunds and zero costs", () => {
  const r = monetaryBreakdown(
    [
      { id: "a", amount: 100 },
      { id: "b", amount: -20 },
    ],
    [
      {
        ticket_id: "a",
        product_id: "p",
        qty: 1,
        line_net_amount: 60,
        unit_cost: 0,
      },
      {
        ticket_id: "a",
        product_id: "q",
        qty: 1,
        line_net_amount: 40,
        unit_cost: null,
      },
      {
        ticket_id: "b",
        product_id: "p",
        qty: -1,
        line_net_amount: -20,
        unit_cost: 0,
      },
    ],
  );
  assert.equal(r.ventaConCosto + r.ventaSinCosto, 80);
  assert.equal(r.ventaConCosto, 40);
  assert(r.unknownCostProducts.has("q"));
});
test("inventory respects same-day timestamps, receipts, refunds and movements", () => {
  const result = inventoryAt(
    {
      days: [{ id: "d", date: "2026-09-19" }],
      counts: [
        {
          product_id: "p",
          sale_day_id: "d",
          physical_count: 5,
          counted_at: "2026-09-19T16:00:00Z",
          count_source: "manual",
        },
      ],
      tickets: [
        { id: "a", ts: "2026-09-19T17:00:00Z" },
        { id: "b", ts: "2026-09-19T18:00:00Z" },
      ],
      items: [
        { product_id: "p", ticket_id: "a", qty: 8 },
        { product_id: "p", ticket_id: "b", qty: -1 },
      ],
      movements: [
        { product_id: "p", occurred_at: "2026-09-19T16:30:00Z", qty: 10 },
      ],
    },
    "2026-09-20T00:00:00Z",
  );
  assert.equal(result.get("p").value, 8);
  assert.equal(result.get("p").uncertain, false);
});
test("negative stock stays visible and old counts stay uncertain", () => {
  const data = {
    days: [{ id: "d", date: "2026-09-19" }],
    counts: [
      {
        product_id: "p",
        sale_day_id: "d",
        physical_count: 1,
        counted_at: "2026-09-19T16:00:00Z",
      },
    ],
    tickets: [{ id: "a", ts: "2026-09-19T17:00:00Z" }],
    items: [{ product_id: "p", ticket_id: "a", qty: 3 }],
  };
  const result = inventoryAt(data, "2026-09-20T00:00:00Z");
  assert.equal(result.get("p").value, -2);
  assert.equal(result.get("p").inconsistent, true);
  data.counts[0].counted_at = null;
  assert.equal(
    inventoryAt(data, "2026-09-21T00:00:00Z").get("p").uncertain,
    true,
  );
});
test("pagination loads beyond 1,000 rows and throws on later-page failure", async () => {
  const rows = Array.from({ length: 1101 }, (_, id) => ({ id }));
  let fail = false;
  const client = {
    from() {
      return {
        select() {
          return this;
        },
        order() {
          return this;
        },
        range(a, b) {
          return Promise.resolve(
            fail && a >= 500
              ? { error: { message: "network" } }
              : { data: rows.slice(a, b + 1) },
          );
        },
      };
    },
  };
  assert.equal((await selectAll(client, "tickets")).length, 1101);
  fail = true;
  await assert.rejects(() => selectAll(client, "tickets"), /network/);
});
test("HTML escaping handles text and quoted attributes", () =>
  assert.equal(
    escapeHTML('<img onerror="x">&\''),
    "&lt;img onerror=&quot;x&quot;&gt;&amp;&#39;",
  ));
test("missing schema fails closed and atomic save propagates database failures", async () => {
  await assert.rejects(
    () =>
      checkSchema({
        from() {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            maybeSingle() {
              return { data: null, error: { message: "missing" } };
            },
          };
        },
      }),
    /pendiente/,
  );
  await assert.rejects(
    () =>
      saveDay(
        { rpc: async () => ({ error: { message: "rollback" } }) },
        { day: { date: "2026-09-19" } },
      ),
    /rollback/,
  );
});

test("standalone counts feed stock without a fictitious sale day, while scoped-out sale counts remain excluded", () => {
  const data = {
    days: [],
    tickets: [{ id: "s", ts: "2026-10-26T19:00:00Z" }],
    items: [{ ticket_id: "s", product_id: "p", qty: 2 }],
    counts: [
      {
        sale_day_id: null,
        product_id: "p",
        physical_count: 12,
        counted_at: "2026-10-26T18:00:00Z",
        count_source: "manual",
      },
      {
        sale_day_id: "out-of-scope",
        product_id: "q",
        physical_count: 999,
        counted_at: "2026-10-26T18:00:00Z",
      },
    ],
  };
  const stock = inventoryAt(data, "2026-10-26T20:00:00Z");
  assert.equal(stock.get("p").value, 10);
  assert.equal(stock.get("p").date, "2026-10-26");
  assert.equal(stock.has("q"), false);
  assert.equal(inventoryAt(data, "2026-10-26T17:00:00Z").size, 0);
});
