import { supabase } from "./supabase-client.js";
import { requireRole, signOut, getCurrentProfile } from "./auth.js";
import {
  parseReceipts,
  parseInventory,
  businessDate,
  parseBusinessDate,
  normalizedName,
} from "./csv.js";
import { escapeHTML as H, selectAll, associateLabels } from "./safe.js";
import { checkSchema, saveDay } from "./importer.js";
import { initGroupEditor, validateGroups, totalGames } from "./event-groups.js";
const captureGroups = initGroupEditor({ id: "captureGroups" });
let INVENTORY_INPUTS = [];
const READERS = new Map();
const FILE_ERRORS = new Set();
let SAVING = false;
function syncSaveButton() {
  document.getElementById("btnSave").disabled =
    SAVING || READERS.size > 0 || FILE_ERRORS.size > 0;
}
function cancelReader(kind) {
  const previous = READERS.get(kind);
  READERS.delete(kind);
  if (previous?.readyState === 1) previous.abort();
  FILE_ERRORS.delete(kind);
  syncSaveButton();
}
function finishReader(kind, reader) {
  if (READERS.get(kind) !== reader) return;
  READERS.delete(kind);
  syncSaveButton();
}
function businessNow() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .replace(" ", "T");
}
associateLabels();
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  if (b.dataset.action === "logout") signOut();
  if (b.dataset.action === "addGame") addGame();
});

window.doLogout = signOut;

let CATALOG = [];
let PARSED_TICKETS = null;
let PARSED_DAYS = null; // [{date, tickets:[], venta}] cuando el CSV trae mas de un dia
let PARSED_INVENTORY = null;
let CURRENT_PROFILE = null;

function localISODate(date = new Date()) {
  return businessDate(date);
}

function checkedTags(root) {
  return [...root.querySelectorAll('input[type="checkbox"]:checked')].map(
    (input) => input.value,
  );
}

