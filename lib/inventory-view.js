import { escapeHTML as H, selectAll } from "./safe.js";
import { inventoryAt } from "./accounting.js";
import { businessDate } from "./csv.js";
import { predictPurchase } from "./prediction.js";
import { initInventoryTime, inventoryTimestamp } from "./inventory-time.js";

const number = (n) =>
  Number(n).toLocaleString("es-MX", { maximumFractionDigits: 3 });
const searchText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
const dateLabel = (at, on) =>
  at
    ? new Intl.DateTimeFormat("es-MX", {
        timeZone: "America/Mexico_City",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(at))
    : on
      ? on + " · hora sin confirmar"
      : "Fecha no disponible";
const kindLabel = {
  purchase: "Mercancía recibida",
  waste: "Merma",
  adjustment: "Ajuste",
};
const receiptDay = (move) =>
  move.occurred_on ||
  (move.occurred_at
    ? businessDate(new Date(move.occurred_at))
    : "Fecha sin confirmar");

export function inventoryState(stock) {
  if (!stock || !Number.isFinite(stock.value)) return "missing";
  return stock.value < 0 ? "review" : "estimated";
}
const stateLabel = (row) =>
  row.state === "missing"
    ? "Sin conteo"
    : row.state === "review"
      ? "Saldo a revisar"
      : row.stock.uncertain
        ? "Estimada"
        : "Según registros";
const stockMarkup = (row) =>
  `<span class="inventory-quantity">${row.estimate === null ? "—" : number(row.estimate)}${row.estimate === null ? "" : "<small> unid.</small>"}</span><span class="inventory-badge ${row.state}">${stateLabel(row)}</span>`;
const stockExplanation = (row) => {
  if (row.state === "missing")
    return "No hay un conteo de partida. Registra uno para calcular este producto.";
  if (row.state === "review")
    return `Las salidas superan lo registrado por ${number(-row.estimate)} unidades. Revisa surtidos o registra un conteo; no son existencias físicas negativas.`;
  return row.stock.uncertain
    ? "Estimación con la información disponible. Hay registros sin hora; un conteo actual permite afinarla."
    : "Saldo calculado con los conteos, ventas y movimientos registrados.";
};

export function inventoryPurchase(plan, context) {
  if (
    !plan ||
    plan.event_date < businessDate() ||
    !plan.summary?.groups?.length
  )
    return null;
  return predictPurchase({
    history: context.history,
    products: context.products,
    plans: context.plans,
    targetDate: plan.event_date,
    groups: plan.summary.groups,
    safety: plan.summary.safety ?? 0.1,
  });
}
export function inventoryRows(context, prediction = null, plan = null) {
  const stock = inventoryAt(context.history);
  const movements = context.history.movements || [];
  return context.products
    .map((product) => {
      const current = stock.get(product.id);
      const receipts = movements
        .filter((m) => m.product_id === product.id && m.kind === "purchase")
        .sort((a, b) => {
          const time = (m) =>
            Date.parse(m.occurred_at || m.occurred_on + "T23:59:59-06:00");
          return (
            time(b) - time(a) ||
            String(b.created_at || "").localeCompare(String(a.created_at || ""))
          );
        });
      const original = plan?.rows?.find((r) => r.productId === product.id);
      const forecast = prediction?.rows?.find(
        (r) => r.productId === product.id,
      );
      const manual = !!original?.manual || !!original?.manualOnly;
      return {
        product,
        stock: current,
        estimate:
          current && Number.isFinite(current.value) ? current.value : null,
        state: inventoryState(current),
        have:
          current && !current.uncertain && !current.inconsistent
            ? current.value
            : null,
        lastReceipt: receipts[0] || null,
        forecast,
        manual,
        original,
        buy: manual ? null : (forecast?.buy ?? null),
      };
    })
    .sort((a, b) => a.product.name.localeCompare(b.product.name, "es"));
}

export function initInventoryView({
  root = document,
  client,
  context,
  refresh,
  onPurchase,
}) {
  const el = (id) => root.getElementById(id);
  let selected = null,
    rows = [],
    prediction = null,
    selectedPlan = null,
    auditSequence = 0,
    pendingMovement = null,
    saving = false;
  let filter = "all";
  const clock = initInventoryTime(root, "move");
  const message = (text, error = false) => {
    el("inventoryMessage").textContent = text;
    el("inventoryMessage").className = "msg " + (error ? "err" : "ok");
    el("inventoryMessage").hidden = !text;
  };
  function render() {
    const c = context(),
      chosen = el("inventoryPlan").value;
    const plans = [...c.plans]
      .filter((p) => p.event_date >= businessDate())
      .sort(
        (a, b) =>
          a.event_date.localeCompare(b.event_date) ||
          b.created_at.localeCompare(a.created_at),
      );
    el("inventoryPlan").innerHTML =
      '<option value="">Sin jornada seleccionada</option>' +
      plans
        .map(
          (p) =>
            `<option value="${H(p.id)}">${H(p.event_date)} · ${p.summary?.draft ? "borrador" : "lista"} · ${H(dateLabel(p.created_at))}</option>`,
        )
        .join("");
    el("inventoryPlan").value = plans.some((p) => p.id === chosen)
      ? chosen
      : "";
    selectedPlan =
      plans.find((p) => p.id === el("inventoryPlan").value) || null;
    prediction = null;
    try {
      prediction = inventoryPurchase(selectedPlan, c);
    } catch (error) {
      message("No se pudo calcular la compra: " + error.message, true);
    }
    el("inventoryPlanNote").textContent = selectedPlan
      ? "Compra recalculada con existencias actuales. Conserva las actividades de la lista elegida; revísalas en Compras."
      : "Elige una jornada para calcular la columna Comprar.";
    el("inventoryBuyLabel").textContent = selectedPlan
      ? "Compra para " + selectedPlan.event_date
      : "Calcular qué comprar";
    rows = inventoryRows(c, prediction, selectedPlan);
    const active = rows.filter((r) => r.product.active !== false);
    el("inventoryStatus").textContent =
      `${active.length} productos · calculado con tus conteos y ventas`;
    el("inventoryFilters").innerHTML = [
      ["all", "Todos", active.length],
      [
        "estimated",
        "Estimados",
        active.filter((r) => r.state === "estimated").length,
      ],
      [
        "review",
        "Revisar saldo",
        active.filter((r) => r.state === "review").length,
      ],
      [
        "missing",
        "Sin conteo",
        active.filter((r) => r.state === "missing").length,
      ],
    ]
      .map(
        ([key, label, count]) =>
          `<button type="button" class="inventory-filter ${key}" data-stock-filter="${key}" aria-pressed="${filter === key}">${label}<b data-stock-count="${key}">${count}</b></button>`,
      )
      .join("");
    const previousProduct = el("moveProduct").value;
    el("moveProduct").innerHTML =
      '<option value="">Elige un producto</option>' +
      active
        .map(
          (r) =>
            `<option value="${H(r.product.id)}">${H(r.product.name)}</option>`,
        )
        .join("");
    el("moveProduct").value = previousProduct;
    renderList();
    if (selected) renderDetail();
  }
  function renderList() {
    const search = searchText(el("inventoryProductSearch").value.trim());
    const showInactive = el("inventoryInactive").checked;
    const eligible = rows.filter(
      (r) => showInactive || r.product.active !== false,
    );
    for (const count of root.querySelectorAll("[data-stock-count]")) {
      const key = count.dataset.stockCount;
      count.textContent = eligible.filter(
        (r) => key === "all" || r.state === key,
      ).length;
    }
    const shown = rows.filter(
      (r) =>
        (showInactive || r.product.active !== false) &&
        (filter === "all" || r.state === filter) &&
        searchText(r.product.name + " " + (r.product.category || "")).includes(
          search,
        ),
    );
    el("inventoryProducts").innerHTML =
      shown
        .map(
          (r) =>
            `<tr${r.product.id === selected ? ' class="selected"' : ""}><td><button type="button" class="inventory-product" data-inventory-product="${H(r.product.id)}" aria-controls="inventoryDetail" aria-expanded="${r.product.id === selected}">${H(r.product.name)} <span aria-hidden="true">›</span></button>${r.product.active === false ? '<span class="tiny">Inactivo</span>' : r.product.category ? `<span class="tiny">${H(r.product.category)}</span>` : ""}</td><td data-label="Saldo estimado"><div class="inventory-amount ${r.state}">${stockMarkup(r)}</div></td><td data-label="Comprar"><span class="${r.buy === null ? "inventory-buy-pending" : "stock-number"}">${r.manual ? "Revisar manual" : r.buy === null ? (selectedPlan ? (r.have === null ? "Revisar saldo" : "Sin referencia") : '<span aria-label="Elige una jornada para calcular">—</span>') : number(r.buy)}</span></td><td data-label="Último surtido">${r.lastReceipt ? `<b>+${number(r.lastReceipt.qty)}</b><span class="tiny">${H(receiptDay(r.lastReceipt))}</span>` : '<span class="tiny">Sin registro</span>'}</td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="4">No hay productos que coincidan.</td></tr>';
    el("inventoryListCount").textContent =
      `${shown.length} ${shown.length === 1 ? "producto" : "productos"}`;
    for (const button of root.querySelectorAll("[data-stock-filter]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.stockFilter === filter),
      );
  }
  function renderDetail() {
    const c = context(),
      row = rows.find((r) => r.product.id === selected);
    if (!row) {
      closeDetail();
      return;
    }
    const { product: p, stock: s } = row;
    el("inventoryDetail").hidden = false;
    el("inventoryLayout").classList.add("detail-open");
    el("inventoryDetailTitle").textContent = p.name;
    el("inventoryDetailStock").innerHTML = stockMarkup(row);
    el("inventoryDetailStock").className = "inventory-amount " + row.state;
    el("inventoryDetailNote").textContent = stockExplanation(row);
    el("inventoryCountProduct").href =
      "operador.html?task=inventario&product=" + encodeURIComponent(p.id);
    el("inventoryCountProduct").hidden = p.active === false;
    el("inventoryReceiptProduct").hidden = p.active === false;
    const dayById = new Map(c.history.days.map((d) => [d.id, d]));
    const counts = c.history.counts.filter((x) => x.product_id === p.id);
    const moves = c.history.movements.filter((x) => x.product_id === p.id);
    const records = [
      ...counts.map((x) => ({
        at: x.counted_at,
        on: x.counted_on || dayById.get(x.sale_day_id)?.date,
        label:
          x.count_source === "pos"
            ? "Existencia importada"
            : x.count_source === "legacy"
              ? "Conteo histórico"
              : "Conteo físico",
        qty: x.physical_count,
        note: x.note,
        actor: x.created_by,
        recorded: x.created_at,
      })),
      ...moves.map((x) => ({
        at: x.occurred_at,
        on: x.occurred_on,
        label: kindLabel[x.kind] || x.kind,
        qty: x.qty,
        note: x.note,
        actor: x.created_by,
        recorded: x.created_at,
      })),
    ].sort((a, b) => String(b.at || b.on).localeCompare(String(a.at || a.on)));
    const ticketById = new Map(c.history.tickets.map((t) => [t.id, t]));
    const sales = c.history.items
      .filter((i) => i.product_id === p.id)
      .map((i) => ({ item: i, t: ticketById.get(i.ticket_id) }))
      .filter((x) => x.t)
      .sort((a, b) => b.t.ts.localeCompare(a.t.ts));
    el("inventoryDetailFacts").innerHTML = s
      ? `<div><dt>Último conteo</dt><dd>${number(s.counted)} unidades · ${H(dateLabel(s.countedAt, s.date))}</dd></div><div><dt>Ventas posteriores${s.countedAt ? "" : " al día del conteo"}</dt><dd>${number(s.soldAfter)} unidades netas</dd></div><div><dt>Entradas y salidas posteriores</dt><dd>${number(s.movedAfter)} unidades netas</dd></div>`
      : "<p>Todavía no hay un conteo de este producto.</p>";
    el("inventoryCalculation").innerHTML = s
      ? `<p><b>${number(s.counted)} + (${number(s.movedAfter)}) − (${number(s.soldAfter)}) = ${number(s.value)}</b></p><p>Conteo + movimientos − ventas netas.</p>${!s.countedAt ? `<p>El conteo del ${H(s.date)} no tiene hora. Para evitar descontar ventas que ya podría incluir, usamos las ventas y movimientos desde el día siguiente. Lo ocurrido ese mismo día queda sin ordenar.</p>` : ""}<p>Solo incluye lo registrado. Los surtidos o ventas faltantes pueden cambiar este saldo; las devoluciones registradas restituyen unidades.</p><label for="inventoryVerify">Comparar con una cantidad física, sin guardar</label><input id="inventoryVerify" type="number" min="0" step="0.001" inputmode="decimal"><p id="inventoryVerifyResult" role="status"></p>`
      : "<p>Cuenta este producto para iniciar el cálculo.</p>";
    const verify = el("inventoryVerify");
    if (verify)
      verify.addEventListener("input", () => {
        const value = verify.value;
        el("inventoryVerifyResult").textContent =
          value === ""
            ? ""
            : `Diferencia frente al saldo estimado: ${number(Number(value) - s.value)} unidades. No se guardó un conteo.`;
      });
    el("inventoryProductMovements").innerHTML =
      records
        .map(
          (x) =>
            `<li><b>${H(x.label)} · ${number(x.qty)} unidades</b><span>${H(dateLabel(x.at, x.on))}</span>${x.note ? "<p>" + H(x.note) + "</p>" : ""}<span class="tiny">${x.actor && x.actor === c.me?.id ? H(c.me.full_name || "Tu cuenta") : x.actor ? "Autor registrado; ver bitácora" : "Autor no disponible en el registro histórico"}${x.recorded ? " · capturado " + H(dateLabel(x.recorded)) : ""}</span></li>`,
        )
        .join("") || "<li>No hay conteos ni movimientos registrados.</li>";
    el("inventoryProductSales").innerHTML =
      sales
        .map(
          ({ item, t }) =>
            `<li><b>${number(item.qty)} unidades${Number(item.qty) < 0 ? " · devolución" : ""}</b><span>${H(dateLabel(t.ts))}</span></li>`,
        )
        .join("") || "<li>No hay ventas registradas para este producto.</li>";
    el("inventoryProductPurchase").innerHTML = selectedPlan
      ? `<p>Jornada ${H(selectedPlan.event_date)} · ${row.manual ? "Cantidad manual guardada: " + H(row.original.chosen ?? "pendiente") + ". Revisa en Compras antes de usarla." : row.buy === null ? "Faltan datos para calcular la compra." : "Compra estimada ahora: " + number(row.buy) + " unidades."}</p>`
      : "<p>Elige una jornada en «Calcular qué comprar».</p>";
    if (row.have === null && selectedPlan)
      el("inventoryProductPurchase").innerHTML +=
        "<p>Este saldo necesita revisión antes de descontarlo automáticamente de una compra. Puedes confirmar existencias o indicar una cantidad manual en Compras.</p>";
    el("inventoryAuditWrap").hidden = !c.admin;
    el("inventoryAudit").textContent = "";
    el("inventoryAuditWrap").open = false;
    auditSequence++;
  }
  function closeDetail() {
    const old = selected;
    selected = null;
    auditSequence++;
    el("inventoryDetail").hidden = true;
    el("inventoryLayout").classList.remove("detail-open");
    renderList();
    const button = [...root.querySelectorAll("[data-inventory-product]")].find(
      (b) => b.dataset.inventoryProduct === old,
    );
    button?.focus();
  }
  function movementKind() {
    const kind = el("moveKind").value;
    el("moveQtyLabel").textContent =
      kind === "purchase"
        ? "¿Cuántas unidades llegaron?"
        : kind === "waste"
          ? "¿Cuántas unidades se perdieron?"
          : "Unidades del ajuste (+ entrada, − salida)";
    el("moveQty").min = kind === "adjustment" ? "" : "0.001";
    el("movementTitle").textContent =
      kind === "purchase"
        ? "Recibí mercancía"
        : kind === "waste"
          ? "Registrar merma"
          : "Ajustar existencias";
    el("moveNote").required = kind !== "purchase";
    el("moveNote").closest("details").open = kind !== "purchase";
    el("moveNoteLabel").textContent =
      kind === "purchase"
        ? "Referencia o nota (opcional)"
        : "Motivo obligatorio";
  }
  function openMovement(kind = "purchase", product = null) {
    if (saving) return;
    el("formMovement").reset();
    clock.reset();
    el("moveProduct").value = product || "";
    el("moveKind").value = kind;
    movementKind();
    el("inventoryMovementPanel").hidden = false;
    el("inventoryOtherActions").open = false;
    el("inventoryMovementPanel").scrollIntoView({ block: "nearest" });
    (product ? el("moveQty") : el("moveProduct")).focus();
  }
  async function saveMovement(event) {
    event.preventDefault();
    if (saving) return;
    const kind = el("moveKind").value,
      raw = Number(el("moveQty").value),
      product = el("moveProduct").value;
    try {
      if (
        !product ||
        el("moveQty").value === "" ||
        !Number.isFinite(raw) ||
        raw === 0 ||
        (kind !== "adjustment" && raw < 0)
      )
        throw Error("Elige el producto y una cantidad válida.");
      const note =
        el("moveNote").value.trim() ||
        (kind === "purchase" ? "Mercancía recibida" : "");
      if (!note) throw Error("Escribe el motivo del movimiento.");
      const choice = clock.choice(),
        qty = kind === "waste" ? -raw : raw;
      const signature = JSON.stringify({ product, qty, kind, note, choice });
      if (pendingMovement?.signature !== signature) {
        const time = inventoryTimestamp(choice);
        pendingMovement = {
          signature,
          payload: {
            p_product: product,
            p_at: time.at,
            p_on: time.on,
            p_qty: qty,
            p_kind: kind,
            p_note: note,
            p_client_ref: crypto.randomUUID(),
          },
        };
      }
      saving = true;
      el("movementFields").disabled = true;
      const { data, error } = await client.rpc(
        "record_inventory_movement_dated",
        pendingMovement.payload,
      );
      if (error) throw error;
      if (!data)
        throw Error(
          "No se confirmó el registro. Reintenta con los mismos datos.",
        );
      pendingMovement = null;
      el("inventoryMovementPanel").hidden = true;
      el("formMovement").reset();
      clock.reset();
      message("Movimiento guardado con autor e historial.");
      await refresh();
    } catch (error) {
      message(error.message, true);
    } finally {
      saving = false;
      el("movementFields").disabled = false;
    }
  }
  el("inventoryProducts").addEventListener("click", (event) => {
    const b = event.target.closest("[data-inventory-product]");
    if (!b) return;
    selected = b.dataset.inventoryProduct;
    renderList();
    renderDetail();
    el("inventoryDetailClose").focus();
  });
  el("inventoryDetailClose").addEventListener("click", closeDetail);
  el("inventoryProductSearch").addEventListener("input", renderList);
  el("inventoryFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-stock-filter]");
    if (!button) return;
    filter = button.dataset.stockFilter;
    if (selected) closeDetail();
    else renderList();
  });
  el("inventoryInactive").addEventListener("change", renderList);
  el("inventoryPlan").addEventListener("change", render);
  el("inventoryPrepare").addEventListener("click", () =>
    onPurchase(selectedPlan?.id),
  );
  el("inventoryReceipt").addEventListener("click", () => openMovement());
  el("inventoryReceiptProduct").addEventListener("click", () =>
    openMovement("purchase", selected),
  );
  el("inventoryWaste").addEventListener("click", () => openMovement("waste"));
  el("inventoryAdjustment").addEventListener("click", () =>
    openMovement("adjustment"),
  );
  el("inventoryMovementClose").addEventListener("click", () => {
    if (!saving) {
      el("inventoryMovementPanel").hidden = true;
      el("inventoryReceipt").focus();
    }
  });
  el("moveKind").addEventListener("change", movementKind);
  el("formMovement").addEventListener("submit", saveMovement);
  el("inventoryAuditWrap").addEventListener("toggle", async () => {
    if (!el("inventoryAuditWrap").open || !selected || !context().admin) return;
    const id = selected,
      sequence = ++auditSequence;
    el("inventoryAudit").textContent = "Cargando historial…";
    try {
      const logs = await selectAll(
        client,
        "audit_log",
        "id,actor,occurred_at,operation,before_data,after_data",
        (q) =>
          q
            .in("table_name", ["inventory_counts", "inventory_movements"])
            .or(
              `after_data->>product_id.eq.${id},before_data->>product_id.eq.${id}`,
            ),
      );
      const actors = await selectAll(client, "profiles", "id,full_name");
      if (sequence !== auditSequence) return;
      const name = new Map(actors.map((a) => [a.id, a.full_name]));
      const value = (data) =>
        data
          ? `${data.physical_count != null ? "Conteo " + number(data.physical_count) : H(kindLabel[data.kind] || data.kind) + " " + number(data.qty)} · ${H(dateLabel(data.counted_at || data.occurred_at, data.counted_on || data.occurred_on))}${data.note ? " · " + H(data.note) : ""}`
          : "Sin registro anterior";
      el("inventoryAudit").innerHTML =
        logs
          .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
          .map(
            (x) =>
              `<li><b>${H(name.get(x.actor) || "Autor no disponible")} · ${H(dateLabel(x.occurred_at))}</b><p>Antes: ${value(x.before_data)}</p><p>Después: ${value(x.after_data)}</p></li>`,
          )
          .join("") ||
        "<li>No hay cambios registrados en la bitácora de este producto.</li>";
    } catch (error) {
      if (sequence === auditSequence)
        el("inventoryAudit").textContent =
          "No se pudo cargar el historial: " + error.message;
    }
  });
  return { render, openMovement };
}
