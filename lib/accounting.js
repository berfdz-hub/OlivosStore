export const itemProductKey = (item) =>
  item.product_id ||
  "__raw__" + (item.product_name_raw || item.raw || "Sin nombre");
const finite = (value) => value != null && Number.isFinite(Number(value));

// Only historical source data contributes to historical profit. Old receipts
// without line amounts remain visibly unallocated rather than reconstructed
// from today's catalogue prices.
export function monetaryBreakdown(tickets, items) {
  const byTicket = new Map(),
    productSales = new Map(),
    productCosts = new Map(),
    unknownCostProducts = new Set();
  items.forEach((i) => {
    if (!byTicket.has(i.ticket_id)) byTicket.set(i.ticket_id, []);
    byTicket.get(i.ticket_id).push(i);
  });
  let costoTotal = 0,
    ventaConCosto = 0,
    ventaSinCosto = 0,
    unallocatedSale = 0,
    unallocatedTickets = 0;
  for (const ticket of tickets) {
    const amount = Number(ticket.amount) || 0,
      lines = byTicket.get(ticket.id) || [];
    const exact =
      lines.length > 0 &&
      lines.every((i) => finite(i.line_net_amount)) &&
      Math.abs(
        lines.reduce((s, i) => s + Number(i.line_net_amount), 0) - amount,
      ) <= 0.011;
    if (!exact) {
      ventaSinCosto += amount;
      unallocatedSale += amount;
      unallocatedTickets++;
      lines.forEach((i) => unknownCostProducts.add(itemProductKey(i)));
      continue;
    }
    for (const line of lines) {
      const key = itemProductKey(line),
        sale = Number(line.line_net_amount);
      productSales.set(key, (productSales.get(key) || 0) + sale);
      if (finite(line.line_cost_amount) || finite(line.unit_cost)) {
        const cost = finite(line.line_cost_amount)
          ? Number(line.line_cost_amount)
          : Number(line.unit_cost) * Number(line.qty);
        costoTotal += cost;
        ventaConCosto += sale;
        productCosts.set(key, (productCosts.get(key) || 0) + cost);
      } else {
        ventaSinCosto += sale;
        unknownCostProducts.add(key);
      }
    }
  }
  return {
    costoTotal,
    ventaConCosto,
    ventaSinCosto,
    productSales,
    productCosts,
    unknownCostProducts,
    unallocatedSale,
    unallocatedTickets,
  };
}

export function inventoryAt(
  { days, tickets, items, counts, movements = [] },
  before = new Date().toISOString(),
) {
  const dayById = new Map(days.map((d) => [d.id, d])),
    ticketById = new Map(tickets.map((t) => [t.id, t])),
    latest = new Map();
  for (const count of counts) {
    const day = dayById.get(count.sale_day_id);
    if (!day || count.product_id == null || count.physical_count == null)
      continue;
    // Old records carry no hour; show them as references requiring a new count.
    const at = count.counted_at || `${day.date}T23:59:59-06:00`;
    if (Date.parse(at) >= Date.parse(before)) continue;
    const current = latest.get(count.product_id);
    if (!current || Date.parse(at) > Date.parse(current.at))
      latest.set(count.product_id, {
        date: day.date,
        at,
        counted: Number(count.physical_count),
        soldAfter: 0,
        movedAfter: 0,
        value: Number(count.physical_count),
        uncertain: !count.counted_at || count.count_source === "legacy",
      });
  }
  for (const item of items) {
    const stock = latest.get(item.product_id),
      t = ticketById.get(item.ticket_id);
    if (
      stock &&
      t &&
      Date.parse(t.ts) > Date.parse(stock.at) &&
      Date.parse(t.ts) < Date.parse(before)
    )
      stock.soldAfter += Number(item.qty) || 0;
  }
  for (const move of movements) {
    const stock = latest.get(move.product_id);
    if (
      stock &&
      Date.parse(move.occurred_at) > Date.parse(stock.at) &&
      Date.parse(move.occurred_at) < Date.parse(before)
    )
      stock.movedAfter += Number(move.qty) || 0;
  }
  for (const stock of latest.values()) {
    stock.value = stock.counted + stock.movedAfter - stock.soldAfter;
    stock.inconsistent = stock.value < 0;
  }
  return latest;
}