function setCheckedTags(root, values) {
  const selected = new Set(values);
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function eventTagChecks(className, values = []) {
  const selected = new Set(values);
  const options = [
    ["futbol", "Fútbol"],
    ["beisbol", "Béisbol"],
    ["club_puebla", "Club Puebla"],
    ["otro", "Otro"],
  ];
  return `<div class="check-group compact">${options
    .map(
      ([value, label]) =>
        `<label class="check-option"><input type="checkbox" class="${className}" value="${value}" ${selected.has(value) ? "checked" : ""}> ${label}</label>`,
    )
    .join("")}</div>`;
}

function addGame(hora = "", ap = "", ac = "", cobra = true, nota = "") {
  const wrap = document.createElement("div");
  wrap.style.border = "1px solid var(--line)";
  wrap.style.borderRadius = "8px";
  wrap.style.padding = "12px";
  wrap.style.marginBottom = "10px";
  wrap.innerHTML = `
    <div class="grid grid3">
      <div class="field" style="margin-bottom:0"><label>Hora de inicio</label><input type="time" aria-label="Hora de inicio" class="gHora" value="${H(hora)}"></div>
      <div class="field" style="margin-bottom:0"><label>Autos en el lote</label><input type="number" aria-label="Autos en el lote" class="gAutosP" min="0" value="${ap}"></div>
      <div class="field" style="margin-bottom:0"><label>Autos cobrados</label><input type="number" aria-label="Autos cobrados" class="gAutosC" min="0" value="${ac}"></div>
    </div>
    <div style="display:flex;gap:14px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin:0"><input type="checkbox" class="gCobra" ${cobra ? "checked" : ""}> Se cobra estacionamiento</label>
      <input type="text" aria-label="Nota del partido" class="gNota" placeholder="Nota (ej. amistoso entre semana, liga...)" value="${H(nota)}" style="flex:1;min-width:180px;padding:6px 10px">
      <button type="button" class="btn sec sm gQuitar" style="margin:0">Quitar</button>
    </div>
  `;
  const cobraBox = wrap.querySelector(".gCobra");
  const acInput = wrap.querySelector(".gAutosC");
  const syncCobra = () => {
    acInput.disabled = !cobraBox.checked;
    if (!cobraBox.checked) acInput.value = 0;
  };
  cobraBox.addEventListener("change", syncCobra);
  syncCobra();
  wrap.querySelector(".gQuitar").onclick = () => wrap.remove();
  document.getElementById("games").appendChild(wrap);
}
window.addGame = addGame;

function getGames() {
  return [...document.getElementById("games").children]
    .map((row) => {
      const hora = row.querySelector(".gHora").value;
      const ap = parseInt(row.querySelector(".gAutosP").value) || 0;
      const cobra = row.querySelector(".gCobra").checked;
      const ac = cobra ? parseInt(row.querySelector(".gAutosC").value) || 0 : 0;
      const nota = row.querySelector(".gNota").value.trim();
      return { hora, ap, ac, cobra, nota };
    })
    .filter((g) => g.hora);
}

function updateDayLabel() {
  const v = document.getElementById("fDate").value;
  const el = document.getElementById("fDateDay");
  if (!v) {
    el.textContent = "";
    return;
  }
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay(); // 0 dom .. 6 sab
  const nombre = dt.toLocaleDateString("es-MX", { weekday: "long" });
  const esFinde = dow === 0 || dow === 6;
  el.textContent = esFinde
    ? `${nombre} (fin de semana)`
    : `${nombre} (entre semana)`;
}

function msg(type, html) {
  document.getElementById("msgBox").innerHTML =
    `<div class="msg ${type}">${html}</div>`;
}
const money = (n) =>
  "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });

function renderInventoryInputs() {
  const old = new Map(
    [...document.querySelectorAll(".invCount")].map((i) => [
      i.dataset.key,
      i.value,
    ]),
  );
  const imported = PARSED_INVENTORY || [];
  INVENTORY_INPUTS = CATALOG.map((p) => ({
    product_id: p.id,
    raw: p.name,
    sell_price: p.sell_price,
    external_ref: p.external_ref,
    category: p.category,
  }));
  for (const count of imported) {
    const index = INVENTORY_INPUTS.findIndex(
      (p) =>
        (p.product_id === count.product_id && count.product_id) ||
        normalizedName(p.raw) === normalizedName(count.raw),
    );
    if (index >= 0)
      INVENTORY_INPUTS[index] = { ...INVENTORY_INPUTS[index], ...count };
    else INVENTORY_INPUTS.push(count);
  }
  document.querySelector("#tblInv tbody").innerHTML = INVENTORY_INPUTS.map(
    (p, i) =>
      "<tr><td>" +
      H(p.raw) +
      '</td><td><input type="number" min="0" step="0.001" class="invCount" data-index="' +
      i +
      '" data-key="' +
      H(p.product_id || p.raw) +
      '" data-source="' +
      (p.physical_count != null ? "pos" : "manual") +
      '" value="' +
      H(p.physical_count ?? old.get(p.product_id || p.raw) ?? "") +
      '" aria-label="Conteo de ' +
      H(p.raw) +
      '"></td></tr>',
  ).join("");
  document.querySelectorAll(".invCount").forEach((i) =>
    i.addEventListener("input", () => {
      i.dataset.source = "manual";
    }),
  );
}
async function reloadCatalog() {
  CATALOG = await selectAll(
    supabase,
    "products_view",
    "id,name,category,sell_price,external_ref",
    (q) => q.eq("active", true),
  );
  renderInventoryInputs();
}

async function init() {
  const profile = await requireRole(["operador", "admin"]);
  if (!profile) return;
  CURRENT_PROFILE = profile;
  await checkSchema(supabase);
  document.getElementById("replaceReceiptWrap").hidden =
    profile.role !== "admin";
  document.getElementById("fCountAt").value = businessNow();
  document.getElementById("whoName").textContent =
    profile.full_name || profile.email;
  if (profile.role === "admin") {
    const pill = document.getElementById("rolePill");
    pill.textContent = "ADMIN";
    pill.classList.add("admin");
  }

  document.getElementById("fDate").value = localISODate();
  addGame();
  updateDayLabel();
  document.getElementById("fDate").addEventListener("change", () => {
    updateDayLabel();
    document.getElementById("fCountAt").value =
      document.getElementById("fDate").value === localISODate()
        ? businessNow()
        : "";
    checkExistingDate();
  });

  try {
    await reloadCatalog();
  } catch (error) {
    msg("err", H(error.message));
    document.getElementById("btnSave").disabled = true;
    return;
  }

  document.getElementById("fCsv").addEventListener("change", onCsvChange);
  document
    .getElementById("fInventoryCsv")
    .addEventListener("change", onInventoryCsvChange);
  document.getElementById("formDay").addEventListener("submit", onSubmit);
  wireApplyAll();

  loadDays(profile);
  showWeekendNotice();
  checkExistingDate();
}

async function findDayByDate(date) {
  if (!date) return null;
  const { data, error } = await supabase
    .from("sale_days")
    .select("id,date,sport,status")
    .eq("date", date)
    .maybeSingle();
  if (error)
    throw new Error("No pude revisar si la fecha ya existe: " + error.message);
  return data;
}

async function checkExistingDate() {
  const date = document.getElementById("fDate").value;
  const el = document.getElementById("existingDayNotice");
  if (!date) {
    el.innerHTML = "";
    return;
  }
  try {
    const day = await findDayByDate(date);
    el.innerHTML = day
      ? '<div class="msg info" style="margin-top:12px"><b>Esta fecha ya tiene ventas registradas.</b> Puedes completar aquí sus partidos, autos y estacionamiento. Las ventas existentes se conservarán.</div>'
      : "";
  } catch (_) {
    el.innerHTML = "";
  }
}

async function showWeekendNotice() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const satOffset = dow === 6 ? 0 : dow === 0 ? -1 : 6 - dow;
  const sat = new Date(today);
  sat.setDate(today.getDate() + satOffset);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);
  const satISO = localISODate(sat),
    sunISO = localISODate(sun);

  const { data, error } = await supabase
    .from("scheduled_games")
    .select("date, start_time, sport, notes")
    .in("date", [satISO, sunISO])
    .order("start_time");
  const el = document.getElementById("weekendNotice");
  if (error || !data) {
    el.innerHTML = "";
    return;
  }
  const sportLabel = {
    futbol: "Fútbol",
    beisbol: "Béisbol / Softbol",
    otro: "Otro",
  };
  if (data.length) {
    el.innerHTML = `<div class="msg ok">Este fin de semana (${satISO} y ${sunISO}) hay <b>${data.length}</b> partido(s) agendado(s): ${data
      .map(
        (g) =>
          `${g.date === satISO ? "sáb" : "dom"} ${g.start_time} ${H(sportLabel[g.sport] || g.sport)}${H(g.notes ? " — " + g.notes : "")}`,
      )
      .join("; ")}. <a href="reportes.html">Ver/editar calendario</a></div>`;
  } else {
    el.innerHTML = `<div class="msg warn">No hay partidos agendados para este fin de semana todavía. <a href="reportes.html">Agendar en el calendario</a></div>`;
  }
}

