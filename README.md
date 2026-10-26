# Olivos Store

Aplicación estática con Supabase. La lógica de importación, permisos, cierre de días y registro de cambios se valida en PostgreSQL. El navegador prepara archivos y muestra los resultados.

## Desarrollo y pruebas

Node 24 y pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
```

Las pruebas SQL usan PostgreSQL embebido (PGlite), con roles anónimo, operador, administrador y usuario desactivado. No se conectan a producción. Las pruebas de pantallas usan un DOM aislado y textos hostiles. `tests/import-audit.mjs` también verifica los CSV históricos locales si están disponibles; estos no se publican ni son necesarios para CI.

`node tests/ui-preview-server.mjs` inicia una vista de prueba en `http://127.0.0.1:8765`. Sus cuentas, ventas, inventarios y guardados son sintéticos; **no usar este servidor como aplicación real**. El build copia exclusivamente HTML, JS de la app, estilos, configuración pública e iconos a `dist`.

## Orden obligatorio de publicación

1. Acceder al proyecto Supabase `gacxaduotkifriqlwnvt` y verificar el respaldo vigente antes de la migración. Exportar también el esquema y datos si el plan no tiene respaldo recuperable.
2. Aplicar `supabase/migrations/2026100501_security.sql`. Revoca acceso anónimo y exige cuenta activa. Las cuentas nuevas quedan pendientes; no cambia la aprobación de usuarios existentes.
3. Aplicar `supabase/migrations/2026100502_integrity.sql`. Agrega costos e importes históricos, guardado transaccional, movimientos, bitácora, cierre diario, etiquetas y versión del esquema. Los históricos sin costo original quedan desconocidos; nunca se completan usando el costo actual.
4. Aplicar `supabase/migrations/2026102001_planning_corrections.sql`. Agrega solicitudes, decisiones, propuestas de compra inmutables y límites por producto. Los productos de categoría «Comida preparada» quedan marcados como perecederos; revisar el resto del catálogo y asignar cupos antes de usar las sugerencias de comida.
5. Aplicar `supabase/migrations/2026102101_guided_planning.sql`. Permite propuestas con tipo y partidos desconocidos, conserva las respuestas del asistente y acepta el modelo v2. No cambia propuestas anteriores.
6. En Authentication desactivar el registro público. El administrador invita a las personas autorizadas y activa sus perfiles. Verificar que la URL de recuperación `https://olivos-store.vercel.app/index.html?recover=1` esté permitida.
7. Verificar anónimo sin lectura ni escritura, operador activo limitado al alcance acordado, operador desactivado sin acceso y administrador con acceso. `schema_versions` debe incluir `2026102101`.
8. Publicar el código con `vercel.json`. Si falta la migración, la app detiene la captura y reportes con un mensaje explícito.
9. Probar acceso, reportes, carga de un archivo controlado, solicitud y aprobación de corrección, los cinco pasos del planificador con respuestas conocidas y desconocidas, guardado de propuesta y recuperación de contraseña. Revisar los encabezados CSP y que los SQL/CSV de desarrollo no sean servidos.

Aplicar primero seguridad es independiente del resto de la actualización. Las migraciones restantes y el frontend deben desplegarse en la misma ventana: revocan las antiguas escrituras directas. No volver a ejecutar los SQL históricos sueltos después de las migraciones; podrían restablecer permisos antiguos.

## Conciliación de históricos

- Reimportar desde los CSV originales por artículo con una cuenta administradora. El nuevo importador preserva montos, descuentos, cantidades, devoluciones y costos del recibo.
- La casilla «Conciliar recibos existentes» permite reemplazar contenido discrepante y deja registro de antes y después. Un día cerrado debe reabrirse primero.
- Ante recibos históricos duplicados el sistema se detiene y pide conciliación; la migración no elimina ventas automáticamente.
- Los registros sin precio por línea o costo original muestran cobertura incompleta de utilidad. Capturar un costo nuevo en el catálogo no altera resultados anteriores.
- Los conteos antiguos sin hora se muestran como referencias inciertas y no generan compras automáticas. Capturar un nuevo conteo con fecha y hora de Ciudad de México y registrar compras recibidas, mermas y ajustes.
- Los importes de merma valorizados al costo del catálogo son estimaciones actuales, diferenciadas de la utilidad histórica.

## Preparar una compra

