import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import {
  initParkingCorrections,
  parkingSnapshot,
  parkingDiff,
} from "../lib/parking-corrections.js";

function setup(
  admin = true,
  rpc = async () => ({ data: { id: "saved", applied: admin } }),
) {
  const { document, window } = parseHTML(
    fs.readFileSync(new URL("../reportes.html", import.meta.url), "utf8"),
  );
  const data = {
    admin,
    days: [
      { id: "old", date: "2026-10-20", status: "submitted" },
      { id: "new", date: "2026-10-17", status: "submitted" },
    ],
    games: [38, 39, 25].map((cars, i) => ({
      id: "game" + i,
      revision: 1,
      sale_day_id: "old",
      start_time: ["09:00:00", "11:30:00", "15:45:00"][i],
      cars_parked: cars,
      cars_charged: cars,
      parking_rate: 30,
      charges_parking: true,
      notes: "Juego " + (i + 1),
    })),
    requests: [],
    decisions: [],
  };
  const calls = [];
  let refreshes = 0;
  const ui = initParkingCorrections({
    root: document,
    context: () => data,
    client: {
      rpc: async (name, payload) => {
        calls.push({ name, payload });
        return rpc(name, payload);
      },
    },
    refresh: async () => {
      refreshes++;
    },
  });
  const el = (id) => document.getElementById(id);
  const set = (id, value) => {
    el(id).value = value;
    el(id).dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const submit = async () => {
    el("parkingCorrectionForm").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setImmediate(r));
  };
  return {
    ui,
    data,
    document,
    window,
    el,
    set,
    submit,
    calls,
    refreshes: () => refreshes,
  };
}

test("parking batch date correction preserves every count, rate, time and original revision", async () => {
  const s = setup();
  s.ui.open();
  assert.match(s.el("parkingCorrectionPanel").textContent, /3 registros/);
  s.set("parkingDate", "2026-10-17");
  s.set("parkingReason", "Se capturó en el día equivocado");
  assert.match(
    s.el("parkingPreview").textContent,
    /20\/10\/2026 → 17\/10\/2026/,
  );
  await s.submit();
  assert.equal(s.calls.length, 1);
  const changes = s.calls[0].payload.p_changes;
  assert.equal(changes.length, 3);
  changes.forEach((change, i) => {
    assert.deepEqual(
      change.before,
      parkingSnapshot(s.data.games[i], s.data.days),
    );
    assert.deepEqual(
      parkingDiff(change.before, change.after).map((d) => d.key),
      ["date"],
    );
  });
  assert.equal(
    changes.reduce(
      (sum, x) => sum + x.after.cars_charged * x.after.parking_rate,
      0,
    ),
    3060,
  );
  assert.equal(s.el("parkingCorrectionPanel").hidden, true);
  assert.equal(s.refreshes(), 1);
});

test("parking editor preserves retry identity, exposes failures and rotates it only for a new proposal", async () => {
  const s = setup(true, async () => ({
    error: { message: "El estacionamiento cambió. Recarga" },
  }));
  s.ui.open("game0");
  s.set("parkingCars", "40");
  s.set("parkingReason", "Error en el conteo de autos");
  await s.submit();
  await s.submit();
  assert.equal(
    s.calls[0].payload.p_client_ref,
    s.calls[1].payload.p_client_ref,
  );
  assert.match(s.el("parkingFormMessage").textContent, /cambió/);
  assert.equal(s.el("parkingCars").value, "40");
  assert.equal(s.el("parkingCorrectionPanel").hidden, false);
  s.set("parkingCars", "41");
  await s.submit();
  assert.notEqual(
    s.calls[0].payload.p_client_ref,
    s.calls[2].payload.p_client_ref,
  );
  s.el("parkingCancel").click();
  assert.equal(s.el("parkingCorrectionPanel").hidden, true);
});

test("parking validation blocks missing destination, empty counts and excess charged cars", async () => {
  const s = setup();
  s.ui.open("game0");
  s.set("parkingReason", "Corregir un dato mal capturado");
  s.set("parkingDate", "2026-10-16");
  await s.submit();
  assert.match(s.el("parkingFormMessage").textContent, /registra la jornada/);
  s.set("parkingDate", "2026-10-17");
  s.set("parkingCars", "");
  await s.submit();
  assert.match(s.el("parkingFormMessage").textContent, /cantidades enteras/);
  s.set("parkingCars", "38");
  s.set("parkingCharged", "39");
  await s.submit();
  assert.match(s.el("parkingFormMessage").textContent, /no pueden superar/);
  assert.equal(s.calls.length, 0);
});

test("capturista sends a request, and immutable before/after history is escaped and cannot approve itself", async () => {
  const attack = '<img src=x onerror="alert(1)">';
  const s = setup(false);
  s.ui.open("game0");
  assert.match(s.el("parkingCorrectionForm").textContent, /Enviar solicitud/);
  s.set("parkingDate", "2026-10-17");
  s.set("parkingReason", "Fecha corregida por el capturista");
  await s.submit();
  assert.match(s.el("parkingFeedback").textContent, /hasta su aprobación/);
  const before = parkingSnapshot(s.data.games[0], s.data.days);
  s.data.requests = [
    {
      id: "req",
      game_ids: ["game0"],
      requested_name: attack,
      reason: attack,
      requested_at: "2026-10-27T12:00:00Z",
      applied_immediately: false,
      before_data: [before],
      after_data: [{ ...before, date: "2026-10-17", notes: attack }],
    },
  ];
  s.ui.showHistory("game0");
  assert.match(s.el("parkingHistoryLabel").textContent, /1 pendientes/);
  assert.equal(s.document.querySelectorAll("img[src=x],[onerror]").length, 0);
  assert.equal(
    s.document.querySelectorAll("[data-parking-decision]").length,
    0,
  );
  assert(s.el("parkingHistory").textContent.includes(attack));
  s.data.admin = true;
  s.ui.render();
  s.document.querySelector(".parkingDecisionNote").value =
    "Confirmado con el responsable";
  s.document.querySelector('[data-parking-decision="approve"]').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.at(-1).name, "review_parking_correction");
  assert.deepEqual(s.calls.at(-1).payload, {
    p_request: "req",
    p_approve: true,
    p_note: "Confirmado con el responsable",
  });
});