function onCsvChange(e) {
  cancelReader("receipts");
  PARSED_TICKETS = null;
  PARSED_DAYS = null;
  document.getElementById("cardMultiDay").classList.add("hide");
  document.getElementById("cardInv").classList.remove("hide");
  document.getElementById("btnSave").textContent = "Guardar día";
  const f = e.target.files[0];
  if (!f) {
    PARSED_TICKETS = null;
    PARSED_DAYS = null;
    document.getElementById("csvSummary").textContent = "";
    return;
  }
  const reader = new FileReader();
  READERS.set("receipts", reader);
  syncSaveButton();
  reader.onload = async () => {
    if (READERS.get("receipts") !== reader) return;
    try {
      const parsed = parseReceipts(reader.result, CATALOG);
      const { tickets, unmatched, descartados } = parsed;
      PARSED_TICKETS = tickets;
      const venta = tickets.reduce((s, t) => s + t.amount, 0);
      let html = `<div class="msg ok"><b>${tickets.length}</b> tickets leídos, venta total <b>${money(venta)}</b>.`;
      if (descartados)
        html += ` (${descartados} filas omitidas: tipo de recibo no reconocido)`;
      html += `</div>`;
      if (unmatched.length) {
        html += `<div class="msg warn"><b>${unmatched.length} producto(s) no pudieron vincularse al catálogo.</b> Se identificarán por nombre exacto al guardar. Los productos con precio se crearán dentro de la misma operación:<br>${unmatched.map(H).join(", ")}</div>`;
      }

      const byDate = new Map();
      tickets.forEach((t) => {
        // Conserva la fecha comercial escrita por Loyverse. Cortar el ISO en
        // UTC movía al día siguiente las ventas nocturnas de México.
        const d = t.sale_date || localISODate(new Date(t.ts));
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(t);
      });
      const distinctDates = [...byDate.keys()].sort();

      if (distinctDates.length > 1) {
        PARSED_DAYS = distinctDates.map((date) => ({
          date,
          tickets: byDate.get(date),
          venta: byDate.get(date).reduce((s, t) => s + t.amount, 0),
        }));
        flagStrongSaleDays(PARSED_DAYS);
        const nFlagged = PARSED_DAYS.filter((d) => d.flag).length;
        html += `<div class="msg ok">Este archivo trae <b>${distinctDates.length} días distintos</b> (${distinctDates[0]} a ${distinctDates[distinctDates.length - 1]})`;
        html += nFlagged
          ? ` — <b>${nFlagged}</b> se marcaron con ⚡ por venta fuera de lo normal, revísalos abajo. El resto ya quedó como entrenamiento normal.</div>`
          : ` — ninguno se ve fuera de lo normal, ya quedaron como entrenamiento normal. Ajusta el deporte si hace falta.</div>`;
        renderMultiDayTable();
        document.getElementById("cardMultiDay").classList.remove("hide");
        document.getElementById("cardInv").classList.add("hide");
        document.getElementById("btnSave").textContent =
          `Guardar ${distinctDates.length} días`;
      } else {
        PARSED_DAYS = null;
        document.getElementById("cardMultiDay").classList.add("hide");
        document.getElementById("cardInv").classList.remove("hide");
        document.getElementById("btnSave").textContent = "Guardar día";
        if (
          distinctDates.length === 1 &&
          distinctDates[0] !== document.getElementById("fDate").value
        ) {
          document.getElementById("fDate").value = distinctDates[0];
          if (distinctDates[0] !== localISODate())
            document.getElementById("fCountAt").value = "";
          updateDayLabel();
          checkExistingDate();
        }
      }
      if (parsed.warnings.length)
        html +=
          '<div class="msg warn">' +
          parsed.warnings.map(H).join("<br>") +
          "</div>";
      document.getElementById("csvSummary").innerHTML = html;
    } catch (err) {
      FILE_ERRORS.add("receipts");
      PARSED_TICKETS = null;
      PARSED_DAYS = null;
      document.getElementById("cardMultiDay").classList.add("hide");
      document.getElementById("csvSummary").innerHTML =
        `<div class="msg err">${H(err.message)}</div>`;
    } finally {
      finishReader("receipts", reader);
    }
  };
  reader.onerror = () => {
    if (READERS.get("receipts") !== reader) return;
    FILE_ERRORS.add("receipts");
    msg("err", "No se pudo leer el archivo. Vuelve a seleccionarlo.");
    finishReader("receipts", reader);
  };
  reader.readAsText(f, "UTF-8");
}

