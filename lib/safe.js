// Escape at the display boundary; never alter the stored business data.
export function escapeHTML(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

export async function selectAll(
  client,
  table,
  columns = "*",
  configure = (query) => query,
) {
  const rows = [],
    size = 500;
  for (let offset = 0; ; ) {
    const { data, error } = await configure(client.from(table).select(columns))
      .order("id", { ascending: true })
      .range(offset, offset + size - 1);
    if (error) throw new Error(`No se pudo cargar ${table}: ${error.message}`);
    if (!Array.isArray(data))
      throw new Error(`Respuesta incompleta al cargar ${table}`);
    if (!data.length) return rows;
    rows.push(...data);
    offset += data.length;
  }
}

export function associateLabels(root = document) {
  root.querySelectorAll(".field > label").forEach((label) => {
    const input = label.parentElement.querySelector(
      "input[id],select[id],textarea[id]",
    );
    if (input) label.htmlFor = input.id;
  });
}
