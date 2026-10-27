import test from "node:test";
import assert from "node:assert/strict";
import { parkingRows } from "../lib/parking.js";
import { inventoryTrace } from "../lib/inventory-history.js";

const day = { id: "d", date: "2026-10-20" };
const game = {
  id: "g",
  sale_day_id: "d",
  start_time: "12:00",
  cars_parked: 10,
  cars_charged: 8,
  parking_rate: 30,
  charges_parking: true,
};
const ticket = {
  id: "t",
  sale_day_id: "d",
  ts: "2026-10-20T18:00:00Z",
  amount: 100,
};
test("parking uses charged cars for revenue and all parked cars for averages", () => {
  assert.equal(parkingRows([day], [game], [])[0].total, null);
  const [r] = parkingRows([day], [game], [ticket]);
  assert.equal(r.tarifa, 30);
  assert.equal(r.ingreso, 240);
  assert.equal(r.venta, 100);
  assert.equal(r.total, 340);
  assert.equal(r.ventaPorAuto, 10);
  assert.equal(r.parkingPorAuto, 24);
  assert.equal(r.totalPorAuto, 34);
  assert.equal(
    parkingRows([day], [{ ...game, charges_parking: false }], [ticket])[0]
      .total,
    100,
  );
  assert.equal(
    parkingRows([day], [{ ...game, parking_rate: null }], [ticket])[0].total,
    null,
  );
  assert.equal(
    parkingRows([day], [{ ...game, cars_parked: 0 }], [ticket])[0].totalPorAuto,
    null,
  );
});
test("parking does not duplicate ticket windows or assign simultaneous games arbitrary sales", () => {
  const rows = parkingRows(
    [day],
    [game, { ...game, id: "g2", start_time: "13:00" }],
    [ticket],
  );
  assert.equal(
    rows.reduce((s, r) => s + r.venta, 0),
    100,
  );
  assert.equal(rows[0].venta, 0);
  assert.equal(rows[1].venta, 100);
  assert(
    parkingRows([day], [game, { ...game, id: "g2" }], [ticket]).every(
      (r) => r.venta === null,
    ),
  );
  assert.equal(
    parkingRows([day], [game], [{ ...ticket, amount: null }])[0].total,
    null,
  );
  assert.equal(
    parkingRows([day], [game], [{ ...ticket, amount: -20 }])[0].total,
    220,
  );
});
const h = () => ({
  days: [],
  counts: [
    {
      id: "c",
      product_id: "p",
      physical_count: 20,
      counted_at: "2026-10-19T15:00:00Z",
      count_source: "manual",
    },
  ],
  movements: [
    {
      id: "m",
      product_id: "p",
      qty: 30,
      kind: "purchase",
      occurred_at: "2026-10-20T16:00:00Z",
    },
  ],
  tickets: [
    { id: "t1", ts: "2026-10-19T18:00:00Z" },
    { id: "t2", ts: "2026-10-20T18:00:00Z" },
    { id: "t3", ts: "2026-10-20T19:00:00Z" },
  ],
  items: [
    { product_id: "p", ticket_id: "t1", qty: 4 },
    { product_id: "p", ticket_id: "t2", qty: 5 },
    { product_id: "p", ticket_id: "t2", qty: 2 },
    { product_id: "p", ticket_id: "t3", qty: -1 },
  ],
});
const now = "2026-10-21T18:00:00Z";
test("inventory reconstructs before/after a receipt and aggregates last sale by ticket", () => {
  const r = inventoryTrace(h(), "p", now);
  assert.equal(r.beforeReceipt, 16);
  assert.equal(r.afterReceipt, 46);
  assert.equal(r.soldAfterReceipt, 6);
  assert.equal(r.lastSale.qty, 7);
  assert.equal(r.lastSale.id, "t2");
  assert.equal(r.uncertain, false);
});
test("inventory keeps unknown order, missing baseline and subsequent count explicit", () => {
  const history = h();
  history.movements[0].occurred_at = null;
  history.movements[0].occurred_on = "2026-10-20";
  const r = inventoryTrace(history, "p", now);
  assert.equal(r.beforeReceipt, 16);
  assert.equal(r.uncertain, true);
  assert.equal(r.soldAfterReceipt, 0);
  history.counts.push({
    id: "new",
    product_id: "p",
    physical_count: 40,
    counted_at: "2026-10-20T20:00:00Z",
  });
  assert.equal(inventoryTrace(history, "p", now).interveningCount, true);
  history.counts = [];
  assert.equal(inventoryTrace(history, "p", now).beforeReceipt, null);
  history.movements = [];
  assert.equal(inventoryTrace(history, "p", now).receipt, null);
});