function onInventoryCsvChange(e) {
  cancelReader("inventory");
  PARSED_INVENTORY = null;
  document.querySelectorAll(".invCount").forEach((input) => {
    input.value = "";
  });
  renderInventoryInputs();
  const file = e.target.files[0],
    summary = document.getElementById("inventoryCsvSummary");
  if (!file) {
    PARSED_INVENTORY = null;
    summary.textContent = "";
    renderInventoryInputs();
    return;
  }
  const reader = new FileReader();
  READERS.set("inventory", reader);
  syncSaveButton();
  reader.onload = () => {
    if (READERS.get("inventory") !== reader) return;
    try {
      const result = parseInventory(reader.result, CATALOG);
      PARSED_INVENTORY = result.counts;
      renderInventoryInputs();
      summary.innerHTML =
        '<div class="msg ok">' +
        result.counts.length +
        " existencias preparadas. Revisa la fecha/hora a la que corresponden antes de guardar.</div>";
      if (result.unmatched.length)
        summary.innerHTML +=
          '<div class="msg warn">Productos nuevos: ' +
          result.unmatched.map(H).join(", ") +
          ". Se registrarán al guardar; deben incluir precio.</div>";
    } catch (error) {
      FILE_ERRORS.add("inventory");
      PARSED_INVENTORY = null;
      summary.innerHTML = '<div class="msg err">' + H(error.message) + "</div>";
    } finally {
      finishReader("inventory", reader);
    }
  };
  reader.onerror = () => {
    if (READERS.get("inventory") !== reader) return;
    FILE_ERRORS.add("inventory");
    summary.textContent = "No se pudo leer el archivo. Vuelve a seleccionarlo.";
    finishReader("inventory", reader);
  };
  reader.readAsText(file, "UTF-8");
}

function flagStrongSaleDays(days) {
  const ventas = days.map((d) => d.venta).sort((a, b) => a - b);
  const n = ventas.length;
  const mediana =
    n % 2 ? ventas[(n - 1) / 2] : (ventas[n / 2 - 1] + ventas[n / 2]) / 2;
  const umbral = mediana * 1.5;
  days.forEach((d) => {
    d.flag = n >= 3 && mediana > 0 && d.venta >= umbral;
  });
}

