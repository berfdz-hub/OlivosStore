import { escapeHTML as H } from "./safe.js";
import { groupLabel } from "./event-groups.js";

export function renderPurchase(prediction, products, root = document) {
  const el = (id) => root.getElementById(id),
    p = prediction;
  el("planReviewed").checked = false;
  el("planManual").checked = false;
  el("planManualFields").hidden = true;
  el("planManualReason").value = "";
  const missing = (p.components || []).filter(
    (c) => !c.references.length,
  ).length;
  const stockMissing = p.rows.filter((r) => r.inventory == null).length;
  el("predictorSummary").innerHTML =
    `<p><b>${H(p.targetDate)}</b> · ${p.games == null ? "cantidad por confirmar" : p.games + " partidos"} · ${p.days.length} día(s) de referencia</p>` +
    (p.partial
      ? `<div class="msg warn">Borrador: ${missing ? "faltan referencias para " + missing + " actividades o partidos" : "falta completar el historial"}. Puedes completar cantidades manualmente; quedarán marcadas.</div>`
      : `<p class="footnote">Confianza ${H(p.confidence)}. Incluye ${Math.round(p.safety * 100)}% de reserva adicional.</p>`) +
    (stockMissing
      ? `<p class="msg warn">Confirma las existencias de ${stockMissing} producto(s) antes de comprar. <button class="btn sec sm" data-action="tab" data-tab-target="inventario">Actualizar existencias</button></p>`
      : "");
  el("predictionDetails").innerHTML =
    `<p>${H(p.comparison)}</p><ul>${(p.groups || []).map((g) => `<li>${H(groupLabel(g))}</li>`).join("")}</ul><ul>${(p.warnings || []).map((w) => `<li>${H(w)}</li>`).join("")}</ul>` +
    (p.components || [])
      .map(
        (c) =>
          `<details><summary>${H(c.label)} · ${new Set(c.references.map((r) => r.date)).size} día(s)</summary><p>${H(c.basis)}</p><ul>${c.references.map((r) => `<li>${H(r.date)} · ${H(r.start || "sin hora")}${r.end ? "–" + H(r.end) : ""} · ${H(r.method)}</li>`).join("") || "<li>Falta historial comparable de esta actividad.</li>"}</ul></details>`,
      )
      .join("") +
    `<p>${p.excludedIncomplete} día(s) excluidos por detalle incompleto.</p>`;
  renderPurchaseRows(p, products, root);
}
export function renderPurchaseRows(p, products, root = document) {
  const manual = root.getElementById("planManual").checked;
  root.querySelector("#tblPrediction tbody").innerHTML =
    p.rows
      .map((r, i) => {
        const note = r.manualOnly
          ? "Agregado manualmente"
          : r.partial
            ? "Estimación parcial"
            : r.inventory == null
              ? "Confirma existencias"
              : r.missingLimit
                ? "Configura el cupo de conservación"
                : r.capped
                  ? "Limitado por espacio o conservación"
                  : "";
        return `<tr><td><b>${H(r.name)}</b>${note ? '<br><span class="tiny">' + H(note) + "</span>" : ""}</td><td class="num">${r.expected == null ? "Sin estimación" : r.expected.toFixed(1) + (r.partial ? " (parcial)" : "")}<details><summary>Detalle</summary><p>Objetivo con reserva: ${r.demand ?? "por definir"}. Rango estimado: ${r.low ?? "—"}–${r.high ?? "—"}.</p><ul>${(r.contributions || []).map((c) => `<li>${H(c.label)}: ${c.expected == null ? "sin referencia" : c.expected.toFixed(1)}</li>`).join("")}</ul></details></td><td class="num">${r.inventory ?? "Por confirmar"}${r.stockDate ? '<br><span class="tiny">Conteo ' + H(r.stockDate) + "</span>" : ""}</td><td class="num"><span>${r.buy ?? "Pendiente"}</span><div class="manual-quantity" ${manual ? "" : "hidden"}><label class="tiny" for="planChosen${i}">Cantidad manual</label><input class="planChosen" id="planChosen${i}" aria-label="Compra revisada de ${H(r.name)}" type="number" min="0" step="1" inputmode="numeric" data-index="${i}" value="${(Object.hasOwn(r, "chosen") ? r.chosen : r.buy) ?? ""}" ${manual ? "" : "disabled"}></div></td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="4">Todavía no hay referencias. Completa cantidades manualmente para preparar un borrador.</td></tr>';
  root.getElementById("planAddProduct").innerHTML =
    '<option value="">Elige un producto</option>' +
    products
      .filter(
        (product) =>
          product.active !== false &&
          !p.rows.some((r) => r.productId === product.id),
      )
      .map(
        (product) =>
          `<option value="${H(product.id)}">${H(product.name)}</option>`,
      )
      .join("");
  const draft = p.partial || p.rows.some((r) => r.buy == null);
  root.getElementById("btnSavePlan").textContent = draft
    ? "Guardar borrador"
    : "Guardar lista";
  root.getElementById("btnSavePlan").disabled = !p.rows.length;
}
export function reviewedPurchase(p, root = document) {
  if (!p?.rows.length)
    throw new Error("Calcula la compra o agrega un producto al borrador.");
  if (!root.getElementById("planReviewed").checked)
    throw new Error(
      "Confirma que revisaste las cantidades y los pendientes antes de guardar.",
    );
  const manual = root.getElementById("planManual").checked;
  const reason = root.getElementById("planManualReason").value.trim();
  if (manual && reason.length < 8)
    throw new Error(
      "Explica el motivo de las cantidades manuales (al menos 8 caracteres).",
    );
  const rows = p.rows.map((r) => ({
    ...r,
    chosen: r.buy ?? null,
    manual: false,
  }));
  if (manual)
    for (const input of root.querySelectorAll(".planChosen")) {
      const r = rows[Number(input.dataset.index)];
      if (input.value === "") {
        r.chosen = null;
        continue;
      }
      const n = Number(input.value);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("Revisa las cantidades de compra.");
      if (
        r.limit != null &&
        n > Math.max(0, Math.floor(r.limit - (r.inventory ?? 0)))
      )
        throw new Error(
          "La compra de " +
            r.name +
            " supera el límite asignado. Administración debe revisar ese límite.",
        );
      r.chosen = n;
      r.manual = true;
    }
  return {
    rows,
    manual,
    reason: manual ? reason : "",
    draft:
      !!p.partial ||
      rows.some((r) => r.buy == null || r.chosen == null || r.manualOnly),
  };
}
