// Utilidades para leer el CSV de recibos del punto de venta y
// emparejar los nombres de producto contra el catálogo.

export function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

function toObjects(rows, headerRow) {
  const h = rows[headerRow].map(s => s.trim());
  return rows.slice(headerRow + 1).map(r => {
    const o = {};
    h.forEach((k, i) => (o[k] = (r[i] || "").trim()));
    return o;
  });
}

const num = s => {
  const v = parseFloat(String(s).replace(/[$,\s]/g, ""));
  return isNaN(v) ? null : v;
};

// Convierte "22/8/26 17:39" -> Date; soporta también ISO.
function parseFecha(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[\s,]+(\d{1,2}):(\d{2})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1], +m[4], +m[5]); }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/**
 * Lee el export "receipts" del POS y devuelve tickets con sus líneas.
 * catalog: [{id, name}] para emparejar nombres normalizados.
 */
export function parseReceipts(text, catalog) {
  const rows = parseCSV(text);
  const hi = rows.findIndex(r => r.some(c => /descripci/i.test(c)));
  if (hi < 0) throw new Error('No encontré la columna "Descripción" — ¿es el export correcto del punto de venta?');
  const objs = toObjects(rows, hi);

  const byNorm = new Map();
  catalog.forEach(p => byNorm.set(normalize(p.name), p));

  const tickets = [];
  const unmatched = new Set();
  let descartados = 0;

  for (const r of objs) {
    const tipo = r["Tipo de recibo"] || "Venta";
    if (!/venta/i.test(tipo)) { descartados++; continue; }
    const dt = parseFecha(r["Fecha"]);
    if (!dt) { descartados++; continue; }
    const monto = num(r["Ventas brutas"]) ?? num(r["Ventas netas"]) ?? 0;
    const items = [];
    for (const part of String(r["Descripción"] || "").split(",")) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/^(\d+)\s*x\s*(.+)$/i);
      const qty = m ? parseInt(m[1]) : 1;
      const rawName = m ? m[2].trim() : p;
      const match = byNorm.get(normalize(rawName)) || null;
      if (!match) unmatched.add(rawName);
      items.push({ raw: rawName, product_id: match ? match.id : null, qty });
    }
    if (!items.length) { descartados++; continue; }
    tickets.push({
      ticket_number: r["Número de recibo"] || null,
      ts: dt.toISOString(),
      amount: monto,
      payment_type: r["Tipo de pago"] || null,
      raw_description: r["Descripción"] || "",
      items,
    });
  }

  return { tickets, unmatched: [...unmatched], descartados };
}
