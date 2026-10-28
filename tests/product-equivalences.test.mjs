import test from "node:test";
import assert from "node:assert/strict";
import { parseInventory, parseReceipts } from "../lib/csv.js";
import { inventoryRows } from "../lib/inventory-view.js";
test("confirmed aliases reuse one product without combining distinct presentations", () => {
  const products = [
    {
      id: "p",
      name: "Coca cola",
      external_ref: "10022",
      aliases: [{ name: "Coca-cola", external_ref: null }],
    },
    { id: "can", name: "Coca cola lata 355ml", external_ref: "10044" },
    { id: "old", name: "Coca-cola", active: false, merged_into: "p" },
  ];
  const rows = parseInventory(
    "Name,Price,In stock [Olivos]\nCoca-cola,30,10\nCoca cola lata 355ml,25,3",
    products,
  ).counts;
  assert.deepEqual(
    rows.map((r) => r.product_id),
    ["p", "can"],
  );
  assert.throws(
    () =>
      parseInventory(
        "Name,Price,In stock [Olivos]\nCoca-cola,30,10\nCoca cola,30,3",
        products,
      ),
    /repetido/,
  );
  const history = {
    days: [],
    tickets: [],
    items: [],
    counts: [],
    movements: [],
  };
  assert.equal(inventoryRows({ products, history }).length, 2);
});
