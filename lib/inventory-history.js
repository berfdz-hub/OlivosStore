import { inventoryAt } from "./accounting.js";
import { businessDate } from "./csv.js";

// A count replaces the balance; a receipt adds units. Never treat an imported
// count as a purchase, nor invent an hour for an event that only has a date.
export function inventoryTrace(
  history,
  productId,
  before = new Date().toISOString(),
) {
  const tickets = new Map(history.tickets.map((t) => [t.id, t]));
  const h = {
    ...history,
    counts: history.counts.filter((c) => c.product_id === productId),
    movements: (history.movements || []).filter(
      (m) => m.product_id === productId,
    ),
    items: history.items.filter((i) => i.product_id === productId),
  };
  const current = inventoryAt(h, before).get(productId);
  const count = current
    ? h.counts.find((c) => c.id === current.countId) || null
    : null;
  const receipts = h.movements
    .filter(
      (m) =>
        m.kind === "purchase" &&
        Date.parse(m.occurred_at || m.occurred_on + "T00:00:00-06:00") <
          Date.parse(before),
    )
    .sort(
      (a, b) =>
        Date.parse(b.occurred_at || b.occurred_on + "T23:59:59-06:00") -
          Date.parse(a.occurred_at || a.occurred_on + "T23:59:59-06:00") ||
        String(b.created_at || "").localeCompare(String(a.created_at || "")),
    );
  const receipt = receipts[0] || null;
  const byTicket = new Map();
  for (const item of h.items) {
    const t = tickets.get(item.ticket_id);
    if (!t || Date.parse(t.ts) >= Date.parse(before)) continue;
    const sale = byTicket.get(t.id) || { ...t, qty: 0 };
    sale.qty += Number(item.qty) || 0;
    byTicket.set(t.id, sale);
  }
  const sales = [...byTicket.values()].sort(
    (a, b) => Date.parse(b.ts) - Date.parse(a.ts),
  );
  const lastSale = sales.find((t) => t.qty > 0) || null;
  if (!receipt)
    return {
      count,
      receipt: null,
      lastSale,
      beforeReceipt: null,
      afterReceipt: null,
      soldAfterReceipt: null,
    };
  const boundary =
    receipt.occurred_at || receipt.occurred_on + "T00:00:00-06:00";
  const prior = inventoryAt(h, boundary).get(productId);
  const on = receipt.occurred_on || businessDate(new Date(receipt.occurred_at));
  const soldAfterReceipt = sales
    .filter((t) =>
      receipt.occurred_at
        ? Date.parse(t.ts) > Date.parse(receipt.occurred_at)
        : businessDate(new Date(t.ts)) > on,
    )
    .reduce((sum, t) => sum + t.qty, 0);
  const interveningCount =
    current &&
    (current.countedAt
      ? Date.parse(current.countedAt) > Date.parse(boundary)
      : current.date >= on);
  const simultaneous =
    !!receipt.occurred_at &&
    (sales.some((t) => Date.parse(t.ts) === Date.parse(boundary)) ||
      h.counts.some(
        (c) =>
          c.counted_at && Date.parse(c.counted_at) === Date.parse(boundary),
      ) ||
      h.movements.some(
        (m) =>
          m !== receipt &&
          m.occurred_at &&
          Date.parse(m.occurred_at) === Date.parse(boundary),
      ));
  const uncertain = !receipt.occurred_at || !!prior?.uncertain || simultaneous;
  return {
    count,
    receipt,
    lastSale,
    beforeReceipt: prior?.value ?? null,
    afterReceipt: prior ? prior.value + Number(receipt.qty) : null,
    soldAfterReceipt,
    uncertain,
    interveningCount: !!interveningCount,
  };
}