La sección independiente «Planificar compra» (`reportes.html#planificador`) guía en cinco pasos: fecha, tipo de evento, partidos, equipo y revisión. Prepara una fecha por propuesta y calcula automáticamente el día de la semana. Se puede regresar sin perder respuestas; editar una respuesta invalida el resultado anterior hasta volver a calcular. Los filtros de los reportes no cambian esta propuesta.

La fecha es obligatoria. El tipo de evento se puede dejar sin especificar. En partidos, «No lo sé» no filtra por cantidad y «No aplica» significa cero partidos; la ausencia de partidos en un histórico no prueba que fueran cero, salvo días clasificados como entrenamiento. En equipo, «No aplica» y «No lo sé» no filtran; el nombre elegido se busca en nombres de eventos anteriores, ignorando mayúsculas y acentos, y Club Puebla también en su etiqueta. Si ese equipo no tiene referencias, se informa sin sustituirlo automáticamente. No se infieren equipos de tickets ni se agrupan alias distintos.

Con datos conocidos, el cálculo busca primero el mismo día de la semana y número de partidos; si faltan tres referencias, amplía hasta un partido de diferencia o a otros días del mismo grupo (entre semana / fin de semana). Nunca cruza esos dos grupos ni multiplica linealmente ventas por partidos. Club Puebla tiene su propio grupo. Los datos desconocidos amplían la comparación, se explican en el resultado y mantienen confianza baja. Usa las últimas 12 referencias anteriores al evento y al día actual; excluye recibos sin detalle identificable. Muestra las fechas y si los días todavía están abiertos.

La propuesta muestra venta esperada, rango observado (no un intervalo estadístico de confianza), colchón, existencia actual, compra sugerida y cantidad revisada por el encargado. La existencia desconocida o negativa no se toma como cero. La existencia es la disponible ahora; si habrá ventas antes del evento hay que actualizar los movimientos y volver a calcular. No estima asistencia, clima, demanda perdida por agotados ni ventas entre hoy y el evento.

El catálogo permite asignar un cupo de almacenamiento y, para perecederos, un máximo que se pueda vender antes de caducar. Ambos incluyen la existencia actual. Si faltan esos límites en un perecedero, la app pide configurarlos antes de sugerir compra. Los cupos deben repartirse entre productos para caber en el congelador compartido; no se conocen volúmenes ni caducidades por lote. Guardar una propuesta conserva los valores originales, sin crear una compra ni modificar inventario.

Después del evento se compara la última propuesta anterior al inicio del evento (o a la primera venta si falta hora) con ventas de un día cerrado y completo. La evaluación exige coincidencia de los datos especificados: tipo de evento, partidos y equipo. Incluye productos vendidos que no fueron previstos. Con al menos tres resultados del mismo modelo, tipo, equipo, día de semana y número conocido de partidos, aplica una corrección por producto de como máximo ±25%. Las propuestas con tipo o cantidad desconocidos se pueden evaluar, pero no calibran el modelo. Es un ajuste descriptivo y conservador, no una garantía de demanda.

## Corregir clasificación con historial

En «Días en el periodo», «Corregir / solicitar» abre una propuesta con deporte, categoría, evento, etiquetas, notas y motivo obligatorio. El capturista puede aplicar cambios a su propia captura de hoy si está abierta. Las demás propuestas requieren aprobación; administración puede corregir directamente días abiertos. Para aprobar un día cerrado primero debe reabrirse. Una solicitud pendiente no modifica los datos; si otra persona cambió el día, se exige una propuesta actualizada.

Cada solicitud y decisión conserva autor, hora, motivo, valores antes/después y estado. Los registros aplicados muestran «Corregido» y «Ver historial». No hay permisos de editar ni borrar la bitácora desde la app; las tablas de historial también rechazan `UPDATE` y `DELETE`. Revertir exige otra corrección. La conservación a largo plazo depende además de los respaldos del proveedor. Las ventas, costos, conteos y estacionamiento no se modifican mediante este formulario y siguen bajo control administrativo; sus cambios se registran en `audit_log`. El capturista no puede sustituir un conteo existente con otro valor.

## Recuperación y trazabilidad

`audit_log` guarda actor, fecha, tabla, operación y valores antes/después; solo administración lo puede leer. Las importaciones fallidas se revierten completas por día y se pueden reintentar. `source_key` evita duplicación de un recibo y `client_ref` evita duplicación de movimientos.

El respaldo del proveedor y una restauración real deben verificarse desde el panel administrativo. Las pruebas locales de migraciones y restauración de PGlite no certifican por sí solas el respaldo de Supabase. No revertir una migración borrando columnas con datos nuevos; conservar seguridad y corregir mediante una migración posterior.
