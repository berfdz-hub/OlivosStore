import test from "node:test";
import assert from "node:assert/strict";
import { parseInventory } from "../lib/csv.js";
import { inventoryCountRows } from "../lib/inventory-import.js";

test("inventory CSV carries new product identity, price, costs and filename into one request", () => {
  const parsed = parseInventory(
    "SKU,Name,Category,Price,Cost,In stock [Olivos]\nA,Agua,Bebidas,20,8,15\nB,Powerade naranja,Bebidas,30,12,7",
    [{ id: "p", name: "Agua", external_ref: "A" }],
  );
  const rows = inventoryCountRows(
    parsed.counts.map((product) => ({
      product,
      quantity: product.physical_count,
      source: "pos",
    })),
    "export_items (2).csv",
  );
  assert.equal(rows[0].product_id, "p");
  assert.equal(rows[1].product_id, null);
  assert.equal(rows[1].raw, "Powerade naranja");
  assert.equal(rows[1].sell_price, 30);
  assert.equal(rows[1].cost_price, 12);
  assert.equal(rows[1].source_file, "export_items (2).csv");
  assert.equal(rows[1].external_ref, "B");
  assert.equal(rows[1].physical_count, 7);
});
test("new inventory items require a valid export and price; edits keep the filename", () => {
  const product = {
    raw: "Nuevo",
    product_id: null,
    sell_price: 20,
    cost_price: null,
    physical_count: 5,
  };
  assert.throws(
    () => inventoryCountRows([{ product, quantity: 5, source: "manual" }]),
    /archivo/,
  );
  assert.throws(
    () =>
      inventoryCountRows(
        [
          {
            product: { ...product, sell_price: null },
            quantity: 5,
            source: "pos",
          },
        ],
        "stock.csv",
      ),
    /precio/,
  );
  assert.throws(
    () =>
      inventoryCountRows(
        [{ product, quantity: NaN, source: "pos" }],
        "stock.csv",
      ),
    /cantidad/,
  );
  const [edited] = inventoryCountRows(
    [{ product, quantity: 6, source: "manual" }],
    "stock.csv",
  );
  assert.equal(edited.count_source, "manual");
  assert.equal(edited.source_file, "stock.csv");
});
