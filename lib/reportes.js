import { initJourneys } from "./journeys.js";
import { initInventoryView } from "./inventory-view.js";
import { parkingRows } from "./parking.js";
import { supabase } from "./supabase-client.js";
import { requireRole, signOut } from "./auth.js";
import { escapeHTML as H, selectAll, associateLabels } from "./safe.js";
import {
  monetaryBreakdown,
  inventoryAt,
  itemProductKey,
} from "./accounting.js";
import { predictPurchase, evaluatePlans } from "./prediction.js";
import { initPlanner, readPlannerAnswers } from "./planner.js";
import { showSection } from "./navigation.js";
import {
  renderPurchase,
  renderPurchaseRows,
  reviewedPurchase,
} from "./purchase-review.js";
import { groupLabel } from "./event-groups.js";
import { initCorrections } from "./corrections.js";
import { checkSchema } from "./importer.js";
import { parseBusinessDate, businessDate } from "./csv.js";
associateLabels();
let ALL_MOVEMENTS = [],
  PRED_MOVEMENTS = [],
  LOAD_SEQUENCE = 0;
let inventoryUI = null;
function businessHour(ts) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Mexico_City",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ts)),
  );
}
function businessMinutes(ts) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  return (
    Number(parts.find((p) => p.type === "hour").value) * 60 +
    Number(parts.find((p) => p.type === "minute").value)
  );
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  e.preventDefault();
  try {
    const action = b.dataset.action,
      id = b.dataset.id;
    if (action === "logout") return signOut();
    if (action === "print") return window.print();
    if (action === "tab") return showPane(b.dataset.tabTarget);
    if (action === "resumePlan") return resumePlan(id);
    if (action === "correctDay") return correctionUI.open(id);
    if (action === "dayHistory") {
      correctionUI.render(id);
      document.getElementById("correctionHistory").closest("details").open =
        true;
      document
        .getElementById("correctionHistory")
        .scrollIntoView({ behavior: "smooth" });
      return;
    }

    if (action === "saveProduct") return await window.__saveProduct(id, b);
    if (action === "saveUser") return await window.__saveUser(id, b);
    if (action === "reviewDay") {
      b.disabled = true;
      const { error } = await supabase.rpc("set_day_reviewed", {
        p_day: id,
        p_reviewed: b.dataset.reviewed !== "true",
      });
      if (error) throw error;
      await loadAll();
    }
  } catch (error) {
    gmsg("err", error.message);
  } finally {
    b.disabled = false;
  }
});

window.doLogout = signOut;

const money = (n) =>
  "$" + Number(n || 0).toLocaleString("es-MX", { maximumFractionDigits: 0 });
const moneyD = (n) =>
  "$" +
  Number(n || 0).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const gmsg = (t, h) =>
  (document.getElementById("globalMsg").innerHTML =
    `<div class="msg ${t}">${H(h)}</div>`);

let ME = null;
let CORRECTIONS = [],
  DECISIONS = [],
  PURCHASE_PLANS = [],
  LAST_PREDICTION = null;
let plannerUI = null;
let journeysUI = null;
let correctionUI = null,
  planSignature = "",
  planClientRef = "";
let RANGE = { from: null, to: null };
let PRODUCTS = [];
// datos completos del rango de fechas (sin filtrar por segmento)
let ALL_DAYS = [],
  ALL_TICKETS = [],
  ALL_ITEMS = [],
  ALL_GAMES = [],
  ALL_INV = [];
// vista actual después de aplicar los filtros de segmento (lo que usan los render*)
let DAYS = [],
  TICKETS = [],
  ITEMS = [],
  GAMES = [],
  INV_COUNTS = [];
// modo comparativo de eventos (pestaña Comparativa)
let EVENTS_MAP = new Map();
let SELECTED_EVENTS = new Set();
let PRED_DAYS = [],
  PRED_TICKETS = [],
  PRED_ITEMS = [],
  PRED_GAMES = [],
  PRED_INV = [];
let SCHEDULED_GAMES = [];
let SCHEDULE_READY = false;
const EVENT_TAG_LABELS = {
  futbol: "Fútbol",
  beisbol: "Béisbol / Softbol",
  club_puebla: "Club Puebla",
  otro: "Otro",
};

function checkedEventTags(root = document) {
  return [...root.querySelectorAll(".fEventTag:checked")].map(
    (input) => input.value,
  );
}

function eventTagEditor(values = []) {
  const selected = new Set(values || []);
  return `<div class="check-group compact">${Object.entries(EVENT_TAG_LABELS)
    .map(
      ([value, label]) =>
        `<label class="check-option"><input type="checkbox" class="edEventTag" value="${H(value)}" ${selected.has(value) ? "checked" : ""}> ${H(label)}</label>`,
    )
    .join("")}</div>`;
}

function eventTagLabels(values = []) {
  return (values || []).map((value) => EVENT_TAG_LABELS[value] || value);
}

function showPane(name) {
  const selected = showSection(document, name, IS_ADMIN);
  if (window.location.hash !== "#" + selected)
    history.replaceState(null, "", "#" + selected);
}
for (const id of ["tabbar", "registerNav", "dashboardModes"])
  document.getElementById(id).addEventListener("click", (e) => {
    const button = e.target.closest("[data-tab], [data-view]");
    if (button) showPane(button.dataset.tab || button.dataset.view);
  });
window.addEventListener("hashchange", () =>
  showPane(window.location.hash.slice(1)),
);

let IS_ADMIN = false;

async function init() {
  ME = await requireRole(["operador", "admin"]);
  if (!ME) return;
  IS_ADMIN = ME.role === "admin";
  await checkSchema(supabase);
  inventoryUI = initInventoryView({
    client: supabase,
    context: () => ({
      products: PRODUCTS,
      history: predictionHistory(),
      plans: PURCHASE_PLANS,
      admin: IS_ADMIN,
      me: ME,
    }),
    refresh: loadAll,
    onPurchase: (id) => (id ? resumePlan(id) : showPane("planificador")),
  });
  for (const id of ["inventoryHistoryFrom", "inventoryHistoryTo"])
    document.getElementById(id).addEventListener("change", renderInventario);
  plannerUI = initPlanner({
    getSchedule: () => SCHEDULED_GAMES,
    onCalculate: () => {
      if (!SCHEDULE_READY)
        throw Error(
          "Actualiza Jornadas para cargar el calendario antes de calcular.",
        );
      renderPrediction();
      return !!LAST_PREDICTION;
    },
    onInvalidate: () => {
      LAST_PREDICTION = null;
      document.getElementById("btnSavePlan").disabled = true;
      document.getElementById("planReviewed").checked = false;
    },
  });
  journeysUI = initJourneys({
    client: supabase,
    admin: IS_ADMIN,
    onChange: (rows) => {
      SCHEDULED_GAMES = rows;
      SCHEDULE_READY = true;
      plannerUI.checkSchedule();
    },
    onPurchase: (date) => {
      showPane("planificador");
      plannerUI.openDate(date);
    },
  });
  correctionUI = initCorrections({
    client: supabase,
    context: () => ({
      me: ME,
      admin: IS_ADMIN,
      days: PRED_DAYS,
      requests: CORRECTIONS,
      decisions: DECISIONS,
    }),
    refresh: loadAll,
    message: gmsg,
  });
  document
    .getElementById("btnSavePlan")
    .addEventListener("click", savePurchasePlan);
  document.getElementById("planManual").addEventListener("change", () => {
    document.getElementById("planReviewed").checked = false;
    document.getElementById("planManualFields").hidden =
      !document.getElementById("planManual").checked;
    if (LAST_PREDICTION) {
      if (!document.getElementById("planManual").checked) {
        LAST_PREDICTION.rows = LAST_PREDICTION.rows.filter(
          (r) => !r.manualOnly,
        );
        LAST_PREDICTION.rows.forEach((r) => delete r.chosen);
      }
      renderPurchaseRows(LAST_PREDICTION, PRODUCTS);
    }
  });
  document.getElementById("tblPrediction").addEventListener("input", (e) => {
    if (e.target.matches(".planChosen") && LAST_PREDICTION) {
      document.getElementById("planReviewed").checked = false;
      LAST_PREDICTION.rows[Number(e.target.dataset.index)].chosen =
        e.target.value === "" ? null : Number(e.target.value);
      if (e.target.value === "")
        document.getElementById("btnSavePlan").textContent = "Guardar borrador";
    }
  });
  document
    .getElementById("btnAddPlanProduct")
    .addEventListener("click", addPlanProduct);
  document
    .getElementById("btnAllCorrections")
    .addEventListener("click", () => correctionUI.render());
  document.getElementById("whoName").textContent = ME.full_name || ME.email;
  const pill = document.getElementById("rolePill");
  pill.textContent = IS_ADMIN ? "ADMIN" : "OPERADOR";
  pill.classList.toggle("admin", IS_ADMIN);

  if (!IS_ADMIN) {
    document
      .querySelectorAll(".admin-only")
      .forEach((el) => (el.style.display = "none"));
    const { data: settings } = await supabase
      .from("app_settings")
      .select("operators_see_all_days")
      .single();
    if (settings && !settings.operators_see_all_days) {
      const note = document.getElementById("reportScopeNote");
      note.hidden = false;
      note.textContent =
        'Ves todo (días, partidos, tickets, dinero y utilidad) de los últimos 31 días, y de cualquier día marcado como "evento especial" aunque sea más viejo. Fuera de eso no ves nada de ese día. Si necesitas ver más historial, pídele a un administrador que active "Los operadores ven el historial completo" en Usuarios.';
    }
  } else {
    const hint = document.getElementById("sinCostoHint");
    if (hint)
      hint.textContent =
        "Los costos deben venir del recibo original. Cambiar el catálogo no modifica ventas anteriores. Reimporta el CSV por artículo para completar históricos.";
  }

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);
  document.getElementById("fTo").value = businessDate(today);
  document.getElementById("fFrom").value = businessDate(from);

  document.getElementById("btnFilter").addEventListener("click", loadAll);
  document
    .getElementById("btnCompareEvents")
    .addEventListener("click", compareSelectedEvents);
  if (IS_ADMIN)
    document
      .getElementById("formNewProduct")
      .addEventListener("submit", addProduct);
  ["fTipoDia", "fTipoPartido", "fDeporte", "fCategoria", "fEvento"].forEach(
    (id) =>
      document.getElementById(id).addEventListener("change", applyFilters),
  );
  document
    .querySelectorAll(".fEventTag")
    .forEach((input) => input.addEventListener("change", applyFilters));
  document.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const [dia, partido, deporte, categoria] = btn.dataset.preset.split(",");
      document.getElementById("fTipoDia").value = dia;
      document.getElementById("fTipoPartido").value = partido;
      document.getElementById("fDeporte").value = deporte;
      document.getElementById("fCategoria").value = categoria;
      document.getElementById("fEvento").value = "todos";
      document.querySelectorAll(".fEventTag").forEach((input) => {
        input.checked = false;
      });
      applyFilters();
    }),
  );

  showPane(window.location.hash.slice(1) || "inicio");
  await journeysUI.load();
  await loadAll();
  if (IS_ADMIN) {
    await Promise.all([loadCatalogFull(), loadUsers()]);
  }
}

