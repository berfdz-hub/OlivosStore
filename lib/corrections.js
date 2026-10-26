import { escapeHTML as H } from "./safe.js";
import { businessDate } from "./csv.js";
import { initGroupEditor, groupLabel, validateGroups } from "./event-groups.js";

export const dayMetadata = (day) => ({
  sport: day.sport ?? null,
  day_type: day.day_type ?? null,
  event_name: day.event_name ?? null,
  event_tags: day.event_tags || [],
  notes: day.notes ?? null,
  event_groups: day.event_groups ?? null,
});
const labels = {
  sport: "Deporte",
  day_type: "Categoría",
  event_name: "Nombre del evento",
  event_tags: "Etiquetas",
  notes: "Notas",
  event_groups: "Desglose de eventos",
};
const values = {
  futbol: "Fútbol",
  beisbol: "Béisbol / Softbol",
  otro: "Otro",
  club_puebla: "Club Puebla",
  evento_especial: "Evento especial",
  dia_partido: "Día de partido",
  entrenamiento_normal: "Entrenamiento normal",
};
const display = (value) =>
  Array.isArray(value)
    ? value
        .map((v) => (typeof v === "object" ? groupLabel(v) : values[v] || v))
        .join(", ") || "Sin etiquetas"
    : values[value] || value || "Sin dato";
export function correctionDiff(before, after) {
  return Object.keys(labels)
    .filter(
      (key) =>
        JSON.stringify(before[key] ?? null) !==
        JSON.stringify(after[key] ?? null),
    )
    .map((key) => ({
      field: labels[key],
      before: display(before[key]),
      after: display(after[key]),
    }));
}
const diffHTML = (before, after) =>
  correctionDiff(before, after)
    .map(
      (row) =>
        `<li><b>${H(row.field)}:</b> ${H(row.before)} → ${H(row.after)}</li>`,
    )
    .join("");

