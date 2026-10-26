import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { initPlanner, readPlannerAnswers } from "../lib/planner.js";
import { businessDate } from "../lib/csv.js";

function wizard(calculate = () => true) {
  const { document, window } = parseHTML(
    fs.readFileSync(new URL("../reportes.html", import.meta.url), "utf8"),
  );
  let calculations = 0,
    invalidations = 0;
  const ui = initPlanner({
    root: document,
    onCalculate: () => {
      calculations++;
      return calculate(readPlannerAnswers(document));
    },
    onInvalidate: () => invalidations++,
  });
  const el = (id) => document.getElementById(id);
  return {
    document,
    ui,
    el,
    calculations: () => calculations,
    invalidations: () => invalidations,
    click: (id) => el(id).click(),
    value(id, value) {
      const node = el(id);
      if (node.tagName === "SELECT") {
        for (const option of node.options) option.removeAttribute("selected");
        [...node.options]
          .find((option) => option.value === value)
          .setAttribute("selected", "");
      } else node.value = value;
      node.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    step: () =>
      [...document.querySelectorAll("[data-planner-step]")].findIndex(
        (node) => !node.hidden,
      ),
  };
}

test("guided planner is independent and accepts unknown answers without inventing zero games", () => {
  let answers;
  const w = wizard((a) => {
    answers = a;
    return true;
  });
  assert.equal(w.el("pane-guiada").querySelector("#predDate"), null);
  assert(w.el("pane-planificador").contains(w.el("predDate")));
  assert.equal(w.step(), 0);
  assert.equal(w.ui.hasResults(), false);
  w.value("predDate", businessDate());
  for (let i = 0; i < 4; i++) w.click("plannerNext");
  assert.equal(w.step(), 4);
  assert.match(
    w.el("plannerReview").textContent,
    /No lo sé; no se filtrará por cantidad/,
  );
  w.click("btnPredict");
  assert.equal(answers.games, null);
  assert.equal(answers.type, "sin_especificar");
  assert.equal(answers.team, "");
  assert.equal(w.calculations(), 1);
  assert.equal(w.ui.hasResults(), true);
  assert.equal(w.el("plannerResults").hidden, false);
  assert.equal(w.el("plannerQuestions").hidden, true);
  w.click("plannerEdit");
  assert.equal(w.step(), 4);
  assert.equal(w.ui.hasResults(), false);
  assert.equal(w.el("plannerResults").hidden, true);
});

test("wizard validates supplied answers and preserves them while moving back and forward", () => {
  const w = wizard();
  w.value("predDate", "");
  w.click("plannerNext");
  assert.equal(w.step(), 0);
  assert.match(w.el("plannerError").textContent, /fecha futura/);
  w.value("predDate", businessDate());
  w.click("plannerNext");
  w.value("predType", "futbol");
  w.click("plannerNext");
  w.value("predGamesMode", "known");
  assert.equal(w.el("predGames").disabled, false);
  for (const invalid of ["", "0", "1.5", "51"]) {
    w.value("predGames", invalid);
    w.click("plannerNext");
    assert.equal(w.step(), 2);
    assert.match(w.el("plannerError").textContent, /1 y 50/);
  }
  w.value("predGames", "3");
  w.click("plannerNext");
  w.value("predTeamMode", "named");
  w.value("predTeam", "!!!");
  w.click("plannerNext");
  assert.equal(w.step(), 3);
  assert.match(w.el("plannerError").textContent, /Escribe el equipo/);
  w.value("predTeam", "Tigres");
  w.click("plannerNext");
  w.click("plannerBack");
  w.click("plannerBack");
  assert.equal(w.el("predGames").value, "3");
  w.click("plannerNext");
  assert.equal(w.el("predTeam").value, "Tigres");
  w.click("plannerNext");
  w.click("btnPredict");
  assert.equal(w.ui.hasResults(), true);
});

test("no aplica and unknown remain distinct; review escapes a supplied team name", () => {
  const w = wizard();
  w.value("predGamesMode", "none");
  assert.equal(readPlannerAnswers(w.document).games, 0);
  w.value("predGamesMode", "unknown");
  assert.equal(readPlannerAnswers(w.document).games, null);
  w.value("predTeamMode", "named");
  const attack = '<img src=x onerror="alert(1)">Tigres';
  w.value("predTeam", attack);
  assert(w.el("plannerReview").textContent.includes(attack));
  assert.equal(w.el("plannerReview").querySelector("img"), null);
  w.value("predTeamMode", "none");
  assert.equal(readPlannerAnswers(w.document).team, "");
  assert.equal(w.el("predTeam").disabled, true);
  w.value("predTeamMode", "club_puebla");
  assert.equal(readPlannerAnswers(w.document).team, "Club Puebla");
});

test("calculation failure stays visible in the wizard and permits retry", () => {
  let fail = true;
  const w = wizard(() => {
    if (fail) throw new Error("No se pudo leer el historial");
    return true;
  });
  for (let i = 0; i < 4; i++) w.click("plannerNext");
  w.click("btnPredict");
  assert.equal(w.ui.hasResults(), false);
  assert.equal(w.el("plannerQuestions").hidden, false);
  assert.match(w.el("plannerError").textContent, /leer el historial/);
  fail = false;
  w.click("btnPredict");
  assert.equal(w.ui.hasResults(), true);
  w.value("predSafety", "0.20");
  assert.equal(w.ui.hasResults(), false);
  assert.equal(w.el("plannerResults").hidden, true);
});