// Supabase/PostgREST corta cada consulta a 1000 filas por default.
// Esto pagina con .range() hasta traer todo, sin importar cuantas filas haya.
async function selectAllIn(table, columns, inColumn, inValues) {
  const out = [];
  // Fetch bounded batches concurrently, retaining full pagination and order.
  for (let i = 0; i < inValues.length; i += 320) {
    const pending = [];
    for (let j = i; j < Math.min(i + 320, inValues.length); j += 80)
      pending.push(
        selectAll(supabase, table, columns, (q) =>
          q.in(inColumn, inValues.slice(j, j + 80)),
        ),
      );
    out.push(...(await Promise.all(pending)).flat());
  }
  return out;
}
async function fetchDataset(from, to) {
  const days = await selectAll(
    supabase,
    "sale_days",
    "id,date,sport,status,day_type,event_name,event_tags,event_groups,notes,created_by,profiles(full_name)",
    (q) => (from ? q.gte("date", from).lte("date", to) : q),
  );
  const dayIds = days.map((d) => d.id);
  const tickets = await selectAllIn(
    "tickets_view",
    "id,sale_day_id,ts,amount,payment_type,receipt_type",
    "sale_day_id",
    dayIds,
  );
  const [items, games, counts, movements] = await Promise.all([
    selectAllIn(
      "ticket_items_view",
      "id,ticket_id,product_id,product_name_raw,qty,unit_price,unit_cost,line_net_amount,line_cost_amount",
      "ticket_id",
      tickets.map((t) => t.id),
    ),
    selectAllIn(
      "games",
      "id,sale_day_id,start_time,cars_parked,cars_charged,parking_rate,charges_parking,notes",
      "sale_day_id",
      dayIds,
    ),
    selectAllIn("inventory_counts", "*", "sale_day_id", dayIds),
    selectAll(supabase, "inventory_movements", "*"),
  ]);
  const independent = await selectAll(supabase, "inventory_counts", "*", (q) =>
    q.is("sale_day_id", null),
  );
  return {
    days,
    tickets,
    items,
    games,
    counts: [...counts, ...independent],
    movements,
  };
}
async function loadAll() {
  document.getElementById("journeyOverview").hidden = true;
  const sequence = ++LOAD_SEQUENCE;
  const from = document.getElementById("fFrom").value,
    to = document.getElementById("fTo").value;
  document
    .querySelectorAll(".pane")
    .forEach((p) => (p.hidden = p.id !== "pane-jornadas"));
  if (!from || !to || from > to) {
    gmsg("err", "Elige un rango de fechas válido.");
    return;
  }
  gmsg(
    "ok",
    "Puedes usar Jornadas mientras se carga el historial para compras, inventario y reportes...",
  );
  try {
    const [history, products, requests, decisions, plans] = await Promise.all([
      fetchDataset(),
      selectAll(
        supabase,
        "products_view",
        "id,name,category,cost_price,sell_price,active,external_ref,perishable,storage_limit,perishable_limit",
      ),
      selectAll(supabase, "day_corrections"),
      selectAll(supabase, "correction_decisions"),
      selectAll(supabase, "purchase_plans"),
    ]);
    if (sequence !== LOAD_SEQUENCE) return;
    const ids = new Set(
      history.days
        .filter((d) => d.date >= from && d.date <= to)
        .map((d) => d.id),
    );
    const tickets = history.tickets.filter((t) => ids.has(t.sale_day_id)),
      ticketIds = new Set(tickets.map((t) => t.id));
    const dataset = {
      days: history.days.filter((d) => ids.has(d.id)),
      tickets,
      items: history.items.filter((i) => ticketIds.has(i.ticket_id)),
      games: history.games.filter((g) => ids.has(g.sale_day_id)),
      counts: history.counts.filter(
        (c) =>
          ids.has(c.sale_day_id) ||
          (!c.sale_day_id &&
            c.counted_at &&
            businessDate(new Date(c.counted_at)) >= from &&
            businessDate(new Date(c.counted_at)) <= to),
      ),
      movements: history.movements,
    };
    PRED_DAYS = history.days;
    PRED_TICKETS = history.tickets;
    PRED_ITEMS = history.items;
    PRED_GAMES = history.games;
    PRED_INV = history.counts;
    PRED_MOVEMENTS = history.movements;
    RANGE = { from, to };
    PRODUCTS = products;
    CORRECTIONS = requests;
    DECISIONS = decisions;
    PURCHASE_PLANS = plans;
    ALL_DAYS = dataset.days;
    ALL_TICKETS = dataset.tickets;
    ALL_ITEMS = dataset.items;
    ALL_GAMES = dataset.games;
    ALL_INV = dataset.counts;
    ALL_MOVEMENTS = dataset.movements;
    if (sequence !== LOAD_SEQUENCE) return;
    refreshEventoOptions();
    applyFilters();
    renderComparativa();
    renderPrediction();
    correctionUI?.render();
    document.querySelectorAll(".pane").forEach((p) => (p.hidden = false));
  } catch (error) {
    if (sequence === LOAD_SEQUENCE)
      gmsg(
        "err",
        "Reporte no disponible: " +
          error.message +
          " Vuelve a aplicar el rango para reintentar.",
      );
  }
}

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

// clave para agrupar un dia como "evento": su nombre si tiene, si no su fecha sola
function eventKeyOf(d) {
  return d.event_name || "__dia__" + d.date;
}
function eventLabelOf(d) {
  return d.event_name || d.date;
}

