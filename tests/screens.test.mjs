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
import { dayMetadata, correctionDiff } from "../lib/corrections.js";
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
    H,
    selectAll,
    associateLabels: () => associateLabels(document),
    readPlannerAnswers,
    initPlanner,
    initGroupEditor: (options) =>
      initGroupEditor({ ...options, root: document }),
    validateGroups,
    totalGames,
    groupLabel,
    predictPurchase,
    evaluatePlans,
    monetaryBreakdown,
    inventoryAt,
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
  assert([...s.document.querySelectorAll(".pane")].every((p) => p.hidden));
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
      .getAttribute("aria-selected"),
    "true",
  );
  s.run('showPane("resumen","mode")');
  assert.equal(s.document.getElementById("reportFilters").hidden, false);
  assert(
    !s.document.getElementById("pane-planificador").classList.contains("on"),
  );
});

test("guided answers reach the real calculation and save unchanged with unknown games", async () => {
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
    PRED_DAYS=[{id:'d',date:pastDate,sport:'futbol',day_type:'dia_partido',event_tags:[],status:'reviewed'}];
    PRED_TICKETS=[{id:'t',sale_day_id:'d',ts:pastDate+'T18:00:00Z'}];
    PRED_ITEMS=[{ticket_id:'t',product_id:'p',qty:10}];
    PRED_INV=[{sale_day_id:'d',product_id:'p',physical_count:5,counted_at:pastDate+'T23:00:00Z',count_source:'manual'}];
    plannerUI=initPlanner({root:document,onCalculate:()=>{renderPrediction();return !!LAST_PREDICTION;},onInvalidate:()=>{LAST_PREDICTION=null;}});
    for(const option of document.getElementById('predComposition').options)option.removeAttribute('selected');
    [...document.getElementById('predComposition').options].find(o=>o.value==='single').setAttribute('selected','');
    loadAll=async()=>{};
    renderPrediction();
  `);
  assert.equal(
    s.run("LAST_PREDICTION"),
    null,
    "loading reports must not compute an unfinished wizard",
  );
  for (let i = 0; i < 4; i++) s.document.getElementById("plannerNext").click();
  s.document.getElementById("btnPredict").click();
  assert.equal(s.document.getElementById("plannerResults").hidden, false);
  assert.match(
    s.document.getElementById("predictorSummary").textContent,
    /desconocido/,
  );
  assert.equal(s.run("LAST_PREDICTION.rows[0].expected"), 10);
  s.document.getElementById("planReviewed").checked = true;
  await s.run("savePurchasePlan()");
  assert.equal(saved.name, "save_purchase_plan");
  assert.equal(saved.args.p_plan.games, null);
  assert.equal(saved.args.p_plan.summary.answers.gamesMode, "unknown");
  assert.equal(saved.args.p_plan.summary.answers.teamMode, "none");
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
  s.run("loadAll=async()=>{};renderPrediction();");
  assert.equal(s.document.querySelectorAll('img[src="x"],[onerror]').length, 0);
  await s.run("savePurchasePlan()");
  assert.equal(saved, null);
  s.document.getElementById("planReviewed").checked = true;
  s.document.querySelector(".planChosen").value = "9";
  await s.run("savePurchasePlan()");
  assert.equal(saved, null);
  s.document.querySelector(".planChosen").value = "4";
  await s.run("savePurchasePlan()");
  assert.equal(saved.name, "save_purchase_plan");
  assert.equal(saved.args.p_plan.rows[0].expected, 10);
  assert.equal(saved.args.p_plan.rows[0].chosen, 4);
});
