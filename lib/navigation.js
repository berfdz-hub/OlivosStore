const reportPanes = [
  "resumen",
  "productos",
  "calor",
  "combos",
  "comparativa",
  "estacionamiento",
  "glosario",
];
const aliases = {
  inicio: "jornadas",
  calendario: "jornadas",
  operacion: "jornadas",
  guiada: "jornadas",
  compras: "planificador",
};
export function showSection(root, requested, isAdmin = false) {
  let name = aliases[requested] || requested;
  if (
    ![
      "jornadas",
      "registro",
      "planificador",
      "inventario",
      "catalogo",
      "usuarios",
      ...reportPanes,
    ].includes(name)
  )
    name = "jornadas";
  if (["catalogo", "usuarios"].includes(name) && !isAdmin) name = "jornadas";
  const section = reportPanes.includes(name)
    ? "resumen"
    : name === "registro"
      ? "jornadas"
      : name;
  root
    .querySelectorAll(".pane")
    .forEach((p) => p.classList.toggle("on", p.id === "pane-" + name));
  root.getElementById("reportFilters").hidden =
    !reportPanes.includes(name) && name !== "registro";
  root.getElementById("tabbar").hidden = !reportPanes.includes(name);
  root.getElementById("registerNav").hidden = name !== "registro";
  const note = root.getElementById("reportScopeNote");
  note.hidden =
    !note.textContent || !(name === "registro" || section === "resumen");
  root.querySelectorAll("#dashboardModes [data-view]").forEach((b) => {
    const selected = b.dataset.view === section;
    b.classList.toggle("on", selected);
    b.setAttribute("aria-current", selected ? "page" : "false");
  });
  root
    .querySelectorAll("#tabbar [data-tab], #registerNav [data-tab]")
    .forEach((b) => {
      b.classList.toggle("on", b.dataset.tab === name);
      b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false");
    });
  return name;
}