function renderMultiDayTable() {
  document.querySelector("#tblMultiDay tbody").innerHTML = PARSED_DAYS.map(
    (d) => `
    <tr data-date="${d.date}" class="${d.flag ? "row-flag" : ""}">
      <td>${d.date}${d.flag ? '<span class="badge-flag">⚡ venta fuerte</span>' : ""}</td>
      <td class="num">${d.tickets.length}</td><td class="num">${money(d.venta)}</td>
      <td><select class="mdSport">
        <option value="futbol">Fútbol</option><option value="beisbol">Béisbol / Softbol</option><option value="otro" selected>Otro</option>
      </select></td>
      <td><select class="mdCategoria">
        <option value="evento_especial">Evento especial</option><option value="dia_partido">Día de partido</option><option value="entrenamiento_normal" selected>Entrenamiento normal</option>
      </select></td>
      <td><input type="text" class="mdEvento" placeholder="opcional" style="min-width:140px"></td>
      <td class="mdTags">${eventTagChecks("mdTag")}</td>
    </tr>`,
  ).join("");
}

function wireApplyAll() {
  document.getElementById("btnApplyAll").addEventListener("click", () => {
    const sport = document.getElementById("mdAllSport").value;
    const categoria = document.getElementById("mdAllCategoria").value;
    const evento = document.getElementById("mdAllEvento").value.trim();
    const tags = checkedTags(document.getElementById("mdAllTags"));
    document.querySelectorAll("#tblMultiDay tbody tr").forEach((tr) => {
      tr.querySelector(".mdSport").value = sport;
      tr.querySelector(".mdCategoria").value = categoria;
      if (evento) tr.querySelector(".mdEvento").value = evento;
      setCheckedTags(tr.querySelector(".mdTags"), tags);
    });
  });
  document.getElementById("btnApplyFlagged").addEventListener("click", () => {
    const sport = document.getElementById("mdFlagSport").value;
    const categoria = document.getElementById("mdFlagCategoria").value;
    const evento = document.getElementById("mdFlagEvento").value.trim();
    const tags = checkedTags(document.getElementById("mdFlagTags"));
    document
      .querySelectorAll("#tblMultiDay tbody tr.row-flag")
      .forEach((tr) => {
        tr.querySelector(".mdSport").value = sport;
        tr.querySelector(".mdCategoria").value = categoria;
        if (evento) tr.querySelector(".mdEvento").value = evento;
        setCheckedTags(tr.querySelector(".mdTags"), tags);
      });
  });
}

async function onSubmit(e) {
  e.preventDefault();
  if (SAVING || READERS.size || FILE_ERRORS.size) return;
  SAVING = true;
  const btn = document.getElementById("btnSave");
  syncSaveButton();
  const fileInputs = [
    document.getElementById("fCsv"),
    document.getElementById("fInventoryCsv"),
  ];
  fileInputs.forEach((input) => {
    input.disabled = true;
  });
  btn.innerHTML = '<span class="spinner"></span>Guardando...';
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session)
      throw new Error(
        "Tu sesión terminó. Inicia sesión nuevamente; conserva el archivo para reintentar.",
      );
    if (PARSED_DAYS && PARSED_DAYS.length > 1) {
      await submitMultiDay(session);
    } else {
      await submitSingleDay(session);
    }
    const profile = await getCurrentProfile();
    loadDays(profile);
  } catch (err) {
    msg("err", H(err.message));
  } finally {
    SAVING = false;
    syncSaveButton();
    fileInputs.forEach((input) => {
      input.disabled = false;
    });
    btn.textContent =
      PARSED_DAYS && PARSED_DAYS.length > 1
        ? `Guardar ${PARSED_DAYS.length} días`
        : "Guardar día";
  }
}

