import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { inventoryAt } from "../lib/accounting.js";
import { inventoryTimestamp } from "../lib/inventory-time.js";
import { inventoryRows, initInventoryView } from "../lib/inventory-view.js";
import { showSection } from "../lib/navigation.js";

const now = new Date("2026-10-26T18:00:00Z");
const history = () => ({
  days: [],
  tickets: [],
  items: [],
  counts: [
    {
      id: "c",
      product_id: "p",
      physical_count: 20,
      counted_at: "2026-10-25T16:00:00Z",
      count_source: "manual",
    },
  ],
  movements: [],
});
test("unknown hours remain absent and invalid or future dates cannot masquerade as now", () => {
  assert.deepEqual(inventoryTimestamp({ now: true }, now), {
    at: now.toISOString(),
    on: "2026-10-26",
  });
  assert.deepEqual(inventoryTimestamp({ date: "2026-10-25", time: "" }, now), {
    at: null,
    on: "2026-10-25",
  });
  assert.deepEqual(
    inventoryTimestamp({ date: "2026-10-25", time: "09:30" }, now),
    { at: "2026-10-25T15:30:00.000Z", on: "2026-10-25" },
  );
  for (const choice of [
    { date: "2026-02-30" },
    { date: "2026-10-27" },
    { date: "2026-10-26", time: "13:00" },
    { date: "", time: "" },
  ])
    assert.throws(() => inventoryTimestamp(choice, now));
});
test("a same-day count with no known hour cannot leave earlier stock trusted", () => {
  const h = history();
  h.counts.push({
    id: "new",
    product_id: "p",
    physical_count: 8,
    counted_on: "2026-10-26",
    counted_at: null,
    count_source: "manual",
  });
  const row = inventoryAt(h, now.toISOString()).get("p");
  assert.equal(row.countId, "new");
  assert.equal(row.uncertain, true);
  assert.equal(row.countedAt, null);
});
test("unknown receipt ordering invalidates stock until a subsequent exact count", () => {
  const h = history();
  h.movements.push({
    product_id: "p",
    qty: 30,
    occurred_on: "2026-10-25",
    occurred_at: null,
  });
  assert.equal(inventoryAt(h, now.toISOString()).get("p").uncertain, true);
  h.counts.push({
    id: "new",
    product_id: "p",
    physical_count: 45,
    counted_at: "2026-10-26T15:00:00Z",
    count_source: "manual",
  });
  const row = inventoryAt(h, now.toISOString()).get("p");
  assert.equal(row.uncertain, false);
  assert.equal(row.value, 45);
});
test("future unknown counts do not replace the latest real count, including historical cutoffs", () => {
  const h = history();
  h.counts.push({
    product_id: "p",
    physical_count: 900,
    counted_on: "2026-10-27",
    count_source: "manual",
  });
  assert.equal(inventoryAt(h, now.toISOString()).get("p").value, 20);
  h.movements.push({ product_id: "p", qty: 99, occurred_on: "2026-10-27" });
  assert.equal(inventoryAt(h, now.toISOString()).get("p").uncertain, false);
});
test("a physical count after an already recorded same-day receipt supersedes its unknown hour", () => {
  const h = history();
  h.movements = [
    {
      product_id: "p",
      qty: 30,
      occurred_on: "2026-10-26",
      occurred_at: null,
      created_at: "2026-10-26T14:00:00Z",
    },
  ];
  h.counts = [
    {
      id: "later",
      product_id: "p",
      physical_count: 40,
      counted_at: "2026-10-26T16:00:00Z",
      count_source: "manual",
    },
  ];
  const row = inventoryAt(h, now.toISOString()).get("p");
  assert.equal(row.uncertain, false);
  assert.equal(row.value, 40);
});
test("inventory retains uncounted and inactive products and does not turn manual purchases into automatic estimates", () => {
  const c = {
    products: [
      { id: "p", name: "Agua", active: true },
      { id: "q", name: "Coca", active: true },
      { id: "r", name: "Anterior", active: false },
    ],
    history: history(),
  };
  const forecast = { rows: [{ productId: "p", buy: 7 }] },
    plan = { rows: [{ productId: "p", manual: true, chosen: 10 }] };
  const rows = inventoryRows(c, forecast, plan);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.product.id === "q").have, null);
  const p = rows.find((r) => r.product.id === "p");
  assert.equal(p.buy, null);
  assert.equal(p.original.chosen, 10);
  assert.equal(p.lastReceipt, null);
  assert.equal(plan.rows[0].chosen, 10);
});
function page() {
  const { document, window } = parseHTML(
    fs.readFileSync(new URL("../reportes.html", import.meta.url), "utf8"),
  );
  for (const select of document.querySelectorAll("select"))
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return (
          this.querySelector("option[selected]")?.getAttribute("value") || ""
        );
      },
      set(value) {
        for (const option of this.querySelectorAll("option"))
          option.toggleAttribute(
            "selected",
            option.getAttribute("value") === value,
          );
      },
    });
  for (const e of document.querySelectorAll("*")) {
    e.focus = () => {};
    e.scrollIntoView = () => {};
  }
  document.getElementById("formMovement").reset = () => {};
  return { document, window };
}
test("restored overview lives in Jornadas and remains accessible through old Inicio links", () => {
  const { document } = page();
  showSection(document, "inicio", true);
  assert.equal(
    document.getElementById("homeKpis").closest(".pane").id,
    "pane-jornadas",
  );
  assert.equal(
    document.getElementById("homePending").closest(".pane").id,
    "pane-jornadas",
  );
  assert.equal(
    document.getElementById("homeNext").closest(".pane").id,
    "pane-jornadas",
  );
  assert(document.getElementById("pane-jornadas").classList.contains("on"));
  assert.equal(document.querySelectorAll(".pane .pane").length, 0);
});
test("movement retry preserves its automatic timestamp and request; waste stores a negative quantity", async () => {
  const { document, window } = page(),
    requests = [];
  const context = {
    products: [{ id: "p", name: "Agua", active: true }],
    plans: [],
    history: history(),
    admin: false,
    me: { id: "u" },
  };
  const ui = initInventoryView({
    root: document,
    context: () => context,
    onPurchase: () => {},
    refresh: async () => {},
    client: {
      rpc: async (name, p) => {
        requests.push({ name, p });
        return requests.length === 1
          ? { error: { message: "Sin conexión" } }
          : { data: "saved" };
      },
    },
  });
  ui.render();
  document.getElementById("moveProduct").value = "p";
  document.getElementById("moveKind").value = "waste";
  document.getElementById("moveQty").value = "2";
  document.getElementById("moveNote").value = "Producto caducado";
  const submit = async () => {
    document
      .getElementById("formMovement")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await new Promise((r) => setImmediate(r));
  };
  await submit();
  assert.match(
    document.getElementById("inventoryMessage").textContent,
    /Sin conexión/,
  );
  await submit();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].p.p_qty, -2);
  assert(requests[1].p.p_at);
  assert.match(
    document.getElementById("inventoryMessage").textContent,
    /guardado/,
  );
});
test("product detail escapes stored names and movement notes and keeps uncertain stock out of the main quantity", () => {
  const { document, window } = page(),
    attack = "<img src=x onerror=alert(1)>";
  const h = history();
  h.counts[0].count_source = "legacy";
  h.movements = [
    {
      id: "m",
      product_id: "p",
      occurred_at: "2026-10-26T10:00:00Z",
      kind: "purchase",
      qty: 3,
      note: attack,
    },
  ];
  const c = {
    products: [{ id: "p", name: attack, active: true }],
    plans: [],
    history: h,
    admin: true,
    me: { id: "u" },
  };
  const ui = initInventoryView({
    root: document,
    context: () => c,
    client: {},
    refresh: async () => {},
    onPurchase: () => {},
  });
  ui.render();
  document
    .querySelector("[data-inventory-product]")
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(
    document.getElementById("inventoryDetailStock").textContent,
    /Por confirmar/,
  );
  assert.equal(document.querySelectorAll('img[src="x"],[onerror]').length, 0);
  assert(
    document
      .getElementById("inventoryProductMovements")
      .textContent.includes(attack),
  );
});
