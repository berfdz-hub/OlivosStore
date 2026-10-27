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
7. Aplicar `supabase/migrations/2026102601_event_groups.sql`. Agrega desglose por deporte, equipo, cantidad y franjas; mantiene correcciones y propuestas anteriores. Verificar anónimo sin lectura ni escritura, operador activo limitado al alcance acordado, operador desactivado sin acceso y administrador con acceso. `schema_versions` debe incluir `2026102601`.
8. Aplicar `supabase/migrations/2026102602_activity_planner.sql`. Valida horarios aproximados, acepta el modelo v4 y borradores manuales con motivo. Conserva usuarios, datos e historial; `schema_versions` debe incluir `2026102602`.
9. Publicar el código con `vercel.json`. Si falta la migración, la app detiene la captura y reportes con un mensaje explícito.
10. Probar acceso, reportes, carga de un archivo controlado, solicitud y aprobación de corrección, los tres pasos de Compras con cantidades conocidas y desconocidas, borradores manuales y reapertura, guardado de propuesta y recuperación de contraseña. Revisar los encabezados CSP y que los SQL/CSV de desarrollo no sean servidos.

Aplicar primero seguridad es independiente del resto de la actualización. Las migraciones restantes y el frontend deben desplegarse en la misma ventana: revocan las antiguas escrituras directas. No volver a ejecutar los SQL históricos sueltos después de las migraciones; podrían restablecer permisos antiguos.

## Conciliación de históricos

- Reimportar desde los CSV originales por artículo con una cuenta administradora. El nuevo importador preserva montos, descuentos, cantidades, devoluciones y costos del recibo.
- La casilla «Conciliar recibos existentes» permite reemplazar contenido discrepante y deja registro de antes y después. Un día cerrado debe reabrirse primero.
- Ante recibos históricos duplicados el sistema se detiene y pide conciliación; la migración no elimina ventas automáticamente.
- Los registros sin precio por línea o costo original muestran cobertura incompleta de utilidad. Capturar un costo nuevo en el catálogo no altera resultados anteriores.
- Los conteos antiguos sin hora se muestran como referencias inciertas y no generan compras automáticas. Capturar un nuevo conteo con fecha y hora de Ciudad de México y registrar compras recibidas, mermas y ajustes.
- Los importes de merma valorizados al costo del catálogo son estimaciones actuales, diferenciadas de la utilidad histórica.

## Navegación

Inicio muestra los últimos siete días y pendientes, independiente de los filtros de resultados. Registrar reúne días, correcciones y existencias; Capturar día tiene la misma navegación. Compras contiene una sola recomendación y las propuestas guardadas. Resultados conserva resumen, calendario, productos, comparaciones, venta por hora, combos y estacionamiento. Catálogo y usuarios están en Administración. Los permisos y las tres cuentas existentes no cambian. Los enlaces antiguos de vistas operativa/guiada y lista de compras apuntan a Inicio o Compras.

## Preparar una compra

Compras guía en tres pasos: fecha → actividades → compra. Puebla, academia, béisbol, entrenamiento y otra actividad son atajos editables. Cada actividad reúne deporte, equipo, cantidad, horario aproximado opcional e inicios opcionales por partido. No se captura hora de fin. La cantidad vacía es desconocida; cero significa actividad sin partidos. Las horas de fin históricas ya registradas se conservan al editar si su inicio no cambia; no se convierten en datos nuevos inventados.

El modelo v4 prefiere jornadas completas de la misma composición y cantidades, incluyendo días mixtos sin finales. Cuenta su venta una sola vez, evitando repartir tickets arbitrariamente entre deportes o repetir la venta habitual. Si no hay una jornada equivalente, utiliza referencias independientes por actividad. Primero busca el mismo día de semana; solo después otros días del mismo grupo entre semana/fin de semana. No cruza ambos grupos. Prioriza inicios a ±90 minutos o el turno aproximado cuando existen referencias. No sustituye Puebla por academia ni academia por fútbol sin clasificar.