function refreshEventoOptions() {
  const sel = document.getElementById("fEvento");
  const current = sel.value;
  const relevant = ALL_DAYS.filter(
    (d) => d.day_type === "evento_especial" || d.day_type === "dia_partido",
  );
  const seen = new Map(); // key -> label
  relevant.forEach((d) => {
    if (!seen.has(eventKeyOf(d))) seen.set(eventKeyOf(d), eventLabelOf(d));
  });
  const entries = [...seen.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  sel.innerHTML =
    '<option value="todos">Todos</option>' +
    entries
      .map(([key, label]) => `<option value="${H(key)}">${H(label)}</option>`)
      .join("");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function applyFilters() {
  const tipoDia = document.getElementById("fTipoDia").value;
  const tipoPartido = document.getElementById("fTipoPartido").value;
  const deporte = document.getElementById("fDeporte").value;
  const categoria = document.getElementById("fCategoria").value;
  const evento = document.getElementById("fEvento").value;
  const eventTags = checkedEventTags();

  const gamesByDay = new Map();
  ALL_GAMES.forEach((g) => {
    if (!gamesByDay.has(g.sale_day_id)) gamesByDay.set(g.sale_day_id, []);
    gamesByDay.get(g.sale_day_id).push(g);
  });

  DAYS = ALL_DAYS.filter((d) => {
    if (tipoDia === "semana" && isWeekend(d.date)) return false;
    if (tipoDia === "finde" && !isWeekend(d.date)) return false;
    const hasGames = (gamesByDay.get(d.id) || []).length > 0;
    if (tipoPartido === "con" && !hasGames) return false;
    if (tipoPartido === "sin" && hasGames) return false;
    if (deporte !== "todos" && d.sport !== deporte) return false;
    if (categoria !== "todos" && d.day_type !== categoria) return false;
    if (evento !== "todos" && eventKeyOf(d) !== evento) return false;
    if (
      eventTags.length &&
      !eventTags.some((tag) => (d.event_tags || []).includes(tag))
    )
      return false;
    return true;
  });

  const dayIdSet = new Set(DAYS.map((d) => d.id));
  TICKETS = ALL_TICKETS.filter((t) => dayIdSet.has(t.sale_day_id));
  const ticketIdSet = new Set(TICKETS.map((t) => t.id));
  ITEMS = ALL_ITEMS.filter((it) => ticketIdSet.has(it.ticket_id));
  GAMES = ALL_GAMES.filter((g) => dayIdSet.has(g.sale_day_id));
  INV_COUNTS = ALL_INV.filter(
    (c) => !c.sale_day_id || dayIdSet.has(c.sale_day_id),
  );

  const totalMsg =
    ALL_DAYS.length === DAYS.length
      ? `${DAYS.length} día(s), ${TICKETS.length} tickets cargados.`
      : `${DAYS.length} de ${ALL_DAYS.length} día(s) del rango coinciden con el filtro — ${TICKETS.length} tickets.`;
  document.getElementById("reportDataStatus").textContent = DAYS.length
    ? totalMsg
    : "Ningún día del rango coincide con ese filtro.";
  document.getElementById("globalMsg").textContent = "";
  renderAll();
}

function renderAll() {
  renderResumen();
  renderHome();
  renderProductos();
  renderCalor();
  renderCombos();
  renderInventario();
  renderEstacionamiento();
  renderDaysTable();
  renderDiaPorDia();
}

function productUnits(items = ITEMS) {
  const prodById = new Map(PRODUCTS.map((p) => [p.id, p]));
  const agg = new Map();
  items.forEach((it) => {
    if (!it.product_id) return;
    const current = agg.get(it.product_id) || {
      id: it.product_id,
      name: prodById.get(it.product_id)?.name || it.product_name_raw,
      qty: 0,
    };
    current.qty += Number(it.qty) || 0;
    agg.set(it.product_id, current);
  });
  return [...agg.values()].sort((a, b) => b.qty - a.qty);
}

function currentInventoryByProduct() {
  return inventoryAt({
    days: PRED_DAYS,
    tickets: PRED_TICKETS,
    items: PRED_ITEMS,
    counts: PRED_INV,
    movements: PRED_MOVEMENTS,
  });
}

function renderHome() {
  document.getElementById("journeyOverview").hidden = false;
  const today = businessDate();
  const from = parseBusinessDate(today + "T12:00");
  from.setUTCDate(from.getUTCDate() - 6);
  const since = businessDate(from);
  const dayIds = new Set(
    PRED_DAYS.filter((d) => d.date >= since && d.date <= today).map(
      (d) => d.id,
    ),
  );
  const receipts = PRED_TICKETS.filter((t) => dayIds.has(t.sale_day_id));
  const ticketIds = new Set(receipts.map((t) => t.id));
  const lines = PRED_ITEMS.filter((l) => ticketIds.has(l.ticket_id));
  const byProduct = new Map();
  for (const l of lines)
    byProduct.set(
      l.product_id,
      (byProduct.get(l.product_id) || 0) + Number(l.qty),
    );
  const top = [...byProduct].sort((a, b) => b[1] - a[1])[0];
  document.getElementById("homePeriod").textContent =
    "Últimos 7 días · " + since + " al " + today;
  document.getElementById("homeKpis").innerHTML = [
    [
      "Ventas registradas",
      money(receipts.reduce((n, t) => n + Number(t.amount), 0)),
    ],
    ["Tickets", receipts.length],
    [
      "Producto más vendido",
      top
        ? PRODUCTS.find((p) => p.id === top[0])?.name || "Producto"
        : "Sin ventas registradas",
    ],
  ]
    .map(
      ([label, value]) =>
        '<div class="kpi"><b>' +
        H(value) +
        "</b><span>" +
        H(label) +
        "</span></div>",
    )
    .join("");
  const stock = inventoryAt(predictionHistory(), new Date().toISOString());
  const activeProducts = PRODUCTS.filter((p) => p.active !== false);
  const missing = activeProducts.filter((p) => !stock.has(p.id)).length;
  const negative = activeProducts.filter(
    (p) => stock.get(p.id)?.inconsistent,
  ).length;
  const unclassified = PRED_DAYS.filter((d) => !d.event_groups?.length).length;
  const pending = CORRECTIONS.filter(
    (c) =>
      !c.applied_immediately &&
      !DECISIONS.some((d) => d.correction_id === c.id),
  ).length;
  document.getElementById("homeAttentionLabel").textContent =
    `Inventario: ${negative} saldos a revisar · ${missing} sin conteo · ${pending} correcciones`;
  document.getElementById("homePending").innerHTML =
    '<ul class="action-list">' +
    [
      [negative, "productos con saldo negativo por revisar", "inventario"],
      [missing, "productos sin conteo de partida", "inventario"],
      [pending, "correcciones por revisar", "registro"],
      [unclassified, "días sin actividades detalladas", "registro"],
    ]
      .map(
        ([n, label, to]) =>
          '<li><button class="btn-ghost" data-action="tab" data-tab-target="' +
          to +
          '">' +
          n +
          " " +
          label +
          "</button></li>",
      )
      .join("") +
    "</ul>";
  const next = [...PURCHASE_PLANS]
    .filter((p) => p.event_date >= today)
    .sort(
      (a, b) =>
        a.event_date.localeCompare(b.event_date) ||
        b.created_at.localeCompare(a.created_at),
    )[0];
  document.getElementById("homeNext").innerHTML = next
    ? "<p>" +
      H(next.event_date) +
      " · " +
      (next.summary?.draft ? "Borrador pendiente" : "Lista guardada") +
      '</p><button class="btn sec" data-action="resumePlan" data-id="' +
      H(next.id) +
      '">Revisar esta compra</button>'
    : '<p>Todavía no hay una compra preparada para los próximos días.</p><button class="btn sec" data-action="tab" data-tab-target="planificador">Preparar compra</button>';
}

function renderDiaPorDia() {
  const tbl = document.getElementById("tblDiaPorDia");
  if (!tbl) return;
  const sorted = [...DAYS].sort((a, b) => a.date.localeCompare(b.date));
  tbl.querySelector("tbody").innerHTML =
    sorted
      .map((d, i) => {
        const s = statsForDays([d.id]);
        return `<tr><td class="num">${i + 1}</td><td>${d.date}</td><td class="num">${s.tickets}</td>
      <td class="num">${money(s.venta)}</td>
      <td class="num">${s.utilidad != null ? moneyD(s.utilidad) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="6">Sin días en el filtro actual.</td></tr>';
}

function renderResumen() {
  const venta = TICKETS.reduce((s, t) => s + Number(t.amount), 0);
  const n = TICKETS.length;
  const moneyData = monetaryBreakdown(TICKETS, ITEMS);
  const { costoTotal, ventaConCosto, ventaSinCosto } = moneyData;
  const utilidad = ventaConCosto - costoTotal;
  const margen = ventaConCosto ? (utilidad / ventaConCosto) * 100 : null;
  const uds = ITEMS.reduce((s, it) => s + it.qty, 0);

  const montos = TICKETS.map((t) => Number(t.amount)).sort((a, b) => a - b);
  const mediana = montos.length
    ? montos.length % 2
      ? montos[(montos.length - 1) / 2]
      : (montos[montos.length / 2 - 1] + montos[montos.length / 2]) / 2
    : null;
  const skusPorTicket = new Map();
  ITEMS.forEach((it) => {
    skusPorTicket.set(it.ticket_id, (skusPorTicket.get(it.ticket_id) || 0) + 1);
  });
  const monoTickets = TICKETS.filter(
    (t) => (skusPorTicket.get(t.id) || 0) <= 1,
  ).length;
  const kpis = [
    ["Venta total", money(venta)],
    ["Venta con costo", moneyD(ventaConCosto)],
    ["Venta sin costo", moneyD(ventaSinCosto)],
    ["Utilidad (costo conocido)", margen != null ? moneyD(utilidad) : "—"],
    ["Margen", margen != null ? margen.toFixed(1) + "%" : "—"],
    ["Tickets", n],
    ["Ticket promedio", n ? moneyD(venta / n) : "—"],
    ["Ticket mediano", mediana != null ? moneyD(mediana) : "—"],
    ["Unidades / ticket", n ? (uds / n).toFixed(2) : "—"],
    [
      "Tickets de 1 producto",
      n ? Math.round((monoTickets / n) * 100) + "%" : "—",
    ],
    ["Días capturados", DAYS.length],
  ];
  document.getElementById("kpis").innerHTML = kpis
    .map(([l, v]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`)
    .join("");

  const noteEl = document.getElementById("sinCostoNote");
  if (noteEl) {
    noteEl.innerHTML =
      Math.abs(ventaSinCosto) > 0.01 || moneyData.unallocatedTickets > 0
        ? `<div class="msg warn">La utilidad es parcial: solo usa importes y costos históricos documentados. ${moneyData.unallocatedTickets} recibo(s) no tienen detalle monetario conciliado; reimporta el CSV por artículo. Detalle producto por producto en la pestaña <a href="#" data-action="tab" data-tab-target="productos">Productos → Productos sin costo registrado</a>.</div>`
        : "";
  }

  const gameHours = new Set();
  GAMES.forEach((g) => {
    const h = parseInt(g.start_time.split(":")[0]);
    if (!isNaN(h)) gameHours.add(h);
  });

  const byHour = new Array(24).fill(0);
  TICKETS.forEach((t) => {
    byHour[businessHour(t.ts)] += Number(t.amount);
  });
  const used = byHour.map((v, h) => ({ h, v })).filter((x) => x.v > 0);
  const max = Math.max(1, ...used.map((x) => x.v));
  document.getElementById("barchart").innerHTML =
    used
      .map(
        (x) => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative">
      ${gameHours.has(x.h) ? `<div style="position:absolute;top:-20px;font-size:13px" title="Arranca un partido">⚽</div>` : ""}
      <div class="mono" style="font-size:10px;color:var(--ink-2);margin-bottom:4px">${money(x.v)}</div>
      <div style="width:100%;max-width:34px;border-radius:4px 4px 2px 2px;background:var(--brand);height:${Math.round((x.v / max) * 100)}%" title="${x.h}:00"></div>
      <div class="mono" style="font-size:10.5px;color:var(--muted);margin-top:6px">${x.h}h</div>
    </div>`,
      )
      .join("") || '<p class="footnote">Sin ventas en el periodo.</p>';
}

function renderProductos() {
  const prodById = new Map(PRODUCTS.map((p) => [p.id, p]));
  const moneyData = monetaryBreakdown(TICKETS, ITEMS);
  const agg = new Map();
  ITEMS.forEach((it) => {
    const key = it.product_id || "__raw__" + it.product_name_raw;
    if (!agg.has(key))
      agg.set(key, {
        key,
        uds: 0,
        tks: new Set(),
        name: it.product_id
          ? prodById.get(it.product_id)?.name || "?"
          : it.product_name_raw + " (sin catálogo)",
        product_id: it.product_id,
      });
    const a = agg.get(key);
    a.uds += it.qty;
    a.tks.add(it.ticket_id);
  });
  const rows = [...agg.values()]
    .map((a) => {
      const p = a.product_id ? prodById.get(a.product_id) : null;
      const venta = moneyData.productSales.has(a.key)
        ? moneyData.productSales.get(a.key)
        : null;
      const costo =
        !moneyData.unknownCostProducts.has(a.key) &&
        moneyData.productCosts.has(a.key)
          ? moneyData.productCosts.get(a.key)
          : null;
      const util = costo != null && venta != null ? venta - costo : null;
      const margen = util != null && venta ? (util / venta) * 100 : null;
      return {
        name: a.name,
        uds: a.uds,
        tks: a.tks.size,
        venta,
        costo,
        util,
        margen,
        category: p ? p.category || "Otro" : "Sin catálogo",
      };
    })
    .sort((x, y) => y.uds - x.uds);

  const topUtilidad = [...rows]
    .filter((r) => r.util != null)
    .sort((x, y) => y.util - x.util)
    .slice(0, 10);
  document.getElementById("tblTopUtilidad").innerHTML =
    `<thead><tr><th>Producto</th><th class="num">Uds.</th><th class="num">Margen</th><th class="num">Utilidad</th></tr></thead><tbody>${
      topUtilidad
        .map(
          (r) =>
            `<tr><td>${H(r.name)}</td><td class="num">${r.uds}</td><td class="num">${r.margen != null ? r.margen.toFixed(0) + "%" : "—"}</td><td class="num pos">${moneyD(r.util)}</td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="4">Sin datos con costo conocido.</td></tr>'
    }</tbody>`;

  const porDemanda = [...rows].sort((x, y) => y.uds - x.uds);
  const masSolicitados = porDemanda.slice(0, 5);
  const menosSolicitados = [...porDemanda].reverse().slice(0, 5);
  document.getElementById("tblExtremos").innerHTML =
    `<thead><tr><th colspan="2">Más solicitados</th></tr></thead><tbody>` +
    masSolicitados
      .map(
        (r, i) =>
          `<tr><td class="num mono" style="text-align:left;color:var(--muted)">${i + 1}</td><td style="text-align:left">${H(r.name)} (${r.uds})</td></tr>`,
      )
      .join("") +
    `</tbody><thead><tr><th colspan="2" style="padding-top:14px">Menos solicitados</th></tr></thead><tbody>` +
    menosSolicitados
      .map(
        (r, i) =>
          `<tr><td class="num mono" style="text-align:left;color:var(--muted)">${i + 1}</td><td style="text-align:left">${H(r.name)} (${r.uds})</td></tr>`,
      )
      .join("") +
    `</tbody>`;

  document.querySelector("#tblProdRank tbody").innerHTML =
    rows
      .map(
        (r) => `
    <tr><td>${H(r.name)}</td><td class="num">${r.uds}</td><td class="num">${r.tks}</td>
      <td class="num">${r.venta != null ? money(r.venta) : "—"}</td>
      <td class="num">${r.costo != null ? money(r.costo) : "—"}</td>
      <td class="num">${r.margen != null ? r.margen.toFixed(1) + "%" : "—"}</td>
      <td class="num ${r.util != null ? "pos" : ""}">${r.util != null ? moneyD(r.util) : "—"}</td></tr>
  `,
      )
      .join("") || '<tr><td colspan="7">Sin datos en el periodo.</td></tr>';

  const sinCosto = rows
    .filter((r) => r.costo == null)
    .sort((x, y) => y.uds - x.uds);
  const ventaSinCosto = sinCosto.reduce((s, r) => s + (r.venta || 0), 0);
  document.getElementById("sinCostoTotal").textContent = sinCosto.length
    ? `${sinCosto.length} producto(s), ${moneyD(ventaSinCosto)} en venta cuantificable (solo se incluyen importes por producto presentes en el recibo original).`
    : "Todos los productos vendidos en el periodo tienen costo registrado.";
  document.querySelector("#tblSinCosto tbody").innerHTML =
    sinCosto
      .map(
        (r) => `
    <tr><td>${H(r.name)}</td><td class="num">${r.uds}</td><td class="num">${r.tks}</td>
      <td class="num">${r.venta != null ? money(r.venta) : "—"}</td></tr>
  `,
      )
      .join("") || '<tr><td colspan="4">Ninguno.</td></tr>';

  const catColors = [
    "var(--brand)",
    "var(--amber)",
    "var(--clay)",
    "var(--blue)",
    "var(--muted)",
  ];
  const cats = new Map();
  rows.forEach((r) => {
    if (!cats.has(r.category)) cats.set(r.category, { venta: 0, uds: 0 });
    const c = cats.get(r.category);
    c.venta += r.venta || 0;
    c.uds += r.uds;
  });
  const catRows = [...cats.entries()].sort((a, b) => b[1].venta - a[1].venta);
  const maxVenta = Math.max(1, ...catRows.map(([, c]) => c.venta));
  document.getElementById("catbars").innerHTML = catRows.length
    ? catRows
        .map(
          ([name, c], i) => `
    <div class="catbar-row">
      <div>${H(name)}</div>
      <div class="catbar-track"><div class="catbar-fill" style="width:${Math.round((c.venta / maxVenta) * 100)}%;background:${catColors[i % catColors.length]}"></div></div>
      <div class="mono" style="text-align:right">${money(c.venta)}</div>
    </div>`,
        )
        .join("")
    : '<p class="footnote">Sin datos en el periodo.</p>';
}

function catOf(productId, prodById) {
  const p = productId ? prodById.get(productId) : null;
  return p ? p.category || "Otro" : null;
}

function renderCalor() {
  const prodById = new Map(PRODUCTS.map((p) => [p.id, p]));
  const hourByTicket = new Map(TICKETS.map((t) => [t.id, businessHour(t.ts)]));

  const totals = new Map(); // productId -> total uds
  const byProdHour = new Map(); // productId -> {hour: uds}
  ITEMS.forEach((it) => {
    if (!it.product_id) return;
    const hour = hourByTicket.get(it.ticket_id);
    if (hour == null) return;
    totals.set(it.product_id, (totals.get(it.product_id) || 0) + it.qty);
    if (!byProdHour.has(it.product_id)) byProdHour.set(it.product_id, {});
    const h = byProdHour.get(it.product_id);
    h[hour] = (h[hour] || 0) + it.qty;
  });

  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id]) => id);
  if (!top.length) {
    document.getElementById("heatmap").innerHTML =
      '<p class="footnote">Sin datos en el periodo.</p>';
    return;
  }

  const hoursUsed = [...new Set(TICKETS.map((t) => businessHour(t.ts)))].sort(
    (a, b) => a - b,
  );
  let max = 0;
  top.forEach((id) =>
    hoursUsed.forEach((h) => {
      const v = (byProdHour.get(id) || {})[h] || 0;
      if (v > max) max = v;
    }),
  );

  let html =
    '<table class="heat"><thead><tr><th class="p">Producto</th>' +
    hoursUsed.map((h) => `<th>${h}h</th>`).join("") +
    "<th>Total</th></tr></thead><tbody>";
  top.forEach((id) => {
    const p = prodById.get(id);
    const row = byProdHour.get(id) || {};
    html +=
      `<tr><td>${H(p ? p.name : "?")}</td>` +
      hoursUsed
        .map((h) => {
          const v = row[h] || 0;
          if (!v) return `<td class="z">·</td>`;
          const alpha = 0.22 + 0.78 * (v / max);
          return `<td style="background:color-mix(in srgb, var(--brand) ${Math.round(alpha * 100)}%, var(--surface-2))" title="${v} uds a las ${h}h">${v}</td>`;
        })
        .join("") +
      `<td style="background:none;color:var(--ink);font-weight:700;text-align:center">${totals.get(id)}</td></tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("heatmap").innerHTML = html;
}

function renderCombos() {
  const prodById = new Map(PRODUCTS.map((p) => [p.id, p]));
  const byTicket = new Map();
  ITEMS.forEach((it) => {
    if (!it.product_id) return;
    if (!byTicket.has(it.ticket_id)) byTicket.set(it.ticket_id, new Set());
    byTicket.get(it.ticket_id).add(it.product_id);
  });
  const baskets = [...byTicket.values()];
  const N = baskets.length;
  const sup = new Map(),
    pairs = new Map();
  baskets.forEach((b) => {
    const arr = [...b];
    arr.forEach((x) => sup.set(x, (sup.get(x) || 0) + 1));
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const [a, c] = [arr[i], arr[j]].sort();
        const k = a + "||" + c;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
  });

  const isAgua = (id) => {
    const p = prodById.get(id);
    return p && /agua|coca/i.test(p.name);
  };

  const rows = [...pairs.entries()]
    .map(([k, c]) => {
      const [a, b] = k.split("||");
      const lift = N ? c / N / ((sup.get(a) / N) * (sup.get(b) / N)) : 0;
      return { a, b, c, lift };
    })
    .sort((x, y) => y.c - x.c || y.lift - x.lift);

  document.querySelector("#tblPares tbody").innerHTML =
    rows
      .slice(0, 15)
      .map((r) => {
        const pa = prodById.get(r.a),
          pb = prodById.get(r.b);
        return `<tr><td style="text-align:left">${H(pa ? pa.name : "?")}</td><td style="text-align:left">${H(pb ? pb.name : "?")}</td>
      <td class="num">${r.c}</td><td class="num pos">${r.lift.toFixed(2)}×</td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="4">No hay suficientes tickets con 2+ productos en el periodo.</td></tr>';

  // combos sugeridos: pares sin agua/coca, con costo conocido en ambos, ordenados por lift*juntos
  const candidatos = rows
    .filter((r) => !isAgua(r.a) && !isAgua(r.b) && r.c >= 2)
    .map((r) => {
      const pa = prodById.get(r.a),
        pb = prodById.get(r.b);
      if (!pa || !pb || pa.cost_price == null || pb.cost_price == null)
        return null;
      const lista = pa.sell_price + pb.sell_price;
      const costo = pa.cost_price + pb.cost_price;
      let precio = Math.round((lista * 0.9) / 5) * 5;
      if (precio >= lista) precio = lista - 5;
      let margen = ((precio - costo) / precio) * 100;
      if (margen < 30 && precio < lista) {
        precio = lista;
        margen = ((precio - costo) / precio) * 100;
      }
      return {
        pa,
        pb,
        juntos: r.c,
        lift: r.lift,
        lista,
        costo,
        precio,
        margen,
      };
    })
    .filter(Boolean)
    .sort((x, y) => y.lift * y.juntos - x.lift * x.juntos)
    .slice(0, 4);

  document.getElementById("comboCards").innerHTML = candidatos.length
    ? candidatos
        .map(
          (c) => `
    <div class="combo">
      <h4>${H(c.pa.name)} + ${H(c.pb.name)} <span class="price">${money(c.precio)}</span></h4>
      <div class="stats"><span>lista ${money(c.lista)}</span><span>margen ${c.margen.toFixed(0)}%</span><span>juntos ${c.juntos}× · lift ${c.lift.toFixed(1)}</span></div>
    </div>`,
        )
        .join("")
    : '<p class="footnote">Todavía no hay suficientes datos para sugerir combos en este periodo.</p>';
}

function renderInventario() {
  const prodById = new Map(PRODUCTS.map((p) => [p.id, p]));
  inventoryUI?.render();
  const dayById = new Map(PRED_DAYS.map((d) => [d.id, d]));
  const fromInput = document.getElementById("inventoryHistoryFrom"),
    toInput = document.getElementById("inventoryHistoryTo");
  if (!fromInput.value) fromInput.value = RANGE.from || "2000-01-01";
  if (!toInput.value) toInput.value = RANGE.to || businessDate();
  const rows = PRED_INV.filter((c) => {
    const date =
      c.counted_on ||
      (c.counted_at
        ? businessDate(new Date(c.counted_at))
        : dayById.get(c.sale_day_id)?.date);
    return (
      c.physical_count != null &&
      date >= fromInput.value &&
      date <= toInput.value
    );
  })
    .map((c) => {
      const p = prodById.get(c.product_id);
      const day = dayById.get(c.sale_day_id);
      const previous = c.counted_at
        ? inventoryAt(
            {
              days: PRED_DAYS,
              tickets: PRED_TICKETS,
              items: PRED_ITEMS,
              counts: PRED_INV.filter((other) => other.id !== c.id),
              movements: PRED_MOVEMENTS,
            },
            new Date(Date.parse(c.counted_at) + 1).toISOString(),
          ).get(c.product_id)
        : null;
      const teorico =
        previous && !previous.uncertain && !previous.inconsistent
          ? previous.value
          : null;
      const dif =
        teorico != null && c.count_source === "manual"
          ? c.physical_count - teorico
          : null;
      const valor =
        dif != null &&
        dif < 0 &&
        p &&
        p.cost_price != null &&
        c.count_source === "manual"
          ? Math.abs(dif) * p.cost_price
          : null;
      return {
        fecha:
          c.counted_on ||
          (day
            ? day.date
            : c.counted_at
              ? businessDate(new Date(c.counted_at))
              : "?"),
        producto: p ? p.name : "?",
        teorico,
        fisico: c.physical_count,
        dif,
        valor,
      };
    })
    .sort((a, b) => (a.dif ?? 0) - (b.dif ?? 0));

  const totalMerma = rows
    .filter((r) => r.valor != null)
    .reduce((s, r) => s + r.valor, 0);
  document.querySelector("#tblMerma tbody").innerHTML =
    rows
      .map(
        (r) => `
    <tr><td>${r.fecha}</td><td>${H(r.producto)}</td><td class="num">${r.teorico ?? "—"}</td><td class="num">${r.fisico}</td>
      <td class="num ${r.dif != null && r.dif < 0 ? "neg" : ""}">${r.dif ?? "—"}</td>
      <td class="num">${r.valor != null ? moneyD(r.valor) : "—"}</td></tr>
  `,
      )
      .join("") ||
    '<tr><td colspan="6">No hay conteos físicos capturados en el periodo.</td></tr>';

  const invMsg = document.getElementById("invMsg");
  if (invMsg) {
    invMsg.innerHTML =
      totalMerma > 0
        ? `<div class="msg warn">Faltante valorizado al costo actual (estimación): <b>${moneyD(totalMerma)}</b> (solo productos con costo conocido y conteo físico capturado).</div>`
        : rows.length
          ? '<div class="msg ' +
            (rows.some((r) => r.dif == null) ? "warn" : "ok") +
            '">' +
            (rows.some((r) => r.dif == null)
              ? "Merma no calculable para todos los productos: faltan conteos físicos o movimientos de referencia."
              : "Sin faltantes en los conteos comparables; verifica que todas las entradas y salidas estén registradas.") +
            "</div>"
          : "";
  }
}

function renderEstacionamiento() {
  const rows = parkingRows(DAYS, GAMES, TICKETS);
  const moneyOrMissing = (value) =>
    value === null ? "Sin datos" : moneyD(value);
  document.querySelector("#tblParking tbody").innerHTML =
    rows
      .map(
        (r) => `
    <tr><td>${H(r.fecha)}<span class="tiny">${H(r.hora)}</span>${r.nota ? `<div class="footnote">${H(r.nota)}</div>` : ""}</td>
      <td class="num">${r.autosLote ?? "—"}</td><td class="num">${r.autosCobrados ?? "—"}</td>
      <td class="num">${r.cobra ? moneyOrMissing(r.tarifa) : "Sin cobro"}</td>
      <td class="num">${moneyOrMissing(r.venta)}</td>
      <td class="num">${moneyOrMissing(r.ventaPorAuto)}</td>
      <td class="num">${moneyOrMissing(r.ingreso)}</td>
      <td class="num"><b>${moneyOrMissing(r.total)}</b></td>
      <td class="num">${moneyOrMissing(r.totalPorAuto)}</td></tr>
  `,
      )
      .join("") ||
    '<tr><td colspan="9">No hay partidos capturados en el periodo.</td></tr>';

  const withCars = rows.filter((r) => r.autosLote > 0 && r.venta !== null);

  // tarjetas: un vistazo rapido por partido
  document.getElementById("parkingCards").innerHTML =
    rows
      .map(
        (r) => `
    <div class="pk-card">
      <div class="t">${H(r.fecha)} · ${H(r.hora)}</div>
      <div class="parking-car-count"><b>${r.autosLote ?? "—"} autos</b><span>${r.autosCobrados ?? "—"} con cobro</span></div>
      <p class="parking-rate">Tarifa por auto <b>${r.cobra ? moneyOrMissing(r.tarifa) : "Sin cobro"}</b></p>
      <dl class="parking-totals"><div><dt>Venta de tienda</dt><dd>${moneyOrMissing(r.venta)}</dd></div><div><dt>+ Estacionamiento</dt><dd>${moneyOrMissing(r.ingreso)}</dd></div><div class="parking-total"><dt>Total combinado</dt><dd>${moneyOrMissing(r.total)}</dd></div></dl>
      <div class="parking-per-car"><b>Promedio por auto en el lote</b><div><span>Tienda</span><strong>${moneyOrMissing(r.ventaPorAuto)}</strong><span>+ Estacionamiento</span><strong>${moneyOrMissing(r.parkingPorAuto)}</strong><span>= Total por auto</span><strong>${moneyOrMissing(r.totalPorAuto)}</strong></div></div>
      ${r.ambiguous ? '<p class="hint">Falta hora, venta o hay partidos simultáneos. No se puede separar la venta de tienda.</p>' : ""}${r.nota ? `<p class="hint">${H(r.nota)}</p>` : ""}
    </div>`,
      )
      .join("") || "";

  // correlacion de Pearson entre autos y venta, cuando hay suficientes partidos
  function pearson(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n,
      my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0,
      dx2 = 0,
      dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx,
        dy = ys[i] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    return dx2 && dy2 ? num / Math.sqrt(dx2 * dy2) : null;
  }

  const insightEl = document.getElementById("parkingInsight");
  if (withCars.length >= 2) {
    const sorted = [...withCars].sort((a, b) => a.autosLote - b.autosLote);
    const smallest = sorted[0],
      biggest = sorted[sorted.length - 1];
    const ratioSmall = smallest.venta / smallest.autosLote,
      ratioBig = biggest.venta / biggest.autosLote;
    let corrLine = "";
    if (withCars.length >= 4) {
      const r = pearson(
        withCars.map((x) => x.autosLote),
        withCars.map((x) => x.venta),
      );
      if (r != null)
        corrLine = ` Correlación (autos vs. venta, ${withCars.length} partidos): <b>${r.toFixed(2)}</b> — ${Math.abs(r) < 0.3 ? "prácticamente nula" : Math.abs(r) < 0.6 ? "moderada" : "fuerte"}${r < 0 ? ", e inversa (a más autos, menos venta relativa)" : ""}.`;
    }
    insightEl.innerHTML = `<div class="msg ${ratioBig < ratioSmall ? "warn" : "ok"}">
      El partido con menos autos (${smallest.autosLote}, ${smallest.fecha}) dejó ${moneyD(ratioSmall)} de venta por auto;
      el de más autos (${biggest.autosLote}, ${biggest.fecha}) dejó ${moneyD(ratioBig)} por auto.
      ${ratioBig < ratioSmall ? "La venta de tienda por auto fue menor en el partido con más autos; estos datos no explican la causa." : "La venta de tienda por auto se mantuvo o mejoró en el partido con más autos."}
      Con ${withCars.length} partido(s) capturado(s) esto es un patrón a observar${withCars.length < 4 ? ", no una conclusión estadística todavía (se necesitan al menos 4-5 partidos para calcular una correlación con algo de sentido)" : ""}.${corrLine}
    </div>`;
  } else {
    insightEl.innerHTML = "";
  }
}

function renderDaysTable() {
  const totals = new Map();
  for (const t of TICKETS) {
    const v = totals.get(t.sale_day_id) || { n: 0, amount: 0 };
    v.n++;
    v.amount += Number(t.amount);
    totals.set(t.sale_day_id, v);
  }
  const category = {
    evento_especial: "Evento especial",
    dia_partido: "Día de partido",
    entrenamiento_normal: "Entrenamiento normal",
  };
  document.querySelector("#tblDaysAdmin tbody").innerHTML =
    DAYS.map((d) => {
      const total = totals.get(d.id) || { n: 0, amount: 0 };
      const changes = CORRECTIONS.filter((r) => r.day_id === d.id);
      const applied = changes.filter(
        (r) =>
          r.applied_immediately ||
          DECISIONS.some((x) => x.correction_id === r.id && x.approved),
      ).length;
      return (
        "<tr><td>" +
        H(d.date) +
        (applied
          ? '<br><span class="chip reviewed">Corregido · ' + applied + "</span>"
          : "") +
        "</td><td>" +
        H(EVENT_TAG_LABELS[d.sport] || d.sport || "—") +
        "</td><td>" +
        H(category[d.day_type] || "Sin clasificar") +
        "</td><td>" +
        H(d.event_name || "—") +
        "</td><td>" +
        H(eventTagLabels(d.event_tags).join(", ") || "—") +
        '</td><td class="num">' +
        total.n +
        '</td><td class="num">' +
        money(total.amount) +
        "</td><td>" +
        H(d.status === "reviewed" ? "Cerrado" : "Abierto") +
        "</td><td>" +
        H(d.profiles?.full_name || "—") +
        '</td><td><button type="button" class="btn sec sm" data-action="correctDay" data-id="' +
        H(d.id) +
        '">Corregir / solicitar</button><button type="button" class="btn sec sm" data-action="dayHistory" data-id="' +
        H(d.id) +
        '">Ver historial (' +
        changes.length +
        ")</button>" +
        (IS_ADMIN
          ? '<button class="btn sec sm" type="button" data-action="reviewDay" data-id="' +
            H(d.id) +
            '" data-reviewed="' +
            (d.status === "reviewed") +
            '">' +
            (d.status === "reviewed" ? "Reabrir" : "Cerrar día") +
            "</button>"
          : "") +
        "</td></tr>"
      );
    }).join("") || '<tr><td colspan="10">Sin días en el periodo.</td></tr>';
}

// ---------------- comparativa ----------------
function statsForDays(dayIds) {
  const set = new Set(dayIds);
  const tks = ALL_TICKETS.filter((t) => set.has(t.sale_day_id));
  const tkIdSet = new Set(tks.map((t) => t.id));
  const items = ALL_ITEMS.filter((it) => tkIdSet.has(it.ticket_id));
  const uds = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const venta = tks.reduce((s, t) => s + Number(t.amount), 0);
  const moneyData = monetaryBreakdown(tks, items);
  const ventaConCosto = moneyData.ventaConCosto;
  const utilidad = ventaConCosto - moneyData.costoTotal;
  return {
    dias: dayIds.length,
    tickets: tks.length,
    uds,
    venta,
    utilidad: ventaConCosto ? utilidad : null,
    ticketProm: tks.length ? venta / tks.length : null,
  };
}

function renderComparativa() {
  const gamesByDay = new Map();
  ALL_GAMES.forEach((g) => gamesByDay.set(g.sale_day_id, true));

  const semana = ALL_DAYS.filter((d) => !isWeekend(d.date)).map((d) => d.id);
  const finde = ALL_DAYS.filter((d) => isWeekend(d.date)).map((d) => d.id);
  const rowsTipo = [
    ["Entre semana", semana],
    ["Fin de semana", finde],
  ];
  document.querySelector("#tblCompDiaTipo tbody").innerHTML = rowsTipo
    .map(([label, ids]) => {
      const s = statsForDays(ids);
      return `<tr><td>${H(label)}</td><td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.dias ? money(s.venta / s.dias) : "—"}</td>
      <td class="num">${s.utilidad != null && s.dias ? moneyD(s.utilidad / s.dias) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
    })
    .join("");

  const sports = {
    futbol: "Fútbol",
    beisbol: "Béisbol / Softbol",
    otro: "Otro / normal",
  };
  document.querySelector("#tblCompDeporte tbody").innerHTML = Object.entries(
    sports,
  )
    .map(([key, label]) => {
      const ids = ALL_DAYS.filter((d) => (d.sport || "otro") === key).map(
        (d) => d.id,
      );
      const s = statsForDays(ids);
      return `<tr><td>${H(label)}</td><td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.dias ? money(s.venta / s.dias) : "—"}</td>
      <td class="num">${s.utilidad != null && s.dias ? moneyD(s.utilidad / s.dias) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
    })
    .join("");

  const categorias = {
    evento_especial: "Evento especial",
    dia_partido: "Día de partido",
    entrenamiento_normal: "Entrenamiento normal",
  };
  document.querySelector("#tblCompCategoria tbody").innerHTML = Object.entries(
    categorias,
  )
    .map(([key, label]) => {
      const ids = ALL_DAYS.filter(
        (d) => (d.day_type || "entrenamiento_normal") === key,
      ).map((d) => d.id);
      const s = statsForDays(ids);
      return `<tr><td>${H(label)}</td><td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.dias ? money(s.venta / s.dias) : "—"}</td>
      <td class="num">${s.utilidad != null && s.dias ? moneyD(s.utilidad / s.dias) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
    })
    .join("");

  const sportsForCross = {
    futbol: "Fútbol",
    beisbol: "Béisbol / Softbol",
    otro: "Otro / normal",
  };
  const catDeporteRows = [];
  for (const [catKey, catLabel] of Object.entries(categorias)) {
    for (const [spKey, spLabel] of Object.entries(sportsForCross)) {
      const ids = ALL_DAYS.filter(
        (d) =>
          (d.day_type || "entrenamiento_normal") === catKey &&
          (d.sport || "otro") === spKey,
      ).map((d) => d.id);
      if (!ids.length) continue;
      catDeporteRows.push({ catLabel, spLabel, ids });
    }
  }
  document.querySelector("#tblCompCatDeporte tbody").innerHTML =
    catDeporteRows
      .map((r) => {
        const s = statsForDays(r.ids);
        return `<tr><td>${r.catLabel}</td><td>${r.spLabel}</td><td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.dias ? money(s.venta / s.dias) : "—"}</td>
      <td class="num">${s.utilidad != null && s.dias ? moneyD(s.utilidad / s.dias) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
      })
      .join("") || '<tr><td colspan="7">Sin datos en el periodo.</td></tr>';

  const sportLabelComp = {
    futbol: "Fútbol",
    beisbol: "Béisbol / Softbol",
    otro: "Otro",
  };
  const byEvent = new Map(); // key -> {label, ids, sports:Set, types:Set, tags:Set}
  ALL_DAYS.filter(
    (d) => d.day_type === "evento_especial" || d.day_type === "dia_partido",
  ).forEach((d) => {
    const key = eventKeyOf(d);
    if (!byEvent.has(key))
      byEvent.set(key, {
        label: eventLabelOf(d),
        ids: [],
        sports: new Set(),
        types: new Set(),
        tags: new Set(),
      });
    const e = byEvent.get(key);
    e.ids.push(d.id);
    e.sports.add(d.sport || "otro");
    e.types.add(d.day_type);
    (d.event_tags || []).forEach((tag) => e.tags.add(tag));
  });
  const eventRows = [...byEvent.values()].sort((a, b) => {
    const da = Math.max(
      ...a.ids.map((id) => ALL_DAYS.find((d) => d.id === id).date),
    );
    const db = Math.max(
      ...b.ids.map((id) => ALL_DAYS.find((d) => d.id === id).date),
    );
    return db > da ? 1 : db < da ? -1 : 0;
  });
  const catLabelShort = {
    evento_especial: "Evento especial",
    dia_partido: "Día de partido",
  };
  document.querySelector("#tblCompEvento tbody").innerHTML =
    eventRows
      .map((e) => {
        const s = statsForDays(e.ids);
        return `<tr><td>${H(e.label)}</td><td>${[...e.sports].map((sp) => sportLabelComp[sp] || sp).join(", ")}</td>
      <td>${eventTagLabels([...e.tags]).join(", ") || "—"}</td>
      <td>${[...e.types].map((t) => catLabelShort[t]).join(", ")}</td>
      <td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.dias ? money(s.venta / s.dias) : "—"}</td>
      <td class="num">${s.utilidad != null ? moneyD(s.utilidad) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="9">Sin eventos o días de partido en el periodo.</td></tr>';

  EVENTS_MAP = byEvent;
  for (const key of [...SELECTED_EVENTS]) {
    if (!EVENTS_MAP.has(key)) SELECTED_EVENTS.delete(key);
  }
  renderEventCheckList();

  const byMonth = new Map();
  ALL_DAYS.forEach((d) => {
    const k = d.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(d.id);
  });
  const mesesRows = [...byMonth.entries()].sort((a, b) =>
    b[0].localeCompare(a[0]),
  );
  document.querySelector("#tblCompMes tbody").innerHTML =
    mesesRows
      .map(([mes, ids]) => {
        const s = statsForDays(ids);
        return `<tr><td>${mes}</td><td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.utilidad != null ? moneyD(s.utilidad) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
      })
      .join("") || '<tr><td colspan="5">Sin días en el periodo.</td></tr>';

  const byYear = new Map();
  ALL_DAYS.forEach((d) => {
    const k = d.date.slice(0, 4);
    if (!byYear.has(k)) byYear.set(k, []);
    byYear.get(k).push(d.id);
  });
  const aniosRows = [...byYear.entries()].sort((a, b) =>
    b[0].localeCompare(a[0]),
  );
  document.querySelector("#tblCompAnio tbody").innerHTML =
    aniosRows
      .map(([anio, ids]) => {
        const s = statsForDays(ids);
        return `<tr><td>${anio}</td><td class="num">${s.dias}</td><td class="num">${money(s.venta)}</td>
      <td class="num">${s.utilidad != null ? moneyD(s.utilidad) : "—"}</td>
      <td class="num">${s.ticketProm != null ? moneyD(s.ticketProm) : "—"}</td></tr>`;
      })
      .join("") || '<tr><td colspan="5">Sin días en el periodo.</td></tr>';
}

// ---------------- modo comparativo de eventos ----------------
function productUnitsForDays(dayIds) {
  const set = new Set(dayIds);
  const tks = ALL_TICKETS.filter((t) => set.has(t.sale_day_id));
  const tkIdSet = new Set(tks.map((t) => t.id));
  const items = ALL_ITEMS.filter((it) => tkIdSet.has(it.ticket_id));
  const prodById = new Map(PRODUCTS.map((p) => [p.id, p]));
  const agg = new Map();
  items.forEach((it) => {
    const name = it.product_id
      ? prodById.get(it.product_id)?.name || "?"
      : it.product_name_raw + " (sin catálogo)";
    agg.set(name, (agg.get(name) || 0) + it.qty);
  });
  return agg;
}

function renderEventCheckList() {
  const wrap = document.getElementById("eventCheckList");
  if (!wrap) return;
  const sportLabel = {
    futbol: "Fútbol",
    beisbol: "Béisbol/Softbol",
    otro: "Otro",
  };
  const rows = [...EVENTS_MAP.entries()].sort((a, b) => {
    const da = Math.max(
      ...a[1].ids.map((id) =>
        Date.parse(ALL_DAYS.find((d) => d.id === id).date),
      ),
    );
    const db = Math.max(
      ...b[1].ids.map((id) =>
        Date.parse(ALL_DAYS.find((d) => d.id === id).date),
      ),
    );
    return db > da ? 1 : db < da ? -1 : 0;
  });
  wrap.innerHTML =
    rows
      .map(([key, e]) => {
        const fechas = e.ids
          .map((id) => ALL_DAYS.find((d) => d.id === id).date)
          .sort();
        const rango =
          fechas.length > 1
            ? `${fechas[0]} a ${fechas[fechas.length - 1]}`
            : fechas[0];
        const checked = SELECTED_EVENTS.has(key) ? "checked" : "";
        const tags =
          eventTagLabels([...e.tags]).join("/") ||
          [...e.sports].map((sp) => sportLabel[sp] || sp).join("/");
        return `<label style="display:flex;align-items:center;gap:6px;font-weight:400;border:1px solid var(--line);border-radius:7px;padding:6px 10px;margin:0;cursor:pointer">
      <input type="checkbox" value="${H(key)}" ${checked} class="evtCheck">
      <span>${H(e.label)} <span class="footnote" style="display:inline">(${H(tags)}, ${e.ids.length}d, ${rango})</span></span>
    </label>`;
      })
      .join("") ||
    '<p class="footnote">No hay eventos especiales ni días de partido en el periodo filtrado.</p>';
  wrap.querySelectorAll(".evtCheck").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) SELECTED_EVENTS.add(cb.value);
      else SELECTED_EVENTS.delete(cb.value);
    }),
  );
}

function compareSelectedEvents() {
  const out = document.getElementById("eventCompareOut");
  if (!out) return;
  const keys = [...SELECTED_EVENTS].filter((k) => EVENTS_MAP.has(k));
  if (keys.length < 2) {
    out.innerHTML =
      '<div class="msg warn">Marca al menos 2 eventos arriba para compararlos.</div>';
    return;
  }

  const entries = keys.map((key) => {
    const e = EVENTS_MAP.get(key);
    const s = statsForDays(e.ids);
    const prods = productUnitsForDays(e.ids);
    const uds = [...prods.values()].reduce((a, b) => a + b, 0);
    return {
      key,
      label: e.label,
      tags: eventTagLabels([...e.tags]),
      s,
      prods,
      uds,
    };
  });

  let html =
    '<div class="card"><h4 style="font-size:15px;font-family:\'Source Sans 3\';font-weight:700;margin-bottom:10px">Comparativo</h4><div class="scroll"><table><thead><tr><th>Métrica</th>' +
    entries.map((e) => `<th>${H(e.label)}</th>`).join("") +
    "</tr></thead><tbody>";
  const metricRows = [
    ["Etiquetas", (e) => e.tags.join(", ") || "—"],
    ["Días", (e) => e.s.dias],
    ["Venta total", (e) => money(e.s.venta)],
    ["Venta prom./día", (e) => (e.s.dias ? money(e.s.venta / e.s.dias) : "—")],
    ["Utilidad", (e) => (e.s.utilidad != null ? moneyD(e.s.utilidad) : "—")],
    [
      "Ticket promedio",
      (e) => (e.s.ticketProm != null ? moneyD(e.s.ticketProm) : "—"),
    ],
    ["Unidades totales", (e) => e.uds],
  ];
  metricRows.forEach(([label, fn]) => {
    html +=
      `<tr><td>${H(label)}</td>` +
      entries.map((e) => `<td class="num">${fn(e)}</td>`).join("") +
      `</tr>`;
  });
  html += "</tbody></table></div></div>";

  const topSet = new Set();
  entries.forEach((e) => {
    [...e.prods.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([name]) => topSet.add(name));
  });
  const prodNames = [...topSet].sort((a, b) => {
    const totalA = entries.reduce((s, e) => s + (e.prods.get(a) || 0), 0);
    const totalB = entries.reduce((s, e) => s + (e.prods.get(b) || 0), 0);
    return totalB - totalA;
  });
  html +=
    '<div class="card" style="margin-top:14px"><h4 style="font-size:15px;font-family:\'Source Sans 3\';font-weight:700;margin-bottom:10px">Unidades vendidas por producto</h4>';
  html +=
    '<div class="scroll"><table><thead><tr><th>Producto</th>' +
    entries.map((e) => `<th class="num">${H(e.label)}</th>`).join("") +
    "</tr></thead><tbody>";
  prodNames.forEach((name) => {
    const vals = entries.map((e) => e.prods.get(name) || 0);
    const max = Math.max(...vals);
    html +=
      `<tr><td>${H(name)}</td>` +
      vals
        .map(
          (v) =>
            `<td class="num${v === max && max > 0 ? " pos" : ""}">${v || "—"}</td>`,
        )
        .join("") +
      `</tr>`;
  });
  html += "</tbody></table></div></div>";

  const byVenta = [...entries].sort((a, b) => b.s.venta - a.s.venta);
  const byVentaDia = [...entries].sort(
    (a, b) =>
      (b.s.dias ? b.s.venta / b.s.dias : 0) -
      (a.s.dias ? a.s.venta / a.s.dias : 0),
  );
  const insights = [];
  insights.push(
    `<b>${H(byVenta[0].label)}</b> tuvo la mayor venta total (${money(byVenta[0].s.venta)})${byVenta.length > 1 ? `, ${money(Math.max(0, byVenta[0].s.venta - byVenta[byVenta.length - 1].s.venta))} más que <b>${H(byVenta[byVenta.length - 1].label)}</b>` : ""}.`,
  );
  if (byVentaDia[0].key !== byVenta[0].key) {
    insights.push(
      `Por día, <b>${H(byVentaDia[0].label)}</b> fue el que más vendió en promedio (${byVentaDia[0].s.dias ? money(byVentaDia[0].s.venta / byVentaDia[0].s.dias) : "—"}/día).`,
    );
  }
  entries.forEach((e) => {
    const top = [...e.prods.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top)
      insights.push(
        `En <b>${H(e.label)}</b> lo que más se vendió fue <b>${H(top[0])}</b> (${top[1]} unidades) — ten eso bien surtido para el próximo evento parecido.`,
      );
  });
  html +=
    '<div class="card" style="margin-top:14px"><h4 style="font-size:15px;font-family:\'Source Sans 3\';font-weight:700;margin-bottom:10px">Qué te dice esto</h4><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13.5px">' +
    insights.map((i) => `<li>${i}</li>`).join("") +
    "</ul></div>";

  out.innerHTML = html;
}

// ---------------- predictor de compra para eventos ----------------
function predictionHistory() {
  return {
    days: PRED_DAYS,
    tickets: PRED_TICKETS,
    items: PRED_ITEMS,
    games: PRED_GAMES,
    counts: PRED_INV,
    movements: PRED_MOVEMENTS,
  };
}
function renderSavedPlans() {
  document.getElementById("savedPlans").innerHTML =
    [...PURCHASE_PLANS]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 30)
      .map(
        (p) =>
          "<details><summary>" +
          H(p.event_date) +
          " · " +
          (p.summary?.draft ? "Borrador" : "Lista guardada") +
          (p.summary?.manual ? " · incluye decisión manual" : "") +
          "</summary><ul>" +
          (p.rows || [])
            .map(
              (r) =>
                "<li>" +
                H(
                  r.name ||
                    PRODUCTS.find((x) => x.id === r.productId)?.name ||
                    "Producto",
                ) +
                ": " +
                (r.chosen ?? "pendiente") +
                (r.manual ? " · manual" : "") +
                "</li>",
            )
            .join("") +
          "</ul>" +
          (p.summary?.manualReason
            ? "<p>Motivo: " + H(p.summary.manualReason) + "</p>"
            : "") +
          (p.event_date >= businessDate() && p.summary?.groups?.length
            ? '<button class="btn sec sm" data-action="resumePlan" data-id="' +
              H(p.id) +
              '">Reabrir y revisar</button>'
            : "") +
          "</details>",
      )
      .join("") ||
    '<p class="footnote">Aquí aparecerán tus listas y borradores guardados.</p>';
  document.querySelector("#tblPlanResults tbody").innerHTML =
    evaluatePlans(PURCHASE_PLANS, predictionHistory())
      .map(
        (e) =>
          "<tr><td>" +
          H(e.plan.event_date) +
          "</td><td>" +
          H(e.status) +
          "</td><td>" +
          (e.complete ? e.totalActual : "—") +
          "</td><td>" +
          (e.wape == null ? "—" : (e.wape * 100).toFixed(1) + "%") +
          "</td></tr>",
      )
      .join("") ||
    '<tr><td colspan="4">Después de cerrar una jornada podrás comparar lo estimado con las ventas.</td></tr>';
}
function renderPrediction() {
  renderSavedPlans();
  if (plannerUI && !plannerUI.hasResults()) return;
  LAST_PREDICTION = null;
  try {
    const answers = readPlannerAnswers(document);
    LAST_PREDICTION = predictPurchase({
      history: predictionHistory(),
      products: PRODUCTS,
      plans: PURCHASE_PLANS,
      ...answers,
    });
    LAST_PREDICTION.answers = answers;
    renderPurchase(LAST_PREDICTION, PRODUCTS);
  } catch (error) {
    document.getElementById("plannerError").textContent = error.message;
    document.getElementById("btnSavePlan").disabled = true;
  }
}
function addPlanProduct() {
  const p = PRODUCTS.find(
    (p) => p.id === document.getElementById("planAddProduct").value,
  );
  if (
    !p ||
    !LAST_PREDICTION ||
    LAST_PREDICTION.rows.some((r) => r.productId === p.id)
  )
    return;
  document.getElementById("planReviewed").checked = false;
  const reference = inventoryAt(
    predictionHistory(),
    new Date().toISOString(),
  ).get(p.id);
  const inventory =
    reference && !reference.uncertain && !reference.inconsistent
      ? reference.value
      : null;
  const limits = [p.storage_limit, p.perishable ? p.perishable_limit : null]
    .filter((n) => n != null)
    .map(Number);
  LAST_PREDICTION.rows.push({
    productId: p.id,
    name: p.name,
    expected: null,
    demand: null,
    buy: null,
    inventory,
    limit: limits.length ? Math.min(...limits) : null,
    manualOnly: true,
    stockDate: reference?.date || null,
  });
  renderPurchaseRows(LAST_PREDICTION, PRODUCTS);
}
function resumePlan(id) {
  const plan = PURCHASE_PLANS.find((p) => p.id === id);
  if (!plan) return;
  showPane("planificador");
  if (plan.event_date < businessDate() || !plan.summary?.groups?.length) {
    document.getElementById("savedPlans").closest("details").open = true;
    gmsg(
      "ok",
      "La lista original está en Compras guardadas. Puedes consultarla o preparar una nueva jornada.",
    );
    return;
  }
  plannerUI.set({
    targetDate: plan.event_date,
    groups: plan.summary.groups,
    scheduleFingerprint: plan.summary.scheduleFingerprint,
    safety: plan.summary.safety,
  });
  plannerUI.calculate();
  if (!LAST_PREDICTION) return;
  const manual = !!plan.summary.manual;
  document.getElementById("planManual").checked = manual;
  document.getElementById("planManualFields").hidden = !manual;
  document.getElementById("planManualReason").value =
    plan.summary.manualReason || "";
  if (manual)
    for (const old of plan.rows || []) {
      let row = LAST_PREDICTION.rows.find((r) => r.productId === old.productId);
      if (
        !row &&
        PRODUCTS.some((p) => p.id === old.productId && p.active !== false)
      ) {
        document.getElementById("planAddProduct").value = old.productId;
        addPlanProduct();
        row = LAST_PREDICTION.rows.find((r) => r.productId === old.productId);
      }
      if (row) row.chosen = old.chosen;
    }
  renderPurchaseRows(LAST_PREDICTION, PRODUCTS);
  gmsg(
    "ok",
    "Jornada reabierta con historial y existencias actuales. Revisa las cantidades antes de guardar una nueva versión.",
  );
}
async function savePurchasePlan() {
  const button = document.getElementById("btnSavePlan");
  button.disabled = true;
  try {
    await journeysUI.load();
    if (!plannerUI.checkSchedule() || !LAST_PREDICTION)
      throw Error("Revisa las actividades del calendario y vuelve a calcular.");
    const review = reviewedPurchase(LAST_PREDICTION),
      p = LAST_PREDICTION;
    const plan = {
      event_date: p.targetDate,
      event_type: p.type,
      games: p.games,
      model_version: p.modelVersion,
      summary: {
        scheduleFingerprint: plannerUI.fingerprint(),
        comparison: p.comparison,
        confidence: p.confidence,
        days: p.days,
        safety: p.safety,
        team: p.team || "",
        groups: p.groups,
        partial: p.partial || false,
        draft: review.draft,
        manual: review.manual,
        manualReason: review.reason,
        components: p.components || null,
        answers: p.answers,
      },
      rows: review.rows,
    };
    const signature = JSON.stringify(plan);
    if (signature !== planSignature) {
      planSignature = signature;
      planClientRef = crypto.randomUUID();
    }
    const { data, error } = await supabase.rpc("save_purchase_plan", {
      p_plan: plan,
      p_client_ref: planClientRef,
    });
    if (error) throw error;
    if (!data)
      throw Error("No se confirmó el guardado. Reintenta sin duplicar.");
    planSignature = "";
    await loadAll();
    if (PURCHASE_PLANS.some((saved) => saved.id === data)) resumePlan(data);
    gmsg(
      "ok",
      review.draft
        ? "Borrador guardado con sus pendientes. Puedes reabrirlo en Compras guardadas."
        : "Lista guardada. Registra las entradas de inventario cuando llegue la compra.",
    );
  } catch (error) {
    gmsg("err", error.message);
  } finally {
    button.disabled = !LAST_PREDICTION?.rows.length;
  }
}

