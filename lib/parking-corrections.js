import { escapeHTML as H } from "./safe.js";

const fields = {
  date: "Fecha",
  start_time: "Hora",
  cars_parked: "Autos en el lote",
  cars_charged: "Autos cobrados",
  parking_rate: "Tarifa por auto",
  charges_parking: "Se cobra estacionamiento",
  notes: "Notas",
};
const display = (key, value) => {
  if (value === null || value === "") return "Sin dato";
  if (key === "charges_parking") return value ? "Sí" : "No";
  if (key === "parking_rate") return "$" + Number(value).toFixed(2);
  if (key === "start_time") return String(value).slice(0, 5);
  if (key === "date") {
    const [y, m, d] = String(value).split("-");
    return `${d}/${m}/${y}`;
  }
  return String(value);
};
export function parkingSnapshot(game, days) {
  return {
    id: game.id,
    revision: Number(game.revision),
    date: days.find((d) => d.id === game.sale_day_id)?.date || "",
    start_time: game.start_time,
    cars_parked: Number(game.cars_parked),
    cars_charged: Number(game.cars_charged),
    parking_rate: Number(game.parking_rate),
    charges_parking: game.charges_parking,
    notes: game.notes ?? null,
  };
}
export function parkingDiff(before, after) {
  return Object.keys(fields)
    .filter((k) => before[k] !== after[k])
    .map((key) => ({
      key,
      label: fields[key],
      before: display(key, before[key]),
      after: display(key, after[key]),
    }));
}
const diffHTML = (before, after) =>
  parkingDiff(before, after)
    .map(
      (d) =>
        `<li><b>${H(d.label)}:</b> ${H(d.before)} → <strong>${H(d.after)}</strong></li>`,
    )
    .join("");

