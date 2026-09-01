// Utilidades para leer el CSV de recibos del punto de venta y
// emparejar los nombres de producto contra el catálogo.
// El emparejador es el mismo (tokens + bigramas) que ya se probó en
// Analizador_Tienda_Olivos.html: los nombres del POS casi nunca
// coinciden letra por letra con los del catálogo ("Agua 1 litro" vs
// "Agua litro", "Doritos Fleming hot" vs "Doritos flaming hot").

function tokens(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\d+/g, " ") // los números casi nunca son parte del nombre real
    .split(/\s+/)
    .filter(t => t && !["de", "la", "el", "los", "las", "orden", "y", "con"].includes(t))
    .map(t => (t.length > 4 && t.endsWith("s")) ? t.slice(0, -1) : t); // singular simple
}

function bigrams(s) {
  const g = [];
  for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
  return g;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const B = [...b];
  let inter = 0;
  a.forEach(x => { const i = B.indexOf(x); if (i >= 0) { inter++; B.splice(i, 1); } });
  return 2 * inter / (a.length + b.length);
}

// similitud 0..1 entre dos nombres de producto (mezcla tokens + caracteres)
function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = ta.join(""), sb = tb.join("");
  if (sa === sb) return 1;
  return 0.5 * dice(ta, tb) + 0.5 * dice(bigrams(sa), bigrams(sb));
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
 * Empareja un nombre suelto del recibo contra el catálogo.
 * Coincidencia exacta primero (tokens iguales); si no, la más
 * parecida por arriba de 0.6 de similitud. Devuelve el producto o null.
 */
function matchProduct(rawName, catalog, catalogIndex) {
  const key = tokens(rawName).join(" ");
  if (catalogIndex.has(key)) return catalogIndex.get(key);
  let best = null, bestScore = 0;
  for (const p of catalog) {
    const s = similarity(rawName, p.name);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= 0.6 ? best : null;
}

/**
 * Lee el export "receipts" del POS y devuelve tickets con sus líneas.
 * catalog: [{id, name}] para emparejar nombres.
 */
export function parseReceipts(text, catalog) {
  const rows = parseCSV(text);
  const hi = rows.findIndex(r => r.some(c => /descripci/i.test(c)));
  if (hi < 0) throw new Error('No encontré la columna "Descripción" — ¿es el export correcto del punto de venta?');
  const objs = toObjects(rows, hi);

  const catalogIndex = new Map();
  catalog.forEach(p => catalogIndex.set(tokens(p.name).join(" "), p));

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
      const match = matchProduct(rawName, catalog, catalogIndex);
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
