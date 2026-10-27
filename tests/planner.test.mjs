import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { initPlanner, readPlannerAnswers } from "../lib/planner.js";
import { initGroupEditor } from "../lib/event-groups.js";
import { businessDate } from "../lib/csv.js";
function wizard(calculate = () => true, getSchedule = () => []) {
  const { document, window } = parseHTML(
    fs.readFileSync(new URL("../reportes.html", import.meta.url), "utf8"),
  );
  const el = (id) => document.getElementById(id);
  const ui = initPlanner({
    root: document,
    getSchedule,
    onCalculate: () => calculate(readPlannerAnswers(document)),
    onInvalidate: () => {},
  });
  return {
    document,
    window,
    el,
    ui,
    click: (id) => el(id).click(),
    add: (key) =>
      document.querySelector(`[data-add-activity="${key}"]`).click(),
    value(id, value) {
      const node = el(id);
      if (node.tagName === "SELECT") {
        for (const o of node.options) o.removeAttribute("selected");
        [...node.options]
          .find((o) => o.value === value)
          .setAttribute("selected", "");
      } else node.value = value;
      node.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    step: () =>
      [...document.querySelectorAll("[data-planner-step]")].findIndex(
        (n) => !n.hidden,
      ),
  };
}
test("three-step activity flow keeps the whole agenda together with no end-time input", () => {
  const w = wizard();
  w.value("predDate", businessDate());
  w.click("plannerNext");
  w.add("puebla");
  w.add("academy");
  w.add("baseball");
  w.value("predActivities-1-games", "2");
  w.value("predActivities-2-games", "3");
  w.value("predActivities-0-start0", "09:00");
  assert.equal(w.document.querySelector("[data-end]"), null);
  assert.equal(w.document.querySelector("#predComposition"), null);
  assert.equal(w.document.querySelectorAll("[data-planner-step]").length, 3);
  w.click("plannerNext");
  assert.equal(w.step(), 2);
  const a = readPlannerAnswers(w.document);
  assert.equal(a.games, 6);
  assert.equal(a.groups[1].teamMode, "academy");
  assert.equal(a.groups[2].type, "beisbol");
  assert.equal(a.groups[0].slots[0].start, "09:00");
  assert(!w.el("plannerReview").textContent.includes("Grupo"));
  w.click("btnPredict");
  assert(w.ui.hasResults());
  w.click("plannerEdit");
  assert.equal(w.step(), 1);
  assert.equal(w.el("predActivities-0-start0").value, "09:00");
});
test("missing quantity stays unknown, zero is an activity, and empty agenda cannot calculate", () => {
  const w = wizard();
  w.click("plannerNext");
  w.click("plannerNext");
  assert.equal(w.step(), 1);
  assert.match(w.el("plannerError").textContent, /actividad/);
  w.add("other");
  assert.equal(readPlannerAnswers(w.document).groups[0].games, null);
  w.add("training");
  assert.equal(readPlannerAnswers(w.document).groups[1].games, 0);
  w.value("predActivities-0-games", "51");
  w.click("plannerNext");
  assert.equal(w.step(), 1);
  assert.match(w.el("plannerError").textContent, /50/);
  w.value("predActivities-0-games", "");
  w.click("plannerNext");
  w.click("btnPredict");
  assert(w.ui.hasResults());
});
test("activity edits and deletions retain other starts and escape team names", () => {
  const w = wizard();
  w.add("puebla");
  w.add("other");
  w.value("predActivities-0-start0", "09:00");
  w.value("predActivities-1-teamMode", "named");
  w.value("predActivities-1-team", "<img src=x onerror=alert(1)>");
  assert.equal(w.el("plannerReview").querySelector("img"), null);
  w.add("baseball");
  assert.equal(w.el("predActivities-0-start0").value, "09:00");
  w.document.querySelector('[data-remove-activity="2"]').click();
  assert.equal(readPlannerAnswers(w.document).groups.length, 2);
  assert.equal(w.el("predActivities-0-start0").value, "09:00");
});
test("failed calculation keeps the agenda editable and changing answers invalidates results", () => {
  let fail = true;
  const w = wizard(() => {
    if (fail) throw Error("Historial no disponible");
    return true;
  });
  w.add("puebla");
  w.click("plannerNext");
  w.click("plannerNext");
  w.click("btnPredict");
  assert(!w.ui.hasResults());
  assert.match(w.el("plannerError").textContent, /Historial/);
  fail = false;
  w.click("btnPredict");
  assert(w.ui.hasResults());
  w.value("predSafety", "0.2");
  assert(!w.ui.hasResults());
  assert(w.el("plannerResults").hidden);
});
test("audited activity editor preserves recorded historical ends, but clears one if its start changes", () => {
  const { document, window } = parseHTML('<div id="activities"></div>');
  const groups = [
    {
      type: "futbol",
      teamMode: "club_puebla",
      team: "Club Puebla",
      games: 1,
      slots: [{ start: "09:00", end: "11:00" }],
    },
  ];
  const editor = initGroupEditor({ root: document, id: "activities", groups });
  assert.equal(document.querySelector("[data-end]"), null);
  assert.equal(editor.read()[0].slots[0].end, "11:00");
  const start = document.getElementById("activities-0-start0");
  start.value = "12:00";
  start.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(editor.read()[0].slots[0].end, "");
  assert.equal(groups[0].slots[0].end, "11:00");
});

test("calendar imports once, extra activities stay local, and changes require review", () => {
  const date = businessDate(),
    activity = {
      type: "futbol",
      teamMode: "club_puebla",
      team: "Club Puebla",
      games: 1,
      slots: [{ start: "11:00", end: "" }],
    };
  let rows = [{ id: "s1", date, version: 1, activity }];
  const w = wizard(
    () => true,
    () => rows,
  );
  w.ui.openDate(date);
  assert.equal(readPlannerAnswers(w.document).groups.length, 1);
  assert.equal(readPlannerAnswers(w.document).groups[0].scheduleId, "s1");
  w.add("baseball");
  w.value("predActivities-1-games", "3");
  assert.equal(rows.length, 1, "extra is not a calendar write");
  w.click("plannerNext");
  w.click("btnPredict");
  assert(w.ui.hasResults());
  rows = [
    { ...rows[0], version: 2, activity: { ...activity, games: 2, slots: [] } },
  ];
  assert.equal(w.ui.checkSchedule(), false);
  assert(!w.ui.hasResults());
  w.click("btnPredict");
  assert(!w.ui.hasResults(), "stale selection cannot calculate");
  w.click("plannerReloadSchedule");
  assert.deepEqual(
    readPlannerAnswers(w.document).groups.map((g) => g.games),
    [2, 3],
  );
  w.ui.checkSchedule();
  assert.equal(
    readPlannerAnswers(w.document).groups.length,
    2,
    "refresh does not duplicate",
  );
  w.document.querySelector('[data-remove-activity="0"]').click();
  assert.equal(rows.length, 1, "exclusion is local to purchase");
  w.click("plannerNext");
  w.click("btnPredict");
  assert(w.ui.hasResults());
  w.ui.openDate("2099-01-01");
  assert.equal(
    readPlannerAnswers(w.document).groups.length,
    0,
    "changing date does not carry extras to another day",
  );
});
test("reopening a saved purchase detects cancelled activities and preserves the old selection until reviewed", () => {
  const date = businessDate(),
    activity = {
      type: "futbol",
      teamMode: "academy",
      team: "",
      games: 2,
      slots: [],
    };
  const w = wizard(
    () => true,
    () => [{ id: "s1", date, version: 2, status: "cancelled", activity }],
  );
  w.ui.set({
    targetDate: date,
    groups: [{ ...activity, scheduleId: "s1", scheduleVersion: 1 }],
    scheduleFingerprint: JSON.stringify([{ id: "s1", version: 1 }]),
  });
  assert.equal(w.ui.checkSchedule(), false);
  assert.equal(readPlannerAnswers(w.document).groups.length, 1);
  w.click("plannerKeepSchedule");
  w.click("plannerNext");
  w.click("btnPredict");
  assert(w.ui.hasResults());
  assert.equal(readPlannerAnswers(w.document).scheduleFingerprint, "[]");
});
