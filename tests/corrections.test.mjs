import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { initCorrections } from "../lib/corrections.js";
import { businessDate } from "../lib/csv.js";
test("correction form sends the original snapshot, preserves tags and escapes permanent history", async () => {
  const { document, window } = parseHTML(
    '<div id="correctionPanel"></div><div id="correctionHistory"></div>',
  );
  const previous = globalThis.document;
  globalThis.document = document;
  try {
    const day = {
      id: "d",
      date: businessDate(),
      created_by: "u",
      status: "submitted",
      sport: "futbol",
      day_type: "entrenamiento_normal",
      event_name: null,
      event_tags: ["club_puebla"],
      notes: null,
    };
    let sent, message, done;
    const saved = new Promise((resolve) => {
      done = resolve;
    });
    const requests = [];
    const ui = initCorrections({
      client: {
        rpc: async (name, payload) => {
          sent = { name, payload };
          return { data: { id: "request", applied: true } };
        },
      },
      context: () => ({
        me: { id: "u" },
        admin: false,
        days: [day],
        requests,
        decisions: [],
      }),
      refresh: async () => {},
      message: (type, text) => {
        message = { type, text };
        done();
      },
    });
    ui.open("d");
    assert.match(
      document.getElementById("correctionPanel").textContent,
      /se aplicará/,
    );
    document.getElementById("corName").value = "Partido Club Puebla";
    document.getElementById("corReason").value =
      "Me equivoqué al capturar el nombre";
    document
      .getElementById("formCorrection")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await saved;
    assert.equal(sent.name, "request_day_correction");
    assert.equal(sent.payload.p_before.event_name, null);
    assert.deepEqual(sent.payload.p_after.event_tags, ["club_puebla"]);
    assert.equal(message.type, "ok");
    assert.equal(document.getElementById("correctionPanel").hidden, true);
    requests.push({
      id: "r",
      day_id: "d",
      requested_name: "<img src=x onerror=alert(1)>",
      requested_at: new Date().toISOString(),
      applied_immediately: true,
      before_data: sent.payload.p_before,
      after_data: sent.payload.p_after,
      reason: "<script>bad</script>",
    });
    ui.render();
    assert.equal(document.querySelectorAll("img,script").length, 0);
    assert.match(
      document.getElementById("correctionHistory").textContent,
      /Corregido/,
    );
    day.created_by = "other";
    ui.open("d");
    assert.match(
      document.getElementById("correctionPanel").textContent,
      /solicitud a administración/,
    );
  } finally {
    globalThis.document = previous;
  }
});
