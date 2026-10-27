const reportPanes = [
  "resumen",
  "calendario",
  "productos",
  "calor",
  "combos",
  "comparativa",
  "estacionamiento",
  "glosario",
];
const aliases = {
  operacion: "inicio",
  guiada: "inicio",
  compras: "planificador",
};
export function showSection(root, requested, isAdmin = false) {
  let name = aliases[requested] || requested;
  if (
    ![
      "inicio",
      "registro",
      "planificador",
      "inventario",
      "catalogo",
      "usuarios",
      ...reportPanes,
    ].includes(name)
  )
    name = "inicio";
  if (["catalogo", "usuarios"].includes(name) && !isAdmin) name = "inicio";
  const section = reportPanes.includes(name)
    ? "resumen"
    : name === "inventario"
      ? "registro"
      : name;
  root
    .querySelectorAll(".pane")
    .forEach((p) => p.classList.toggle("on", p.id === "pane-" + name));
  root.getElementById("reportFilters").hidden =
    !reportPanes.includes(name) && name !== "registro";
  root.getElementById("tabbar").hidden = !reportPanes.includes(name);
  root.getElementById("registerNav").hidden = section !== "registro";
  const note = root.getElementById("reportScopeNote");
  note.hidden = !note.textContent || !["registro", "resumen"].includes(section);
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