En días homogéneos con todos los inicios diferentes, aproxima ventanas de consumo entre inicios y tickets. Esos límites no son finales reales de los partidos. Con cantidad conocida pero sin horarios usa un promedio por partido. Las ventanas históricas registradas se usan solo cuando no se superponen con otras actividades. Los días mezclados ambiguos solo sirven como jornada completa equivalente; nunca se reparten por categoría sin evidencia. Entrenamientos con cero partidos se comparan con actividades sin partidos.

Cada día tiene el mismo peso aunque contenga varias ventanas. Usa hasta doce días; con cinco o más recorta los extremos de las medias diarias para reducir el efecto de valores atípicos. Excluye días futuros, el día actual y tickets incompletos. La confianza solo sube a media con al menos tres días cerrados del mismo día de semana para cada componente. Las sumas por actividad pueden incluir venta habitual o asistentes compartidos; se advierte esa limitación, sin inventar descuentos ni asistencia.

La lista principal muestra producto, venta estimada, existencias y compra. El detalle de referencias, rangos y reserva está desplegable. Aplica reserva y descuenta inventario una sola vez. La existencia incierta o negativa no equivale a cero; los perecederos sin cupos no reciben compra automática. Los cupos incluyen existencia y deben repartirse para caber en el espacio común. No se pronostican clima, agotados ni ventas entre hoy y el evento.

Si faltan referencias, conteos o límites, se puede guardar un borrador. Activar cantidades manuales exige motivo; cada cantidad y producto agregado queda marcado, conservando por separado el cálculo original. Un producto sin referencia mantiene estimación nula. Guardar no aumenta inventario ni ejecuta una compra. Reabrir usa historial e inventario actuales y conserva las decisiones manuales para revisar una nueva versión. Las propuestas guardadas son inmutables, con autor y fecha. Los borradores y decisiones manuales se excluyen de la calibración y no se presentan como precisión del modelo.

Las actividades reales se capturan en Registrar o se completan mediante correcciones con motivo e historial. No se reclasifican históricos automáticamente. La cantidad debe coincidir con estacionamiento si se capturan ambos al crear el día. Las importaciones de varios días dejan las actividades pendientes de revisión individual. La lógica de los modelos anteriores sigue disponible para evaluar sus propuestas; el usuario ya no elige entre distintos métodos de compra.

## Corregir clasificación con historial

En «Días en el periodo», «Corregir / solicitar» abre una propuesta con deporte, categoría, evento, etiquetas, notas y motivo obligatorio. El capturista puede aplicar cambios a su propia captura de hoy si está abierta. Las demás propuestas requieren aprobación; administración puede corregir directamente días abiertos. Para aprobar un día cerrado primero debe reabrirse. Una solicitud pendiente no modifica los datos; si otra persona cambió el día, se exige una propuesta actualizada.

Cada solicitud y decisión conserva autor, hora, motivo, valores antes/después y estado. Los registros aplicados muestran «Corregido» y «Ver historial». No hay permisos de editar ni borrar la bitácora desde la app; las tablas de historial también rechazan `UPDATE` y `DELETE`. Revertir exige otra corrección. La conservación a largo plazo depende además de los respaldos del proveedor. Las ventas, costos, conteos y estacionamiento no se modifican mediante este formulario y siguen bajo control administrativo; sus cambios se registran en `audit_log`. El capturista no puede sustituir un conteo existente con otro valor.

## Recuperación y trazabilidad

`audit_log` guarda actor, fecha, tabla, operación y valores antes/después; solo administración lo puede leer. Las importaciones fallidas se revierten completas por día y se pueden reintentar. `source_key` evita duplicación de un recibo y `client_ref` evita duplicación de movimientos.

El respaldo del proveedor y una restauración real deben verificarse desde el panel administrativo. Las pruebas locales de migraciones y restauración de PGlite no certifican por sí solas el respaldo de Supabase. No revertir una migración borrando columnas con datos nuevos; conservar seguridad y corregir mediante una migración posterior.
