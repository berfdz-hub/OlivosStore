export const REQUIRED_SCHEMA_VERSION = 2026102601;
export async function checkSchema(client) {
  const { data, error } = await client
    .from("schema_versions")
    .select("version")
    .eq("version", REQUIRED_SCHEMA_VERSION)
    .maybeSingle();
  if (error || !data)
    throw new Error(
      "La actualización de la base de datos está pendiente. Contacta al administrador; tus datos no se han modificado.",
    );
}
export async function saveDay(
  client,
  { day, tickets = [], games = [], counts = [], replaceExisting = false },
) {
  const { data, error } = await client.rpc("save_sale_day", {
    p_day: day,
    p_tickets: tickets,
    p_games: games,
    p_counts: counts,
    p_replace_existing: replaceExisting,
  });
  if (error) throw new Error(error.message);
  if (!data?.day_id)
    throw new Error(
      "No se confirmó el guardado. Conserva el archivo y vuelve a intentar; los recibos ya guardados no se duplicarán.",
    );
  return data;
}
