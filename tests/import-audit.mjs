import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseReceipts } from '../lib/csv.js';

const actualPath = new URL('../receipts-by-item-2026-09-19-2026-09-19.csv', import.meta.url);
const actual = parseReceipts(fs.readFileSync(actualPath, 'utf8'), []);
assert(actual.tickets.length > 0, 'El archivo real debe producir tickets');
assert.deepEqual([...new Set(actual.tickets.map(ticket => ticket.sale_date))], ['2026-09-19'], 'Un archivo del 19-sep no debe dividirse por UTC');
assert.equal(actual.tickets.reduce((sum, ticket) => sum + ticket.amount, 0), 6850, 'La venta neta del archivo real debe conservarse');

const receiptFiles = [
  ...fs.readdirSync(new URL('../../', import.meta.url)).filter(name => /^receipts.*\.csv$/i.test(name)).map(name => new URL(`../../${name}`, import.meta.url)),
  actualPath,
];
for (const file of receiptFiles) {
  const match = decodeURIComponent(file.pathname).match(/(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})[^/]*\.csv$/i);
  if (!match) continue;
  const parsed = parseReceipts(fs.readFileSync(file, 'utf8'), []);
  const dates = [...new Set(parsed.tickets.map(ticket => ticket.sale_date))];
  assert(dates.every(date => date >= match[1] && date <= match[2]), `${file.pathname}: una venta cambió de día por zona horaria`);
}

const discounted = `Fecha,Número de recibo,Tipo de recibo,Categoria,Artículo,Cantidad,Ventas brutas,Descuentos,Ventas netas,Costo de los bienes,TPV,Nombre del cajero\n19/9/2026 8:15 p. m.,R-1,Venta,Botana,Producto prueba,1,100,20,80,40,TPV 1,Ana\n`;
const parsedDiscount = parseReceipts(discounted, []);
assert.equal(parsedDiscount.tickets[0].amount, 80, 'Los reportes deben usar venta neta después del descuento');
assert.equal(parsedDiscount.productsToCreate[0].sell_price, 100, 'El precio de catálogo debe conservar el precio bruto');
assert.equal(parsedDiscount.tickets[0].sale_date, '2026-09-19', 'La fecha comercial debe conservarse aunque la hora sea nocturna');

const noNumber = discounted.replace('R-1', '');
const first = parseReceipts(noNumber, []).tickets[0].ticket_number;
const second = parseReceipts(noNumber, []).tickets[0].ticket_number;
assert.equal(first, second, 'Un recibo sin número debe tener identidad estable al reimportarlo');

const reportSource = fs.readFileSync(new URL('../reportes.html', import.meta.url), 'utf8');
const moneyFunctions = reportSource.match(/function itemProductKey[\s\S]*?(?=function statsForDays)/)?.[0];
assert(moneyFunctions, 'Debe existir la conciliación monetaria de reportes');
const moneyContext = {
  PRODUCTS: [
    { id: 'con-costo', sell_price: 10, cost_price: 4 },
    { id: 'sin-costo', sell_price: 20, cost_price: null },
  ],
};
vm.createContext(moneyContext);
vm.runInContext(`${moneyFunctions}\nthis.result = monetaryBreakdown(
  [{ id: 't1', amount: 24 }, { id: 't2', amount: 5 }],
  [{ ticket_id: 't1', product_id: 'con-costo', qty: 1 }, { ticket_id: 't1', product_id: 'sin-costo', qty: 1 }]
);`, moneyContext);
assert.equal(moneyContext.result.ventaConCosto, 8, 'La venta con costo debe respetar el descuento del ticket');
assert.equal(moneyContext.result.ventaSinCosto, 21, 'La venta sin costo debe incluir su proporción y tickets sin detalle');
assert.equal(moneyContext.result.ventaConCosto + moneyContext.result.ventaSinCosto, 29, 'El desglose debe conciliar con la venta total');
assert.equal(moneyContext.result.costoTotal, 4, 'El costo conocido no debe estimarse');

const dateFunction = reportSource.match(/function toISODate\(d\) \{[\s\S]*?\n\}/)?.[0];
assert(dateFunction, 'Debe existir la conversión de fecha local');
const dateContext = {};
vm.createContext(dateContext);
vm.runInContext(`${dateFunction}\nthis.result = toISODate(new Date(2026, 8, 28, 20, 0));`, dateContext);
assert.equal(dateContext.result, '2026-09-28', 'La fecha local nocturna no debe adelantarse por UTC');

console.log(`OK: ${receiptFiles.length} archivo(s), ${actual.tickets.length} tickets del 19-sep; fecha, descuentos, conciliación y deduplicación verificados.`);