// ---------------- catálogo ----------------
async function loadCatalogFull() {
  let data;
  try {
    data = await selectAll(supabase, "products", "*");
  } catch (error) {
    gmsg("err", error.message);
    return;
  }
  const error = null;
  if (error) {
    gmsg("err", "No pude cargar el catálogo: " + error.message);
    return;
  }
  renderCatalog(data);
}

function renderCatalog(rows) {
  document.querySelector("#tblCatalog tbody").innerHTML = rows
    .map(
      (p) => `
    <tr data-id="${p.id}">
      <td><input type="text" class="edName" value="${H(p.name)}" style="min-width:160px"></td>
      <td><input type="text" class="edCat" value="${H(p.category || "")}" style="min-width:120px"></td>
      <td><input type="number" step="0.01" class="edCost" value="${p.cost_price ?? ""}" style="width:90px"></td>
      <td><input type="number" step="0.01" class="edPrice" value="${p.sell_price ?? ""}" style="width:90px"></td>
      <td><input type="checkbox" class="edActive" ${p.active ? "checked" : ""}></td>
      <td><input type="checkbox" aria-label="Perecedero: ${H(p.name)}" class="edPerishable" ${p.perishable ? "checked" : ""}></td>
      <td><input type="number" aria-label="Cupo asignado: ${H(p.name)}" min="0" step="1" class="edStorage" value="${p.storage_limit ?? ""}" style="width:90px"></td>
      <td><input type="number" aria-label="Máximo antes de caducar: ${H(p.name)}" min="0" step="1" class="edShelfLimit" value="${p.perishable_limit ?? ""}" style="width:90px"></td>
      <td><button class="btn sm" type="button" data-action="saveProduct" data-id="${p.id}">Guardar</button></td>
    </tr>`,
    )
    .join("");
}