async function submitSingleDay() {
  const date = document.getElementById("fDate").value;
  const inputs = [...document.querySelectorAll(".invCount")].filter(
    (i) => i.value !== "",
  );
  const at = parseBusinessDate(document.getElementById("fCountAt").value);
  if (inputs.length && (!at || businessDate(at) !== date))
    throw new Error(
      "Indica la fecha y hora del conteo; deben pertenecer al día que vas a guardar.",
    );
  const counts = inputs.map((i) => ({
    ...INVENTORY_INPUTS[Number(i.dataset.index)],
    physical_count: Number(i.value),
    counted_at: at.toISOString(),
    count_source: i.dataset.source,
  }));
  const games = getGames().map((g) => ({
    start_time: g.hora,
    cars_parked: g.ap,
    cars_charged: g.ac,
    parking_rate: Number(document.getElementById("fRate").value),
    charges_parking: g.cobra,
    notes: g.nota,
  }));
  const day = {
    date,
    sport: document.getElementById("fSport").value,
    day_type: document.getElementById("fDayCategory").value,
    event_name: document.getElementById("fEventName").value.trim(),
    event_tags: checkedTags(document.getElementById("fEventTags")),
    notes: document.getElementById("fNotes").value.trim(),
    event_groups: captureGroups.read().length
      ? validateGroups(captureGroups.read())
      : null,
  };
  if (
    day.event_groups &&
    games.length &&
    totalGames(day.event_groups) != null &&
    totalGames(day.event_groups) !== games.length
  )
    throw new Error(
      "El total del desglose no coincide con los partidos de estacionamiento. Revisa ambos antes de guardar.",
    );
  const result = await saveDay(supabase, {
    day,
    tickets: PARSED_TICKETS || [],
    games,
    counts,
    replaceExisting: document.getElementById("fReplaceReceipts").checked,
  });
  msg(
    "ok",
    "Día " +
      H(date) +
      " guardado completo: " +
      result.inserted +
      " recibos nuevos, " +
      result.skipped +
      " ya existentes y " +
      result.repaired +
      " conciliados.",
  );
  resetForm();
  await reloadCatalog();
}
async function submitMultiDay() {
  const results = [];
  for (const tr of document.querySelectorAll("#tblMultiDay tbody tr")) {
    const date = tr.dataset.date,
      day = {
        date,
        sport: tr.querySelector(".mdSport").value,
        day_type: tr.querySelector(".mdCategoria").value,
        event_name: tr.querySelector(".mdEvento").value.trim(),
        event_tags: checkedTags(tr.querySelector(".mdTags")),
      };
    try {
      const result = await saveDay(supabase, {
        day,
        tickets: PARSED_DAYS.find((d) => d.date === date).tickets,
        replaceExisting: document.getElementById("fReplaceReceipts").checked,
      });
      results.push({ date, ok: true, result });
    } catch (error) {
      results.push({ date, ok: false, error: error.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  msg(
    failed.length ? "warn" : "ok",
    results.filter((r) => r.ok).length +
      " de " +
      results.length +
      " días guardados completos." +
      (failed.length
        ? "<br>" +
          failed.map((r) => H(r.date + ": " + r.error)).join("<br>") +
          "<br>La carga se conserva para reintentar."
        : ""),
  );
  if (!failed.length) {
    resetForm();
    await reloadCatalog();
  }
}

function resetForm() {
  captureGroups.set([]);
  document.getElementById("formDay").reset();
  document.getElementById("fDate").value = localISODate();
  updateDayLabel();
  document.getElementById("games").innerHTML = "";
  addGame();
  document.getElementById("csvSummary").innerHTML = "";
  document.getElementById("inventoryCsvSummary").innerHTML = "";
  document.getElementById("cardMultiDay").classList.add("hide");
  document.getElementById("cardInv").classList.remove("hide");
  document.getElementById("btnSave").textContent = "Guardar día";
  PARSED_TICKETS = null;
  PARSED_DAYS = null;
  PARSED_INVENTORY = null;
  document.getElementById("fCountAt").value = businessNow();
  document.querySelectorAll(".invCount").forEach((input) => {
    input.value = "";
  });
  renderInventoryInputs();
  checkExistingDate();
}

async function loadDays(profile) {
  const { data, error } = await supabase
    .from("sale_days")
    .select(
      "id, date, sport, status, created_by, profiles(full_name), tickets(amount)",
    )
    .order("date", { ascending: false })
    .limit(20);
  const tbody = document.querySelector("#tblDays tbody");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6">No pude cargar el historial.</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6">Todavía no hay días capturados.</td></tr>`;
    return;
  }
  tbody.innerHTML = data
    .map((d) => {
      const venta = (d.tickets || []).reduce((s, t) => s + Number(t.amount), 0);
      return `<tr>
      <td>${d.date}</td><td>${H(d.sport || "—")}</td>
      <td class="num">${(d.tickets || []).length}</td><td class="num">${money(venta)}</td>
      <td><span class="chip ${d.status}">${d.status}</span></td>
      <td>${H(d.profiles ? d.profiles.full_name || "—" : "—")}</td>
    </tr>`;
    })
    .join("");
}

init().catch((error) => {
  msg("err", H(error.message));
  document.getElementById("btnSave").disabled = true;
});