export function initParkingCorrections({
  client,
  context,
  refresh,
  root = document,
}) {
  const el = (id) => root.getElementById(id);
  const panel = el("parkingCorrectionPanel"),
    history = el("parkingHistory");
  let editing = [],
    mode = "single",
    signature = "",
    clientRef = "",
    historyGame = null;
  const message = (kind, text) => {
    el("parkingFeedback").innerHTML =
      `<div class="msg ${kind}" role="status">${H(text)}</div>`;
  };
  const snapshots = () =>
    context().games.map((g) => parkingSnapshot(g, context().days));
  const field = (id, label, type, value, attrs = "") =>
    `<label class="field" for="${id}">${label}<input id="${id}" type="${type}" value="${H(value ?? "")}" ${attrs}></label>`;
  function readAfter(before) {
    const after = { ...before, date: el("parkingDate").value };
    if (mode === "single")
      Object.assign(after, {
        start_time:
          el("parkingTime").value.length === 5
            ? el("parkingTime").value + ":00"
            : el("parkingTime").value,
        cars_parked:
          el("parkingCars").value === ""
            ? null
            : Number(el("parkingCars").value),
        cars_charged:
          el("parkingCharged").value === ""
            ? null
            : Number(el("parkingCharged").value),
        parking_rate:
          el("parkingRate").value === ""
            ? null
            : Number(el("parkingRate").value),
        charges_parking: el("parkingCharges").checked,
        notes: el("parkingNotes").value.trim() || null,
      });
    delete after.id;
    delete after.revision;
    return after;
  }
  function preview() {
    el("parkingPreview").innerHTML =
      editing
        .map((before) => {
          const diff = diffHTML(before, readAfter(before));
          return diff
            ? `<div><b>${H(display("date", before.date))} · ${H(display("start_time", before.start_time))}</b><ul>${diff}</ul></div>`
            : "";
        })
        .join("") || '<p class="hint">Elige qué necesitas corregir.</p>';
  }
  function open(gameId = null, sourceDate = null) {
    const c = context(),
      all = snapshots();
    mode = gameId ? "single" : "date";
    editing = gameId
      ? all.filter((g) => g.id === gameId)
      : all.filter(
          (g) =>
            g.date ===
            (sourceDate ||
              [...all].sort((a, b) => b.date.localeCompare(a.date))[0]?.date),
        );
    if (!editing.length) {
      message("err", "No hay estacionamiento cargado para corregir.");
      return;
    }
    signature = "";
    clientRef = "";
    el("parkingFeedback").textContent = "";
    const first = editing[0],
      dates = [...new Set(all.map((g) => g.date))].sort().reverse();
    const closed = c.days.some(
      (d) => d.status === "reviewed" && editing.some((g) => g.date === d.date),
    );
    panel.hidden = false;
    panel.innerHTML = `<h3 id="parkingCorrectionTitle">${gameId ? "Corregir estacionamiento" : "Cambiar fecha de estacionamiento"}</h3>
      <p class="hint">${c.admin ? "El cambio se aplicará con tu nombre y motivo." : "Administración revisará tu solicitud antes de cambiar los datos."} Las ventas y actividades conservan su fecha.</p>
      <form id="parkingCorrectionForm">
      ${
        !gameId
          ? `<label class="field" for="parkingSource">Fecha capturada<select id="parkingSource">${dates.map((date) => `<option value="${H(date)}" ${date === first.date ? "selected" : ""}>${H(display("date", date))} · ${all.filter((g) => g.date === date).length} registros</option>`).join("")}</select></label>
      <p class="parking-move-summary">Se moverán <b>${editing.length} registros</b>: ${editing.map((g) => `${H(display("start_time", g.start_time))} (${g.cars_parked} autos)`).join(" · ")}.</p>`
          : `<p><b>Registro actual:</b> ${H(display("date", first.date))} · ${H(display("start_time", first.start_time))}</p>`
      }
      <div class="grid grid2">${field("parkingDate", "Fecha correcta", "date", first.date, "required")}
      ${
        gameId
          ? field(
              "parkingTime",
              "Hora de inicio",
              "time",
              first.start_time,
              'required step="1"',
            ) +
            field(
              "parkingCars",
              "Autos en el lote",
              "number",
              first.cars_parked,
              'required min="0" max="1000000" step="1"',
            ) +
            field(
              "parkingCharged",
              "Autos cobrados",
              "number",
              first.cars_charged,
              'required min="0" max="1000000" step="1"',
            ) +
            field(
              "parkingRate",
              "Tarifa por auto",
              "number",
              first.parking_rate,
              'required min="0" max="1000000" step="0.01"',
            ) +
            `<label class="parking-charge-toggle"><input id="parkingCharges" type="checkbox" ${first.charges_parking ? "checked" : ""}> Se cobró estacionamiento</label>`
          : ""
      }</div>
      <p class="hint">La fecha destino debe tener una jornada registrada. Si está cerrada, administración deberá reabrirla antes de aplicar el cambio.</p>
      ${gameId ? `<label class="field" for="parkingNotes">Notas (opcional)<textarea id="parkingNotes" maxlength="2000">${H(first.notes || "")}</textarea></label>` : ""}
      <div class="parking-change-preview"><b>Así quedará el cambio</b><div id="parkingPreview" aria-live="polite"></div></div>
      <label class="field" for="parkingReason">Motivo de la corrección<textarea id="parkingReason" minlength="8" maxlength="1000" required placeholder="Ejemplo: se capturó en el día equivocado"></textarea></label>
      ${closed && c.admin ? '<p class="msg warn">La jornada está cerrada. Reábrela desde Jornadas antes de guardar.</p>' : ""}
      <div class="row-actions"><button class="btn" type="submit">${c.admin ? "Guardar corrección" : "Enviar solicitud"}</button><button class="btn sec" id="parkingCancel" type="button">Cancelar</button></div>
      <p id="parkingFormMessage" role="status"></p></form>`;
    el("parkingSource")?.addEventListener("change", () =>
      open(null, el("parkingSource").value),
    );
    el("parkingCancel").addEventListener("click", () => {
      panel.hidden = true;
    });
    el("parkingCorrectionForm").addEventListener("input", preview);
    el("parkingCorrectionForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = e.currentTarget.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const reason = el("parkingReason").value.trim();
        if (reason.length < 8 || reason.length > 1000)
          throw Error("Explica el motivo con 8 a 1000 caracteres.");
        const changes = editing.map((before) => ({
          before,
          after: readAfter(before),
        }));
        if (!changes.some((x) => parkingDiff(x.before, x.after).length))
          throw Error("No hay cambios para guardar.");
        for (const { after } of changes) {
          if (!context().days.some((d) => d.date === after.date))
            throw Error("Primero registra la jornada de la fecha destino.");
          if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(after.start_time))
            throw Error("Revisa la hora de inicio.");
          if (
            ![after.cars_parked, after.cars_charged].every(
              (v) => Number.isInteger(v) && v >= 0 && v <= 1000000,
            ) ||
            after.cars_charged > after.cars_parked
          )
            throw Error(
              "Los autos cobrados no pueden superar los autos del lote. Usa cantidades enteras.",
            );
          if (
            after.parking_rate === null ||
            !Number.isFinite(after.parking_rate) ||
            after.parking_rate < 0 ||
            after.parking_rate > 1000000
          )
            throw Error("Revisa la tarifa por auto.");
        }
        const payload = { p_changes: changes, p_reason: reason },
          next = JSON.stringify(payload);
        if (signature !== next) {
          signature = next;
          clientRef = crypto.randomUUID();
        }
        const { data, error } = await client.rpc("request_parking_correction", {
          ...payload,
          p_client_ref: clientRef,
        });
        if (error) throw error;
        if (!data?.id)
          throw Error(
            "No se confirmó el cambio. Puedes reintentar sin duplicarlo.",
          );
        panel.hidden = true;
        signature = "";
        await refresh();
        render();
        message(
          "ok",
          data.applied
            ? "Estacionamiento corregido. El motivo y los valores anteriores quedaron en el historial."
            : "Solicitud enviada a administración. Los datos se conservan hasta su aprobación.",
        );
      } catch (error) {
        el("parkingFormMessage").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    preview();
    panel.scrollIntoView?.({ behavior: "smooth", block: "start" });
    el("parkingDate").focus();
  }
  function render() {
    const c = context(),
      decisions = new Map(c.decisions.map((d) => [d.correction_id, d]));
    const pending = c.requests.filter(
      (r) => !r.applied_immediately && !decisions.has(r.id),
    ).length;
    el("parkingHistoryLabel").textContent =
      `Correcciones e historial${pending ? ` · ${pending} pendientes` : ""}`;
    const rows = c.requests
      .filter((r) => !historyGame || r.game_ids.includes(historyGame))
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
    history.innerHTML =
      (historyGame
        ? '<button type="button" class="btn sec sm" data-parking-history-all>Ver todos los cambios</button>'
        : "") +
      (rows
        .map((r) => {
          const decision = decisions.get(r.id),
            pending = !r.applied_immediately && !decision;
          const status = r.applied_immediately
            ? "Corregido"
            : decision
              ? decision.approved
                ? "Aprobado y corregido"
                : "Rechazado"
              : "Pendiente de aprobación";
          const timestamp = (date) =>
            new Date(date).toLocaleString("es-MX", {
              timeZone: "America/Mexico_City",
            });
          return `<article class="correction-entry"><h4>${status} · ${r.game_ids.length} registro(s)</h4><p>${H(r.requested_name)} · ${H(timestamp(r.requested_at))}</p>${r.before_data
            .map((before) => {
              const after = r.after_data.find((a) => a.id === before.id);
              return `<b>${H(display("date", before.date))} · ${H(display("start_time", before.start_time))}</b><ul>${diffHTML(before, after)}</ul>`;
            })
            .join(
              "",
            )}<p><b>Motivo:</b> ${H(r.reason)}</p>${decision ? `<p><b>${H(decision.decided_name)}:</b> ${H(decision.note)} · ${H(timestamp(decision.decided_at))}</p>` : ""}
      ${pending && c.admin ? `<div data-parking-request="${H(r.id)}"><label class="field">Motivo de la decisión<textarea class="parkingDecisionNote" aria-label="Motivo de la decisión" minlength="8" maxlength="1000"></textarea></label><div class="row-actions"><button type="button" class="btn sm" data-parking-decision="approve">Aprobar corrección</button><button type="button" class="btn sec sm" data-parking-decision="reject">Rechazar</button></div></div>` : ""}</article>`;
        })
        .join("") ||
        '<p class="hint">Todavía no hay correcciones visibles para tu cuenta.</p>');
  }
  function showHistory(gameId = null) {
    historyGame = gameId;
    render();
    el("parkingHistorySection").open = true;
    el("parkingHistorySection").scrollIntoView?.({
      behavior: "smooth",
      block: "start",
    });
  }
  history.addEventListener("click", async (e) => {
    if (e.target.closest("[data-parking-history-all]")) return showHistory();
    const button = e.target.closest("[data-parking-decision]");
    if (!button) return;
    const row = button.closest("[data-parking-request]"),
      note = row.querySelector(".parkingDecisionNote").value.trim();
    if (note.length < 8) {
      message(
        "err",
        "Explica el motivo de la decisión con al menos 8 caracteres.",
      );
      return;
    }
    button.disabled = true;
    try {
      const { error } = await client.rpc("review_parking_correction", {
        p_request: row.dataset.parkingRequest,
        p_approve: button.dataset.parkingDecision === "approve",
        p_note: note,
      });
      if (error) throw error;
      await refresh();
      render();
      message("ok", "Decisión registrada en el historial.");
    } catch (error) {
      message("err", error.message);
    } finally {
      button.disabled = false;
    }
  });
  el("parkingMoveDay").addEventListener("click", () => open());
  return { open, render, showHistory };
}