window.__saveProduct = async (id, btn) => {
  const tr = btn.closest("tr");
  const payload = {
    name: tr.querySelector(".edName").value.trim(),
    category: tr.querySelector(".edCat").value.trim() || "Otro",
    cost_price:
      tr.querySelector(".edCost").value === ""
        ? null
        : parseFloat(tr.querySelector(".edCost").value),
    sell_price: parseFloat(tr.querySelector(".edPrice").value),
    active: tr.querySelector(".edActive").checked,
    perishable: tr.querySelector(".edPerishable").checked,
    storage_limit:
      tr.querySelector(".edStorage").value === ""
        ? null
        : Number(tr.querySelector(".edStorage").value),
    perishable_limit:
      tr.querySelector(".edShelfLimit").value === ""
        ? null
        : Number(tr.querySelector(".edShelfLimit").value),
  };
  const { error } = await supabase
    .from("products")
    .update(payload)
    .eq("id", id);
  if (error) {
    gmsg("err", "No pude guardar el producto: " + error.message);
    return;
  }
  gmsg("ok", "Producto actualizado.");
  loadAll();
};

async function addProduct(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById("npName").value.trim(),
    category: document.getElementById("npCat").value,
    perishable: document.getElementById("npCat").value === "Comida preparada",
    cost_price:
      document.getElementById("npCost").value === ""
        ? null
        : parseFloat(document.getElementById("npCost").value),
    sell_price: parseFloat(document.getElementById("npPrice").value),
  };
  const { error } = await supabase.from("products").insert(payload);
  if (error) {
    gmsg("err", "No pude agregar el producto: " + error.message);
    return;
  }
  document.getElementById("formNewProduct").reset();
  gmsg("ok", "Producto agregado.");
  loadCatalogFull();
}

