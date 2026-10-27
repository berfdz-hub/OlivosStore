import { businessDate, parseBusinessDate } from "./csv.js";
import { escapeHTML as H, selectAll } from "./safe.js";
import {
  initGroupEditor,
  groupLabel,
  totalGames,
  validateGroups,
} from "./event-groups.js";
import {
  scheduledActivity,
  activitiesForDate,
  actualActivities,
} from "./schedule.js";

export function initJourneys({
  client,
  admin,
  onChange,
  onPurchase,
  root = document,
}) {
  const el = (id) => root.getElementById(id);
  let rows = [],
    selected = businessDate(),
    month = selected.slice(0, 7),
    editing = null,
    busy = false;
  let request = crypto.randomUUID(),
    duplicateRequest = crypto.randomUUID();
  let compact =
    typeof matchMedia === "function" &&
    matchMedia("(max-width: 700px)").matches;
  const editor = initGroupEditor({ root, id: "journeyEditor" });
  const message = (text, error = false) => {
    el("journeyMsg").textContent = text;
    el("journeyMsg").className = error ? "msg err" : "msg ok";
  };
  const dateLabel = (date) =>
    new Intl.DateTimeFormat("es-MX", {
      dateStyle: "full",
      timeZone: "America/Mexico_City",
    }).format(parseBusinessDate(date + "T12:00"));
  function render() {
    el("journeyDate").value = selected;
    el("journeyMonth").textContent = new Intl.DateTimeFormat("es-MX", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(month + "-01T12:00Z"));
    el("journeyTitle").textContent = dateLabel(selected);
    el("journeyCapture").href = "operador.html?date=" + selected;
    el("journeyBuy").disabled = selected < businessDate();
    el("journeyPastHint").hidden = selected >= businessDate();
    const dayRows = rows.filter(
      (r) => r.date === selected && r.status !== "cancelled",
    );
    const games = totalGames(activitiesForDate(rows, selected));
    el("journeyTotal").textContent = dayRows.length
      ? `${dayRows.length} ${dayRows.length === 1 ? "actividad" : "actividades"} · ${games == null ? "Partidos por confirmar" : games + " partidos"}`
      : "Sin actividades agendadas";
    el("journeyActivities").innerHTML =
      dayRows
        .map(
          (r) =>
            `<article class="journey-activity"><div><h3>${H(groupLabel(scheduledActivity(r)))}</h3>${r.notes ? `<p>${H(r.notes)}</p>` : ""}<span class="source-badge">Agendado</span></div>${admin ? `<div class="row-actions"><button type="button" class="btn sec sm" data-journey-edit="${H(r.id)}">Editar</button><button type="button" class="btn sec sm" data-journey-cancel="${H(r.id)}">Cancelar actividad</button></div>` : ""}</article>`,
        )
        .join("") ||
      `<p class="empty-state">Todavía no hay actividades. ${admin ? "Puedes agendarlas o empezar una compra y agregarlas ahí." : "Puedes empezar una compra y agregarlas ahí, o pedir a administración que las agende."}</p>`;
    el("journeyDuplicateOpen").disabled = !dayRows.length;
    el("journeyCalendar").classList.toggle("as-list", compact);
    el("journeyView").textContent = compact
      ? "Ver mes completo"
      : "Ver como lista";
    const first = new Date(month + "-01T12:00Z"),
      count = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
      ).getUTCDate(),
      offset = (first.getUTCDay() + 6) % 7;
    el("journeyCalendar").innerHTML =
      (compact
        ? ""
        : ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
            .map((d) => `<span class="calendar-weekday">${d}</span>`)
            .join("") +
          Array.from(
            { length: offset },
            () => '<span aria-hidden="true"></span>',
          ).join("")) +
      Array.from({ length: count }, (_, i) => {
        const d = month + "-" + String(i + 1).padStart(2, "0"),
          a = activitiesForDate(rows, d),
          n = totalGames(a);
        if (compact && !a.length && d !== selected) return "";
        return `<button type="button" data-journey-date="${d}" class="calendar-day ${selected === d ? "selected" : ""} ${a.length ? "has-activities" : ""}" aria-pressed="${selected === d}" aria-label="${H(dateLabel(d))}, ${a.length} ${a.length === 1 ? "actividad" : "actividades"}"><span>${compact ? H(new Intl.DateTimeFormat("es-MX", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(d + "T12:00Z"))) : i + 1}</span><small>${a.length ? (compact ? `${n == null ? "?" : n} partidos · ${a.length} actividades` : `${n == null ? "?" : n} part.`) : compact ? "Sin actividades" : ""}</small></button>`;
      }).join("");
    if (!el("journeyCalendar").textContent)
      el("journeyCalendar").innerHTML =
        '<p class="hint">Sin actividades. Elige una fecha para comenzar.</p>';
    root.querySelectorAll("[data-calendar-admin]").forEach((n) => {
      n.hidden = !admin;
    });
  }
  async function load() {
    rows = await selectAll(client, "scheduled_games", "*");
    render();
    onChange(rows);
  }
  function closeEditor() {
    el("journeyForm").hidden = true;
    editing = null;
    editor.set([]);
  }
  function choose(date) {
    closeEditor();
    el("journeyDuplicate").hidden = true;
    el("journeyHistory").open = false;
    selected = date;
    month = date.slice(0, 7);
    render();
  }
  function openEditor(row = null, cancel = false) {
    editing = row;
    request = crypto.randomUUID();
    el("journeyForm").hidden = false;
    el("journeyForm").classList.toggle("editing-one", !!row);
    el("journeyEditTitle").textContent = cancel
      ? "Cancelar actividad"
      : row
        ? "Editar actividad"
        : "Agregar actividades";
    el("journeyCancelFlag").value = cancel ? "yes" : "";
    el("journeyEditor").hidden = cancel;
    editor.set(row ? actualActivities([scheduledActivity(row)]) : []);
    el("journeyNotes").value = row?.notes || "";
    el("journeyReason").value = "";
    el("journeyReason").required = !!row;
    el("journeyReasonField").hidden = !row;
    el("journeySave").textContent = cancel
      ? "Confirmar cancelación"
      : "Guardar en calendario";
    el("journeyForm").scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
    });
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    root.querySelectorAll("#pane-jornadas button").forEach((b) => {
      b.disabled = true;
    });
    try {
      await fn();
    } catch (e) {
      message(e.message, true);
    } finally {
      busy = false;
      root.querySelectorAll("#pane-jornadas button").forEach((b) => {
        b.disabled = false;
      });
      render();
    }
  }
  el("journeyDate").addEventListener("change", () => {
    if (parseBusinessDate(el("journeyDate").value + "T12:00"))
      choose(el("journeyDate").value);
  });
  el("journeyToday").addEventListener("click", () => choose(businessDate()));
  for (const [id, delta] of [
    ["journeyPrev", -1],
    ["journeyNext", 1],
  ])
    el(id).addEventListener("click", () => {
      const d = new Date(month + "-01T12:00Z");
      d.setUTCMonth(d.getUTCMonth() + delta);
      month = d.toISOString().slice(0, 7);
      render();
    });
  el("journeyView").addEventListener("click", () => {
    compact = !compact;
    render();
  });
  el("journeyRefresh").addEventListener("click", () =>
    run(async () => {
      await load();
      message("Calendario actualizado.");
    }),
  );
  el("journeyCalendar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-journey-date]");
    if (b) choose(b.dataset.journeyDate);
  });
  el("journeyAdd").addEventListener("click", () => openEditor());
  el("journeyClose").addEventListener("click", closeEditor);
  el("journeyActivities").addEventListener("click", (e) => {
    const b = e.target.closest("[data-journey-edit], [data-journey-cancel]");
    if (b)
      openEditor(
        rows.find(
          (r) => r.id === (b.dataset.journeyEdit || b.dataset.journeyCancel),
        ),
        !!b.dataset.journeyCancel,
      );
  });
  el("journeyForm").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      const cancelling = el("journeyCancelFlag").value === "yes";
      const activities = cancelling
        ? [scheduledActivity(editing)]
        : validateGroups(editor.read());
      if (editing && activities.length !== 1)
        throw Error(
          "Edita una actividad a la vez. Usa Agregar actividades para agendar otras.",
        );
      const { error } = await client.rpc("save_scheduled_activities", {
        p_date: selected,
        p_activities: actualActivities(activities),
        p_notes: el("journeyNotes").value.trim(),
        p_id: editing?.id || null,
        p_version: editing?.version || 1,
        p_cancel: cancelling,
        p_reason: el("journeyReason").value.trim(),
        p_client_ref: request,
      });
      if (error) throw error;
      closeEditor();
      request = crypto.randomUUID();
      await load();
      message(
        cancelling
          ? "Actividad cancelada. El historial se conserva."
          : "Calendario guardado.",
      );
    });
  });
  el("journeyBuy").addEventListener("click", () =>
    run(async () => {
      await load();
      onPurchase(selected);
    }),
  );
  el("journeyDuplicateOpen").addEventListener("click", () => {
    duplicateRequest = crypto.randomUUID();
    el("journeyDuplicate").hidden = false;
    el("journeyCopyDate").value = "";
  });
  el("journeyDuplicateClose").addEventListener("click", () => {
    el("journeyDuplicate").hidden = true;
  });
  el("journeyDuplicate").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      const to = el("journeyCopyDate").value;
      if (to === selected) throw Error("Elige otra fecha para la copia.");
      const { error } = await client.rpc("duplicate_scheduled_day", {
        p_source: selected,
        p_target: to,
        p_client_ref: duplicateRequest,
      });
      if (error) throw error;
      choose(to);
      await load();
      message("Actividades copiadas. Revisa sus horas en la nueva fecha.");
    });
  });
  el("journeyHistory").addEventListener("toggle", () => {
    if (!el("journeyHistory").open || !admin) return;
    run(async () => {
      const ids = rows.filter((r) => r.date === selected).map((r) => r.id),
        data = [];
      for (let i = 0; i < ids.length; i += 80)
        data.push(
          ...(await selectAll(
            client,
            "audit_log",
            "occurred_at,actor,operation,before_data,after_data",
            (q) =>
              q
                .eq("table_name", "scheduled_games")
                .in("record_id", ids.slice(i, i + 80)),
          )),
        );
      data.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
      el("journeyHistoryRows").innerHTML =
        (data || [])
          .filter((a) => (a.after_data || a.before_data)?.date === selected)
          .map((a) => {
            const r = a.after_data || a.before_data;
            return `<li><strong>${H(a.operation === "INSERT" ? "Agendada" : r.status === "cancelled" ? "Cancelada" : "Editada")}</strong> · ${H(new Date(a.occurred_at).toLocaleString("es-MX"))}<p>${H(groupLabel(scheduledActivity(r)))}</p>${a.before_data ? `<p>Antes: ${H(groupLabel(scheduledActivity(a.before_data)))}</p>` : ""}<p>${H(r.change_reason || "Alta en calendario")} · Usuario ${H(a.actor || "sistema")}</p></li>`;
          })
          .join("") || "<li>No hay cambios registrados para esta fecha.</li>";
    });
  });
  render();
  return { load, rows: () => rows, choose };
}
