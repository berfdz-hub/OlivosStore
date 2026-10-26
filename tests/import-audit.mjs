import fs from "node:fs";
import assert from "node:assert/strict";
import { monetaryBreakdown } from "../lib/accounting.js";
import { businessDate } from "../lib/csv.js";
import { parseReceipts } from "../lib/csv.js";

const actualPath = new URL(
  "../receipts-by-item-2026-09-19-2026-09-19.csv",
  import.meta.url,
);
const actual = fs.existsSync(actualPath)
  ? parseReceipts(fs.readFileSync(actualPath, "utf8"), [])
  : null;
if (actual)
  assert(actual.tickets.length > 0, "El archivo real debe producir tickets");
if (actual)
  assert.deepEqual(
    [...new Set(actual.tickets.map((ticket) => ticket.sale_date))],
    ["2026-09-19"],
    "Un archivo del 19-sep no debe dividirse por UTC",
  );
if (actual)
  assert.equal(
    actual.tickets.reduce((sum, ticket) => sum + ticket.amount, 0),
    6850,
    "La venta neta del archivo real debe conservarse",
  );

const receiptFiles = [
  ...fs
    .readdirSync(new URL("../../", import.meta.url))
    .filter((name) => /^receipts.*\.csv$/i.test(name))
    .map((name) => new URL(`../../${name}`, import.meta.url)),
  ...(actual ? [actualPath] : []),
];
for (const file of receiptFiles) {
  const match = decodeURIComponent(file.pathname).match(
    /(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})[^/]*\.csv$/i,
  );
  if (!match) continue;
  const parsed = parseReceipts(fs.readFileSync(file, "utf8"), []);
  const dates = [...new Set(parsed.tickets.map((ticket) => ticket.sale_date))];
  assert(
    dates.every((date) => date >= match[1] && date <= match[2]),
    `${file.pathname}: una venta cambió de día por zona horaria`,
  );
}

const discounted = `Fecha,Número de recibo,Tipo de recibo,Categoria,Artículo,Cantidad,Ventas brutas,Descuentos,Ventas netas,Costo de los bienes,TPV,Nombre del cajero\n19/9/2026 8:15 p. m.,R-1,Venta,Botana,Producto prueba,1,100,20,80,40,TPV 1,Ana\n`;
const parsedDiscount = parseReceipts(discounted, []);
assert.equal(
  parsedDiscount.tickets[0].amount,
  80,
  "Los reportes deben usar venta neta después del descuento",
);
assert.equal(
  parsedDiscount.productsToCreate[0].sell_price,
  100,
  "El precio de catálogo debe conservar el precio bruto",
);
assert.equal(
  parsedDiscount.tickets[0].sale_date,
  "2026-09-19",
  "La fecha comercial debe conservarse aunque la hora sea nocturna",
);

const noNumber = discounted.replace("R-1", "");
const first = parseReceipts(noNumber, []).tickets[0].ticket_number;
const second = parseReceipts(noNumber, []).tickets[0].ticket_number;
assert.equal(
  first,
  second,
  "Un recibo sin número debe tener identidad estable al reimportarlo",
);

const historical = monetaryBreakdown(
  [{ id: "a", amount: 80 }],
  [
    {
      ticket_id: "a",
      product_id: "p",
      qty: 1,
      unit_price: 100,
      line_net_amount: 80,
      unit_cost: 40,
    },
  ],
);
assert.equal(historical.ventaConCosto, 80);
assert.equal(historical.costoTotal, 40);
assert.equal(businessDate(new Date("2026-09-29T02:00:00Z")), "2026-09-28");
console.log(
  "OK: " +
    receiptFiles.length +
    " archivos locales; importación, descuentos, identidad y fecha comercial.",
);