export function initCorrections({ client, context, refresh, message }) {
  const panel = document.getElementById("correctionPanel"),
    history = document.getElementById("correctionHistory");
  let editing = null,
    signature = "",
    clientRef = "";
  function open(id) {
    const c = context(),
      day = c.days.find((d) => d.id === id);
    if (!day) return;
    editing = { id, before: dayMetadata(day) };
    const direct =
      day.status !== "reviewed" &&
      (c.admin || (day.created_by === c.me?.id && day.date === businessDate()));
    panel.hidden = false;
    panel.innerHTML = `<h3>Corregir clasificación · ${H(day.date)}</h3><p class="footnote">${direct ? "La corrección se aplicará y quedará registrada." : "Se enviará una solicitud a administración. Los datos actuales se conservarán hasta su aprobación."} Las ventas y el inventario se conservan.</p>
      <form id="formCorrection"><div class="grid grid2">
      <div class="field"><label for="corSport">Deporte</label><select id="corSport">${["futbol", "beisbol", "otro"].map((v) => `<option value="${v}" ${day.sport === v ? "selected" : ""}>${values[v]}</option>`).join("")}</select></div>
      <div class="field"><label for="corType">Categoría</label><select id="corType">${["entrenamiento_normal", "dia_partido", "evento_especial"].map((v) => `<option value="${v}" ${day.day_type === v ? "selected" : ""}>${values[v]}</option>`).join("")}</select></div>
      <div class="field"><label for="corName">Nombre del evento</label><input id="corName" value="${H(day.event_name || "")}" maxlength="300"></div>
      <div class="field"><label for="corNotes">Notas</label><textarea id="corNotes" maxlength="2000">${H(day.notes || "")}</textarea></div></div>
      <fieldset><legend>Etiquetas</legend>${["futbol", "beisbol", "club_puebla", "otro"].map((v) => `<label class="check-option"><input type="checkbox" class="corTag" value="${v}" ${(day.event_tags || []).includes(v) ? "checked" : ""}>${values[v]}</label>`).join("")}</fieldset>
      <details><summary>Desglosar los eventos y equipos de este día</summary><p class="hint">Registra lo que realmente ocurrió. Deja vacío si no hay información. El predictor usará este desglose para comparar días parecidos.</p><div id="corGroups"></div></details>
      <div class="field"><label for="corReason">¿Por qué necesitas corregirlo?</label><textarea id="corReason" required minlength="8" maxlength="1000" placeholder="Ej. Seleccioné entrenamiento al capturar; era un partido de Club Puebla."></textarea></div>
      <div id="corPreview" aria-live="polite"></div><button class="btn" type="submit">${direct ? "Guardar corrección con historial" : "Solicitar corrección"}</button> <button class="btn sec" type="button" id="corCancel">Cancelar</button></form>`;
    const form = document.getElementById("formCorrection");
    const groupEditor = initGroupEditor({
      id: "corGroups",
      groups: day.event_groups || [],
      onChange: () => {
        document.getElementById("corPreview").innerHTML =
          `<ul>${diffHTML(editing.before, after())}</ul>`;
      },
    });
    const after = () => ({
      sport: document.getElementById("corSport").value,
      day_type: document.getElementById("corType").value,
      event_name: document.getElementById("corName").value.trim() || null,
      event_tags: [...form.querySelectorAll(".corTag:checked")].map(
        (i) => i.value,
      ),
      notes: document.getElementById("corNotes").value.trim() || null,
      event_groups: groupEditor.read().length ? groupEditor.read() : null,
    });
    form.addEventListener("input", () => {
      document.getElementById("corPreview").innerHTML =
        `<ul>${diffHTML(editing.before, after()) || "<li>Sin cambios todavía.</li>"}</ul>`;
    });
    document.getElementById("corCancel").addEventListener("click", () => {
      panel.hidden = true;
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const reason = document.getElementById("corReason").value.trim();
        if (reason.length < 8)
          throw new Error("Explica el motivo con al menos 8 caracteres.");
        const proposed = after();
        if (proposed.event_groups) validateGroups(proposed.event_groups);
        if (!correctionDiff(editing.before, proposed).length)
          throw new Error("No hay cambios para guardar.");
        const payload = {
          p_day: editing.id,
          p_after: proposed,
          p_before: editing.before,
          p_reason: reason,
        };
        const next = JSON.stringify(payload);
        if (next !== signature) {
          signature = next;
          clientRef = crypto.randomUUID();
        }
        const { data, error } = await client.rpc("request_day_correction", {
          ...payload,
          p_client_ref: clientRef,
        });
        if (error) throw error;
        if (!data?.id)
          throw new Error(
            "No se confirmó la corrección. Puedes reintentar sin duplicarla.",
          );
        panel.hidden = true;
        signature = "";
        await refresh();
        message(
          "ok",
          data.applied
            ? "Corrección aplicada y registrada en el historial."
            : "Solicitud enviada a administración. La clasificación actual se conserva.",
        );
      } catch (error) {
        message("err", error.message);
      } finally {
        button.disabled = false;
      }
    });
    panel.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }
  function render(dayId = null) {
    const c = context(),
      decisions = new Map(c.decisions.map((d) => [d.correction_id, d]));
    const rows = c.requests
      .filter((r) => !dayId || r.day_id === dayId)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
    history.innerHTML =
      rows
        .map((r) => {
          const decision = decisions.get(r.id),
            day = c.days.find((d) => d.id === r.day_id);
          const status = r.applied_immediately
            ? "Corregido"
            : decision
              ? decision.approved
                ? "Aprobado y corregido"
                : "Rechazado"
              : "Pendiente de aprobación";
          const at = new Date(r.requested_at).toLocaleString("es-MX", {
            timeZone: "America/Mexico_City",
          });
          return `<article class="correction-entry"><b>${H(day?.date || "Día fuera del periodo")} · ${status}</b><p>${H(r.requested_name)} · ${H(at)}</p><ul>${diffHTML(r.before_data, r.after_data)}</ul><p><b>Motivo:</b> ${H(r.reason)}</p>${decision ? `<p><b>${H(decision.decided_name)}:</b> ${H(decision.note)} · ${H(new Date(decision.decided_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" }))}</p>` : ""}${!r.applied_immediately && !decision && c.admin ? `<div data-request="${H(r.id)}"><label>Motivo de la decisión<textarea class="decisionNote" aria-label="Motivo de la decisión" minlength="8" maxlength="1000"></textarea></label>${day?.status === "reviewed" ? '<p class="footnote">Reabre el día para aprobar. Puedes rechazar sin reabrir.</p>' : ""}<button type="button" class="btn sm" data-decision="approve" ${day?.status === "reviewed" ? "disabled" : ""}>Aprobar corrección</button> <button type="button" class="btn sec sm" data-decision="reject">Rechazar</button></div>` : ""}</article>`;
        })
        .join("") ||
      '<p class="footnote">Todavía no hay correcciones registradas.</p>';
  }
  history.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-decision]");
    if (!button) return;
    const row = button.closest("[data-request]"),
      note = row.querySelector(".decisionNote").value.trim();
    if (note.length < 8) {
      message(
        "err",
        "Indica el motivo de la decisión con al menos 8 caracteres.",
      );
      return;
    }
    button.disabled = true;
    try {
      const { error } = await client.rpc("review_day_correction", {
        p_request: row.dataset.request,
        p_approve: button.dataset.decision === "approve",
        p_note: note,
      });
      if (error) throw error;
      await refresh();
      message("ok", "Decisión registrada en el historial.");
    } catch (error) {
      message("err", error.message);
    } finally {
      button.disabled = false;
    }
  });
  return { open, render };
}
