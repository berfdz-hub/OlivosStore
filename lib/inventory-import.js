// Prepare a single atomic request: selecting a file never writes to the catalogue.
export function inventoryCountRows(rows, sourceFile = null) {
  return rows.map(({ product, quantity, source }) => {
    if (!Number.isFinite(quantity) || quantity < 0)
      throw Error(`Revisa la cantidad de ${product.raw}.`);
    const imported = product.physical_count != null && !!sourceFile;
    if (!product.product_id && !imported)
      throw Error(
        "Selecciona un producto del catálogo o importa el archivo de existencias.",
      );
    if (
      !product.product_id &&
      (product.sell_price == null ||
        !Number.isFinite(product.sell_price) ||
        product.sell_price < 0)
    )
      throw Error(
        `El archivo no trae un precio válido para ${product.raw}. Completa su precio en Loyverse y vuelve a exportarlo.`,
      );
    if (
      !product.product_id &&
      product.cost_price != null &&
      (!Number.isFinite(product.cost_price) || product.cost_price < 0)
    )
      throw Error(`Revisa el costo de ${product.raw} en el archivo.`);
    return {
      product_id: product.product_id || null,
      physical_count: quantity,
      count_source: source,
      ...(imported
        ? {
            raw: product.raw,
            external_ref: product.external_ref || null,
            category: product.category || "Otro",
            sell_price: product.sell_price ?? null,
            cost_price: product.cost_price ?? null,
            source_file: sourceFile,
          }
        : {}),
    };
  });
}
