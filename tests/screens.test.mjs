import {
  activitiesForDate,
  actualActivities,
  dayClassification,
} from "../lib/schedule.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { webcrypto } from "node:crypto";
import { escapeHTML as H, selectAll, associateLabels } from "../lib/safe.js";
import {
  monetaryBreakdown,
  inventoryAt,
  itemProductKey,
} from "../lib/accounting.js";
import {
  businessDate,
  parseBusinessDate,
  normalizedName,
  parseReceipts,
  parseInventory,
} from "../lib/csv.js";
import { predictPurchase, evaluatePlans } from "../lib/prediction.js";
import { initPlanner, readPlannerAnswers } from "../lib/planner.js";
import { showSection } from "../lib/navigation.js";
import {
  inventoryTimestamp,
  timeChoice,
  initInventoryTime,
} from "../lib/inventory-time.js";
import {
  renderPurchase,
  renderPurchaseRows,
  reviewedPurchase,
} from "../lib/purchase-review.js";
import { dayMetadata, correctionDiff } from "../lib/corrections.js";
import { parkingRows } from "../lib/parking.js";
import {
  initGroupEditor,
  validateGroups,
  totalGames,
  groupLabel,
} from "../lib/event-groups.js";
const attack = '\"><img src=x onerror="globalThis.PWNED=1">&';
function screen(name, globals = {}) {
  const { document, window } = parseHTML(
    fs.readFileSync(new URL("../" + name + ".html", import.meta.url), "utf8"),
  );
  const source = fs
    .readFileSync(new URL("../lib/" + name + ".js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, "")
    .replace(/init\(\)\.catch\([\s\S]*$/, "");
  const ctx = {
    document,
    window,
    showSection,
    inventoryTimestamp,
    timeChoice,
    initInventoryTime,
    history: {
      replaceState(a, b, hash) {
        window.location.hash = hash;
      },
    },
    renderPurchase: (p, products) => renderPurchase(p, products, document),
    renderPurchaseRows: (p, products) =>
      renderPurchaseRows(p, products, document),
    reviewedPurchase: (p) => reviewedPurchase(p, document),
    H,
    selectAll,
    associateLabels: () => associateLabels(document),
    readPlannerAnswers,
    initPlanner,
    initGroupEditor: (options) =>
      initGroupEditor({ ...options, root: document }),
    validateGroups,
    activitiesForDate,
    actualActivities,
    dayClassification,
    totalGames,
    groupLabel,
    predictPurchase,
    evaluatePlans,
    monetaryBreakdown,
    inventoryAt,
    parkingRows,
    itemProductKey,
    businessDate,
    parseBusinessDate,
    normalizedName,
    parseReceipts,
    parseInventory,
    crypto: webcrypto,
    console,
    signOut: () => {},
    ...globals,
  };
  window.location = { hash: "" };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { document, ctx, run: (s) => vm.runInContext(s, ctx) };
}
test("all report renderers work and stored strings cannot create executable HTML", () => {
  const s = screen("reportes");
  s.ctx.attack = attack;
  s.run(`
 PRODUCTS=[{id:'p',name:attack,category:attack,sell_price:50,cost_price:20,active:true}];
 ALL_DAYS=[{id:'d',date:'2026-09-19',sport:'futbol',status:'submitted',day_type:'evento_especial',event_name:attack,event_tags:['futbol'],profiles:{full_name:attack}}];
 ALL_TICKETS=[{id:'t',sale_day_id:'d',ts:'2026-09-19T18:00:00Z',amount:80,receipt_type:'sale'}];
 ALL_ITEMS=[{id:'i',ticket_id:'t',product_id:'p',product_name_raw:attack,qty:2,unit_price:50,unit_cost:20,line_net_amount:80}];
 ALL_GAMES=[{id:'g',sale_day_id:'d',start_time:'12:00',cars_parked:10,cars_charged:8,parking_rate:30,charges_parking:true,notes:attack}];
 ALL_INV=[{id:'c',sale_day_id:'d',product_id:'p',physical_count:5,opening_stock:null,sold:null,count_source:'legacy'}];
 DAYS=ALL_DAYS;TICKETS=ALL_TICKETS;ITEMS=ALL_ITEMS;GAMES=ALL_GAMES;INV_COUNTS=ALL_INV;
 PRED_DAYS=ALL_DAYS;PRED_TICKETS=ALL_TICKETS;PRED_ITEMS=ALL_ITEMS;PRED_INV=ALL_INV;PRED_GAMES=ALL_GAMES;
 renderAll();renderComparativa();renderEventCheckList();renderCatalog(PRODUCTS);
 `);
  assert.equal(
    s.document.querySelectorAll('img[src="x"],[onerror]').length,
    0,
    [...s.document.querySelectorAll('img[src="x"],[onerror]')]
      .map((e) => e.parentElement.outerHTML)
      .join("\n"),
  );
  assert.match(
    s.document.getElementById("invMsg").textContent,
    /no calculable/,
  );
  assert(s.document.getElementById("tblProdRank").textContent.includes(attack));
});
test("administrator catalog loads protected view costs and paginates without raw table access", async () => {
  const products = Array.from({ length: 501 }, (_, i) => ({
    id: String(i), name: `Producto ${i}`, category: "Bebida",
    cost_price: i === 500 ? null : 7.5, sell_price: 15, active: true,
    perishable: false, storage_limit: 24, perishable_limit: null,
  }));
  const s = screen("reportes", { supabase: {
    from(table) {
      return {
        select() { return this; },
        order() { return this; },
        async range(from, to) {
          return table === "products_view"
            ? { data: products.slice(from, to + 1) }
            : { error: { message: "permission denied for table products" } };
        },
      };
    },
  } });
  await s.run("loadCatalogFull()");
  const rows = s.document.querySelectorAll("#tblCatalog tbody tr");
  assert.equal(rows.length, 501);
  assert.equal(rows[0].querySelector(".edCost").value, "7.5");
  assert.equal(rows[500].querySelector(".edCost").value, "");
  assert.equal(rows[0].querySelector(".edStorage").value, "24");
  assert.equal(rows[0].querySelector('[data-action="saveProduct"]').textContent, "Guardar");
});

test("operator preserves exact names in inventory text and input attributes", () => {
  const s = screen("operador");
  s.ctx.attack = attack;
  s.run(
    "CATALOG=[{id:'p',name:attack,category:'Agua',sell_price:20}];renderInventoryInputs();addGame('12:00',1,1,true,attack);",
  );
  assert.equal(s.document.querySelectorAll('img[src="x"],[onerror]').length, 0);
  assert.equal(s.document.querySelector(".gNota").value, attack);
  assert.equal(
    s.document.querySelector(".invCount").getAttribute("aria-label"),
    "Conteo de " + attack,
  );
});
test("failed report queries keep reports hidden and expose a retry message", async () => {
  const client = {
    from() {
      return {
        select() {
          return this;
        },
        gte() {
          return this;
        },
        lte() {
          return this;
        },
        order() {
          return this;
        },
        range() {
          return Promise.resolve({ error: { message: "Offline" } });
        },
      };
    },
  };
  const s = screen("reportes", { supabase: client });
  s.document.getElementById("fFrom").value = "2026-09-01";
  s.document.getElementById("fTo").value = "2026-09-19";
  await s.run("loadAll()");
  assert.match(
    s.document.getElementById("globalMsg").textContent,
    /no disponible.*Offline/,
  );
  assert(
    [...s.document.querySelectorAll(".pane")].every(
      (p) => p.hidden === (p.id !== "pane-jornadas"),
    ),
  );
});

test("history batches load concurrently without losing rows, order or query failures", async () => {
  let active = 0,
    peak = 0,
    fail = false;
  const client = {
    from() {
      return {
        select() {
          return this;
        },
        in(column, ids) {
          this.ids = ids;
          return this;
        },
        order() {
          return this;
        },
        async range(offset) {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
          return fail
            ? { error: { message: "Incomplete history" } }
            : { data: offset ? [] : this.ids.map((id) => ({ id })) };
        },
      };
    },
  };
  const s = screen("reportes", { supabase: client });
  const ids = Array.from({ length: 401 }, (_, i) => String(i));
  s.ctx.ids = ids;
  const rows = await s.run("selectAllIn('tickets','id','sale_day_id',ids)");
  assert.deepEqual(
    Array.from(rows, (r) => r.id),
    ids,
  );
  assert.equal(peak, 4);
  fail = true;
  await assert.rejects(
    () => s.run("selectAllIn('tickets','id','sale_day_id',ids)"),
    /Incomplete history/,
  );
});
test("classification keeps Club Puebla tags independent of day category", () => {
  const before = dayMetadata({
    sport: "futbol",
    day_type: "entrenamiento_normal",
    event_tags: ["club_puebla"],
  });
  const after = { ...before, event_name: "Club Puebla" };
  assert.deepEqual(after.event_tags, ["club_puebla"]);
  assert.deepEqual(
    correctionDiff(before, after).map((r) => r.field),
    ["Nombre del evento"],
  );
});

test("planner navigation hides report filters and restores them when returning to reports", () => {
  const s = screen("reportes");
  s.run('showPane("planificador","mode")');
  assert.equal(s.document.getElementById("reportFilters").hidden, true);
  assert(
    s.document.getElementById("pane-planificador").classList.contains("on"),
  );
  assert.equal(
    s.document
      .querySelector('[data-view="planificador"]')
      .getAttribute("aria-current"),
    "page",
  );
  s.run('showPane("resumen","mode")');
  assert.equal(s.document.getElementById("reportFilters").hidden, false);
  assert(
    !s.document.getElementById("pane-planificador").classList.contains("on"),
  );
  s.run('showPane("productos")');
  assert.equal(
    s.document
      .querySelector('[data-view="resumen"]')
      .getAttribute("aria-current"),
    "page",
  );
  s.run('showPane("inventario")');
  assert.equal(
    s.document
      .querySelector('[data-view="inventario"]')
      .getAttribute("aria-current"),
    "page",
  );
  s.run('showPane("usuarios")');
  assert(s.document.getElementById("pane-jornadas").classList.contains("on"));
});

test("activity answers reach the real calculation and save with the reviewed agenda", async () => {
  let saved;
  const s = screen("reportes", {
    supabase: {
      rpc: async (name, args) => {
        saved = { name, args };
        return { data: "guided-plan" };
      },
    },
  });
  const past = parseBusinessDate(businessDate() + "T12:00");
  past.setUTCDate(past.getUTCDate() - 6);
  s.ctx.pastDate = businessDate(past);
  s.run(`
    PRODUCTS=[{id:'p',name:'Agua',active:true}];
    PRED_DAYS=[{id:'d',date:pastDate,sport:'futbol',day_type:'dia_partido',event_tags:[],status:'reviewed',event_groups:[{type:'futbol',teamMode:'academy',team:'',games:1}]}];
    PRED_TICKETS=[{id:'t',sale_day_id:'d',ts:pastDate+'T18:00:00Z'}];
    PRED_ITEMS=[{ticket_id:'t',product_id:'p',qty:10}];
    PRED_INV=[{sale_day_id:'d',product_id:'p',physical_count:5,counted_at:pastDate+'T23:00:00Z',count_source:'manual'}];
    plannerUI=initPlanner({root:document,onCalculate:()=>{renderPrediction();return !!LAST_PREDICTION;},onInvalidate:()=>{LAST_PREDICTION=null;}});
    journeysUI={load:async()=>{}};
    loadAll=async()=>{};
    renderPrediction();
  `);
  assert.equal(
    s.run("LAST_PREDICTION"),
    null,
    "loading reports must not compute an unfinished wizard",
  );
  s.document.querySelector('[data-add-activity="academy"]').click();
  for (let i = 0; i < 2; i++) s.document.getElementById("plannerNext").click();
  s.document.getElementById("btnPredict").click();
  assert.equal(s.document.getElementById("plannerResults").hidden, false);
  assert.match(
    s.document.getElementById("predictorSummary").textContent,
    /referencia/,
  );
  assert.equal(s.run("LAST_PREDICTION.rows[0].expected"), 10);
  s.document.getElementById("planReviewed").checked = true;
  await s.run("savePurchasePlan()");
  assert.equal(saved.name, "save_purchase_plan");
  assert.equal(saved.args.p_plan.games, 1);
  assert.equal(saved.args.p_plan.summary.answers.groups[0].teamMode, "academy");
  assert.equal(saved.args.p_plan.summary.draft, false);
  assert.equal(saved.args.p_plan.rows[0].chosen, 6);
});

test("parallel file reads, cleared selection and malformed files cannot enable a partial save", async () => {
  const readers = [];
  class Reader {
    constructor() {
      readers.push(this);
    }
    readAsText() {
      this.readyState = 1;
    }
    abort() {
      this.readyState = 2;
    }
  }
  const s = screen("operador", { FileReader: Reader });
  s.run(
    "CATALOG=[{id:'p',name:'Agua',sell_price:20}];renderInventoryInputs();checkExistingDate=()=>{};",
  );
  s.run(
    "onCsvChange({target:{files:[{}]}});onInventoryCsvChange({target:{files:[{}]}});",
  );
  readers[1].result = "Name,Price,In stock [A]\nAgua,20,8";
  readers[1].onload();
  assert.equal(s.document.getElementById("btnSave").disabled, true);
  s.run("onCsvChange({target:{files:[]}});");
  readers[0].result = "bad";
  await readers[0].onload();
  assert.equal(s.run("PARSED_TICKETS"), null);
  assert.equal(s.document.getElementById("btnSave").disabled, false);
  s.run("onInventoryCsvChange({target:{files:[{}]}});");
  readers[2].result = "Name,Price,In stock [A]\nAgua,20,-8";
  readers[2].onload();
  assert.equal(s.document.getElementById("btnSave").disabled, true);
  assert.equal(s.run("PARSED_INVENTORY"), null);
});

test("deployed pages use external scripts and no inline handlers", () => {
  for (const name of ["index", "operador", "reportes"]) {
    const { document } = parseHTML(
      fs.readFileSync(new URL("../" + name + ".html", import.meta.url), "utf8"),
    );
    assert(
      [...document.querySelectorAll("script")].every((s) =>
        s.hasAttribute("src"),
      ),
    );
    assert(
      [...document.querySelectorAll("*")].every((e) =>
        [...e.attributes].every((a) => !/^on/i.test(a.name)),
      ),
    );
  }
  const csp = JSON.parse(
    fs
      .readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
      .replace(/^\uFEFF/, ""),
  );
  assert.match(csp.headers[0].headers[0].value, /script-src 'self';/);
});

test("purchase review requires confirmation, preserves the prediction and enforces storage limits", async () => {
  let saved = null;
  const fixture = {
    modelVersion: "eventos-2026-10-v1",
    targetDate: "2099-01-03",
    type: "futbol",
    games: 3,
    safety: 0.1,
    comparison: "Mismo miércoles",
    confidence: "baja",
    excludedIncomplete: 0,
    days: [{ id: "d", date: "2026-09-02", games: 3, closed: true }],
    rows: [
      {
        productId: "p",
        name: attack,
        expected: 10,
        demand: 11,
        low: 8,
        high: 12,
        inventory: 5,
        stockDate: "2026-09-19",
        buy: 5,
        limit: 10,
        capped: true,
        observedDays: 1,
        factor: 1,
      },
    ],
  };
  const s = screen("reportes", {
    predictPurchase: () => fixture,
    evaluatePlans: () => [],
    supabase: {
      rpc: async (name, args) => {
        saved = { name, args };
        return { data: "saved-plan" };
      },
    },
  });
  s.run(
    "journeysUI={load:async()=>{}};plannerUI={checkSchedule:()=>true,fingerprint:()=>'[]',hasResults:()=>true};loadAll=async()=>{};renderPrediction();",
  );
  assert.equal(s.document.querySelectorAll('img[src="x"],[onerror]').length, 0);
  await s.run("savePurchasePlan()");
  assert.equal(saved, null);
  s.document.getElementById("planReviewed").checked = true;
  s.document.getElementById("planManual").checked = true;
  s.document.getElementById("planManualReason").value =
    "Ajuste del encargado por disponibilidad";
  s.document.querySelector(".planChosen").value = "9";
  await s.run("savePurchasePlan()");
  assert.equal(saved, null);
  s.document.querySelector(".planChosen").value = "4";
  await s.run("savePurchasePlan()");
  assert.equal(saved.name, "save_purchase_plan");
  assert.equal(saved.args.p_plan.rows[0].expected, 10);
  assert.equal(saved.args.p_plan.rows[0].chosen, 4);
});

test("capture uses confirmed actual activities, strips calendar references and blocks unconfirmed plans", async () => {
  let saved;
  const s = screen("operador", {
    saveDay: async (client, payload) => {
      saved = payload;
      return { inserted: 1, skipped: 0, repaired: 0 };
    },
    supabase: {},
  });
  s.document.getElementById("fDate").value = businessDate();
  s.run(
    "captureDate=document.getElementById('fDate').value;captureReady=true;resetForm=()=>{};reloadCatalog=async()=>{};captureGroups.set([{type:'beisbol',teamMode:'none',team:'',games:3,slots:[],scheduleId:'planned',scheduleVersion:1}]);",
  );
  await assert.rejects(() => s.run("submitSingleDay()"), /Confirma/);
  assert.equal(saved, undefined);
  s.document.getElementById("captureConfirmed").checked = true;
  await s.run("submitSingleDay()");
  assert.equal(saved.day.sport, "beisbol");
  assert.equal(saved.day.event_groups[0].games, 3);
  assert.equal(saved.day.event_groups[0].scheduleId, undefined);
  assert.equal(saved.counts.length, 0);
});
test("independent inventory searches products and retries a failed save with the same request", async () => {
  const requests = [];
  const s = screen("operador", {
    supabase: {
      rpc: async (name, p) => {
        requests.push({ name, p });
        return requests.length === 1
          ? { error: { message: "No hay conexión" } }
          : { data: 1 };
      },
    },
  });
  s.run(
    "CATALOG=[{id:'p',name:'Agua',sell_price:20},{id:'q',name:'Coca',sell_price:25}];renderInventoryInputs();resetForm=()=>{};",
  );
  assert.equal(
    s.document.querySelectorAll("#tblInv tr:not([hidden]) input").length,
    0,
  );
  s.document.getElementById("inventorySearch").value = "agua";
  s.run("filterInventory()");
  assert.equal(
    s.document.querySelectorAll("#tblInv tr:not([hidden]) input").length,
    1,
  );
  s.document.querySelector(".invCount").value = "0";
  s.document.getElementById("fCountAt").value = businessDate() + "T00:00";
  await assert.rejects(
    () => s.run("submitInventory()"),
    (e) => /conexión/.test(e.message),
  );
  await s.run("submitInventory()");
  assert.equal(requests[0].name, "save_inventory_count");
  assert.equal(requests[0].p.p_client_ref, requests[1].p.p_client_ref);
  assert.deepEqual(requests[0].p.p_counts, requests[1].p.p_counts);
  assert.equal(requests[1].p.p_counts[0].physical_count, 0);
});
