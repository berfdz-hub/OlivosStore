import { businessDate, parseBusinessDate } from "./csv.js";

export function timeChoice(root, prefix) {
  return root.getElementById(prefix + "Earlier").checked
    ? {
        date: root.getElementById(prefix + "Date").value,
        time: root.getElementById(prefix + "Time").value,
      }
    : { now: true };
}
export function inventoryTimestamp(choice, now = new Date()) {
  if (choice.now) return { at: now.toISOString(), on: businessDate(now) };
  const day = parseBusinessDate(choice.date + "T00:00");
  if (
    !day ||
    businessDate(day) !== choice.date ||
    choice.date > businessDate(now)
  )
    throw Error("Elige una fecha válida que no sea futura.");
  if (!choice.time) return { at: null, on: choice.date };
  const at = parseBusinessDate(choice.date + "T" + choice.time);
  if (!at || at > now) throw Error("Revisa la hora; no puede ser futura.");
  return { at: at.toISOString(), on: choice.date };
}
export function initInventoryTime(root, prefix) {
  const earlier = root.getElementById(prefix + "Earlier");
  const update = () => {
    earlier.closest(".inventory-time").querySelector("p b").textContent =
      earlier.checked ? "Fecha anterior" : "Ahora, automáticamente";
    root.getElementById(prefix + "Previous").hidden = !earlier.checked;
    root.getElementById(prefix + "Date").required = earlier.checked;
    root.getElementById(prefix + "Date").max = businessDate();
  };
  earlier.addEventListener("change", update);
  update();
  return {
    reset() {
      earlier.checked = false;
      update();
    },
    choice: () => timeChoice(root, prefix),
  };
}
