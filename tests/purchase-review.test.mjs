import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import {
  renderPurchase,
  renderPurchaseRows,
  reviewedPurchase,
} from "../lib/purchase-review.js";
const make = () => {
  const { document } = parseHTML(
    fs.readFileSync(new URL("../reportes.html", import.meta.url), "utf8"),
  );
  const p = {
    targetDate: "2099-01-03",
    games: null,
    partial: true,
    days: [],
    safety: 0.1,
    comparison: "Sin historial",
    confidence: "baja",
    excludedIncomplete: 0,
    rows: [
      {
        productId: "p",
        name: "Agua",
        expected: null,
        demand: null,
        buy: null,
        inventory: null,
        manualOnly: true,
      },
    ],
  };
  renderPurchase(p, [], document);
  document.getElementById("planManual").checked = true;
  renderPurchaseRows(p, [], document);
  document.getElementById("planReviewed").checked = true;
  return { document, p };
};
test("manual draft needs a reason and records unknown demand as unknown", () => {
  const { document, p } = make();
  document.querySelector(".planChosen").value = "12";
  assert.throws(() => reviewedPurchase(p, document), /motivo/);
  document.getElementById("planManualReason").value =
    "Cantidad definida por el encargado";
  const review = reviewedPurchase(p, document);
  assert.equal(review.draft, true);
  assert.equal(review.manual, true);
  assert.equal(review.rows[0].chosen, 12);
  assert.equal(review.rows[0].expected, null);
  assert.equal(review.rows[0].buy, null);
  document.querySelector(".planChosen").value = "-1";
  assert.throws(() => reviewedPurchase(p, document), /cantidades/);
});
test("cleared manual quantity remains blank across row rerenders instead of restoring a suggestion", () => {
  const { document, p } = make();
  p.partial = false;
  p.rows[0] = {
    ...p.rows[0],
    manualOnly: false,
    buy: 12,
    expected: 15,
    demand: 17,
    chosen: null,
  };
  renderPurchaseRows(p, [], document);
  assert.equal(document.querySelector(".planChosen").value, "");
  document.getElementById("planManualReason").value =
    "Pendiente de confirmación del encargado";
  assert.equal(reviewedPurchase(p, document).draft, true);
});
