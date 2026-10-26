// Loyverse imports: exact product identity, Mexico business dates and signed refunds.
export const BUSINESS_TIME_ZONE = "America/Mexico_City";
const clean = (v) => String(v ?? "").trim();
export const normalizedName = (v) =>
  clean(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
const num = (v) => {
  const s = clean(v).replace(/[$,\s]/g, "");
  return s && Number.isFinite(Number(s)) ? Number(s) : null;
};
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export function parseCSV(text) {
  text = String(text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    cell = "",
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (q)
    throw new Error(
      "El CSV contiene comillas sin cerrar. Vuelve a exportarlo.",
    );
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}
export function businessDate(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (k) => p.find((v) => v.type === k).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function parseBusinessDate(value) {
  const s = clean(value);
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(+d) ? null : d;
  }
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?$/i,
  );
  const iso = s.match(
    /^(\d{4})-(\d\d)-(\d\d)[T ](\d{1,2}):(\d\d)(?::(\d\d))?$/,
  );
  if (!m && !iso) return null;
  let [y, mo, d, h, mi, sec] = m
    ? [+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] || 0)]
    : iso.slice(1).map((v) => +(v || 0));
  if (y < 100) y += 2000;
  if (m?.[7]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[7].toLowerCase() === "p" ? 12 : 0);
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec),
    check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    sec > 59
  )
    return null;
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: BUSINESS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const get = (k) => +p.find((v) => v.type === k).value;
    const delta =
      wall -
      Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second"),
      );
    instant += delta;
    if (!delta) break;
  }
  return new Date(instant);
}
const productKey = (v) =>
  clean(v).normalize("NFC").toLowerCase().replace(/\s+/g, " ");