// ---------------- usuarios ----------------
async function loadUsers() {
  const { data: settings, error: sErr } = await supabase
    .from("app_settings")
    .select("operators_see_costs, operators_see_all_days")
    .single();
  if (sErr)
    gmsg(
      "err",
      "No pude cargar los permisos (¿corriste supabase/permiso_operador_costos.sql?): " +
        sErr.message,
    );

  function wireToggle(inputId, field, onLabel, offLabel) {
    const chk = document.getElementById(inputId);
    if (settings) chk.checked = !!settings[field];
    chk.onchange = async () => {
      chk.disabled = true;
      const payload = {};
      payload[field] = chk.checked;
      const { error } = await supabase
        .from("app_settings")
        .update(payload)
        .eq("id", true);
      chk.disabled = false;
      if (error) {
        gmsg("err", "No pude guardar el permiso: " + error.message);
        chk.checked = !chk.checked;
        return;
      }
      gmsg("ok", chk.checked ? onLabel : offLabel);
    };
  }
  wireToggle(
    "chkOperadoresVenCostos",
    "operators_see_costs",
    "Operadores ahora ven costos y utilidad.",
    "Operadores ya no ven costos ni utilidad.",
  );
  wireToggle(
    "chkOperadoresVenTodo",
    "operators_see_all_days",
    "Operadores ahora ven el historial completo.",
    "Operadores ahora ven los últimos 31 días y todos los eventos especiales históricos.",
  );

  let data;
  try {
    data = await selectAll(supabase, "profiles", "id,full_name,role,active");
  } catch (error) {
    gmsg("err", error.message);
    return;
  }
  const error = null;
  if (error) {
    gmsg("err", "No pude cargar usuarios: " + error.message);
    return;
  }
  document.querySelector("#tblUsers tbody").innerHTML = data
    .map(
      (u) => `
    <tr data-id="${u.id}">
      <td>${H(u.full_name || "(sin nombre)")}</td>
      <td><select class="edRole">
        <option value="operador" ${u.role === "operador" ? "selected" : ""}>Operador</option>
        <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
      </select></td>
      <td><input type="checkbox" class="edUActive" ${u.active ? "checked" : ""}></td>
      <td><button class="btn sm" type="button" data-action="saveUser" data-id="${u.id}">Guardar</button></td>
    </tr>`,
    )
    .join("");
}

window.__saveUser = async (id, btn) => {
  const tr = btn.closest("tr");
  const role = tr.querySelector(".edRole").value;
  const active = tr.querySelector(".edUActive").checked;
  if (id === ME.id && role !== "admin") {
    if (!confirm("Te vas a quitar tu propio acceso de administrador. ¿Seguro?"))
      return;
  }
  const { error } = await supabase
    .from("profiles")
    .update({ role, active })
    .eq("id", id);
  if (error) {
    gmsg("err", "No pude actualizar el usuario: " + error.message);
    return;
  }
  gmsg("ok", "Usuario actualizado.");
  loadUsers();
};

init().catch((error) => {
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = true));
  gmsg("err", error.message);
});