function matchProduct(name, catalog, reference = "") {
  const ref = clean(reference),
    refs = ref ? catalog.filter((p) => clean(p.external_ref) === ref) : [];
  if (refs.length === 1) return refs[0];
  const exact = catalog.filter(
    (p) =>
      productKey(p.name) === productKey(name) &&
      (!ref || !p.external_ref || clean(p.external_ref) === ref),
  );
  return exact.length === 1 ? exact[0] : null;
}
function objects(rows, hi) {
  const h = rows[hi].map(clean);
  return rows
    .slice(hi + 1)
    .map((r) => Object.fromEntries(h.map((k, i) => [k, clean(r[i])])));
}
export function parseReceipts(text, catalog = []) {
  const rows = parseCSV(text),
    hi = rows.findIndex((r) =>
      r.some((c) => /^art[íi]culo$|^descripci[oó]n$/i.test(clean(c))),
    );
  if (hi < 0)
    throw new Error(
      "No se encontró Artículo ni Descripción. Usa el CSV de recibos de Loyverse.",
    );
  const byItem = rows[hi].some((c) => /^art[íi]culo$/i.test(clean(c))),
    grouped = new Map(),
    unmatched = new Set(),
    products = new Map(),
    warnings = [];
  let descartados = 0;
  for (const [index, r] of objects(rows, hi).entries()) {
    const type = normalizedName(r["Tipo de recibo"] || "Venta"),
      refund = /reembolso|devolucion|refund|return/.test(type);
    if (!refund && !/^venta$|^sale$/.test(type)) {
      descartados++;
      continue;
    }
    const dt = parseBusinessDate(r.Fecha);
    if (!dt)
      throw new Error(
        `Fecha inválida en el renglón ${hi + index + 2}: ${r.Fecha}`,
      );
    const amount = num(r["Ventas netas"]) ?? num(r["Ventas brutas"]);
    if (amount == null)
      throw new Error(`Falta el importe en el renglón ${hi + index + 2}.`);
    if (!refund && amount < 0)
      throw new Error(
        "Una venta tiene importe negativo; revisa el tipo de recibo.",
      );
    const sign = refund ? -1 : 1,
      receipt = r["Número de recibo"] || "",
      terminal = r.TPV || "";
    const fallback = `SIN-NUMERO|${dt.toISOString()}|${terminal}|${r["Nombre del cajero"] || ""}`;
    if (!receipt)
      warnings.push(
        "Hay recibos sin número: revisa que no haya ventas distintas en el mismo minuto y terminal.",
      );
    const key = [
      receipt || fallback,
      dt.toISOString(),
      terminal,
      refund ? "refund" : "sale",
    ].join("|");
    if (!grouped.has(key))
      grouped.set(key, {
        ticket_number: receipt || fallback,
        source_terminal: terminal,
        receipt_type: refund ? "refund" : "sale",
        ts: dt.toISOString(),
        sale_date: businessDate(dt),
        amount: 0,
        payment_type: r["Tipo de pago"] || null,
        raw_description: "",
        items: [],
      });
    const ticket = grouped.get(key);
    ticket.amount = round(ticket.amount + sign * Math.abs(amount));
    const lines = byItem
      ? [
          {
            name: r["Artículo"],
            qty: num(r.Cantidad),
            reference: r.REF || r.SKU || "",
            line: sign * Math.abs(amount),
            gross: num(r["Ventas brutas"]),
            cost: num(r["Costo de los bienes"]),
            category: r.Categoria || r["Categoría"],
          },
        ]
      : clean(r["Descripción"])
          .split(",")
          .filter(clean)
          .map((part) => {
            const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*x\s*(.+)$/i);
            return {
              name: m ? m[2] : part.trim(),
              qty: m ? +m[1] : 1,
              reference: "",
              line: null,
              gross: null,
              cost: null,
            };
          });
    if (!lines.length)
      throw new Error(`El recibo ${receipt || index + 1} no tiene productos.`);
    for (const line of lines) {
      const name = clean(line.name),
        qty = Number(line.qty);
      if (!name || !Number.isFinite(qty) || qty === 0 || (!refund && qty < 0))
        throw new Error(
          `Producto o cantidad inválidos en el renglón ${hi + index + 2}.`,
        );
      const matched = matchProduct(name, catalog, line.reference),
        price = line.gross != null ? Math.abs(line.gross / qty) : null,
        cost = line.cost != null ? Math.abs(line.cost / qty) : null;
      if (!matched) {
        unmatched.add(name);
        if (!products.has(name) && price != null)
          products.set(name, {
            name,
            category: line.category || "Otro",
            sell_price: round(price),
            cost_price: cost == null ? null : round(cost),
            external_ref: line.reference || null,
          });
      }
      ticket.items.push({
        raw: name,
        product_id: matched?.id || null,
        external_ref: line.reference || null,
        qty: sign * Math.abs(qty),
        unit_price: price == null ? null : Number(price.toFixed(4)),
        unit_cost: cost == null ? null : Number(cost.toFixed(4)),
        line_cost_amount: line.cost == null ? null : sign * Math.abs(line.cost),
        line_net_amount: line.line,
        category: line.category || "Otro",
      });
    }
  }
  const tickets = [...grouped.values()];
  tickets.forEach((t) => {
    t.raw_description = t.items.map((i) => `${i.qty} x ${i.raw}`).join(", ");
  });
  return {
    tickets,
    unmatched: [...unmatched],
    productsToCreate: [...products.values()],
    descartados,
    warnings: [...new Set(warnings)],
  };
}
export function parseInventory(text, catalog = [], { stockColumn } = {}) {
  const rows = parseCSV(text),
    labels = new Set([
      "name",
      "nombre",
      "item name",
      "nombre del articulo",
      "articulo",
    ]);
  let hi = -1,
    ni = -1,
    indexes = [];
  for (let i = 0; i < rows.length; i++) {
    const h = rows[i].map(normalizedName),
      name = h.findIndex((v) => labels.has(v)),
      stock = h.flatMap((v, j) =>
        /^(in stock|en inventario|existencias?|stock)(\s|\[|$)/.test(v) &&
        !/(low|baj[oa]s?|minim|alerta|notification)/.test(v)
          ? [j]
          : [],
      );
    if (name >= 0 && stock.length) {
      hi = i;
      ni = name;
      indexes = stock;
      break;
    }
  }
  if (hi < 0)
    throw new Error(
      "El archivo no contiene existencias. Exporta Back Office → Lista de artículos de Loyverse.",
    );
  if (stockColumn) indexes = indexes.filter((i) => rows[hi][i] === stockColumn);
  if (indexes.length !== 1)
    throw new Error(
      "El archivo contiene varias tiendas. Exporta únicamente la tienda que vas a actualizar.",
    );
  const headers = rows[hi].map(normalizedName),
    col = (names) => headers.findIndex((h) => names.includes(h));
  const ci = col(["category", "categoria"]),
    costi = col(["cost", "costo", "purchase cost", "costo de compra"]),
    refi = col(["sku", "ref", "reference"]),
    pricei = headers.findIndex((h) => /^(price|precio)(\s|\[|$)/.test(h)),
    vi = col(["variant", "variante", "variant name", "nombre de variante"]);
  const counts = new Map(),
    unmatched = new Set(),
    products = new Map();
  let previousName = "",
    previousCategory = "Otro",
    previousCost = null,
    withoutStock = 0;
  for (const [index, row] of rows.slice(hi + 1).entries()) {
    const explicit = clean(row[ni]);
    if (explicit) {
      previousName = explicit;
      previousCategory = ci >= 0 ? clean(row[ci]) || "Otro" : "Otro";
      previousCost = costi >= 0 ? num(row[costi]) : null;
    }
    const base = explicit || previousName;
    if (!base) continue;
    const variant = vi >= 0 ? clean(row[vi]) : "",
      raw = variant ? `${base} — ${variant}` : base,
      value = num(row[indexes[0]]);
    if (value == null) {
      withoutStock++;
      continue;
    }
    if (value < 0)
      throw new Error(
        `Existencia negativa en ${raw}. Corrígela antes de importar.`,
      );
    const ref = refi >= 0 ? clean(row[refi]) : "",
      matched = matchProduct(raw, catalog, ref),
      cost = costi >= 0 ? num(row[costi]) : null,
      price = pricei >= 0 ? num(row[pricei]) : null;
    const data = {
      product_id: matched?.id || null,
      product_name: matched?.name || raw,
      raw,
      physical_count: value,
      external_ref: ref || null,
      sell_price: price,
      cost_price: cost ?? previousCost,
      category: previousCategory,
    };
    if (!matched) {
      unmatched.add(raw);
      products.set(raw, {
        name: raw,
        category: previousCategory,
        sell_price: price,
        cost_price: cost ?? previousCost,
        external_ref: ref || null,
      });
    }
    const key = matched?.id || ref || raw;
    if (counts.has(key))
      throw new Error(
        `Producto repetido en inventario: ${raw}, renglón ${hi + index + 2}. Revisa las variantes.`,
      );
    counts.set(key, data);
  }
  return {
    counts: [...counts.values()],
    unmatched: [...unmatched],
    productsToCreate: [...products.values()],
    withoutStock,
    stockColumns: indexes.map((i) => rows[hi][i]),
  };
}
