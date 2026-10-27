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

`node tests/ui-preview-server.mjs` inicia una vista de prueba en un puerto local libre (la terminal muestra la dirección). Sus cuentas, ventas, inventarios y guardados son sintéticos; **no usar este servidor como aplicación real**. El build copia exclusivamente HTML, JS de la app, estilos, configuración pública e iconos a `dist`.

## Orden obligatorio de publicación

1. Acceder al proyecto Supabase `gacxaduotkifriqlwnvt` y verificar el respaldo vigente antes de la migración. Exportar también el esquema y datos si el plan no tiene respaldo recuperable.
2. Aplicar `supabase/migrations/2026100501_security.sql`. Revoca acceso anónimo y exige cuenta activa. Las cuentas nuevas quedan pendientes; no cambia la aprobación de usuarios existentes.
3. Aplicar `supabase/migrations/2026100502_integrity.sql`. Agrega costos e importes históricos, guardado transaccional, movimientos, bitácora, cierre diario, etiquetas y versión del esquema. Los históricos sin costo original quedan desconocidos; nunca se completan usando el costo actual.
4. Aplicar `supabase/migrations/2026102001_planning_corrections.sql`. Agrega solicitudes, decisiones, propuestas de compra inmutables y límites por producto. Los productos de categoría «Comida preparada» quedan marcados como perecederos; revisar el resto del catálogo y asignar cupos antes de usar las sugerencias de comida.
5. Aplicar `supabase/migrations/2026102101_guided_planning.sql`. Permite propuestas con tipo y partidos desconocidos, conserva las respuestas del asistente y acepta el modelo v2. No cambia propuestas anteriores.
6. En Authentication desactivar el registro público. El administrador invita a las personas autorizadas y activa sus perfiles. Verificar que la URL de recuperación `https://olivos-store.vercel.app/index.html?recover=1` esté permitida.
7. Aplicar `supabase/migrations/2026102601_event_groups.sql`. Agrega desglose por deporte, equipo, cantidad y franjas; mantiene correcciones y propuestas anteriores. Verificar anónimo sin lectura ni escritura, operador activo limitado al alcance acordado, operador desactivado sin acceso y administrador con acceso. `schema_versions` debe incluir `2026102601`.
8. Aplicar `supabase/migrations/2026102602_activity_planner.sql`. Valida horarios aproximados, acepta el modelo v4 y borradores manuales con motivo. Conserva usuarios, datos e historial; `schema_versions` debe incluir `2026102602`.
9. Aplicar `supabase/migrations/2026102603_journeys.sql`: actividades estructuradas, cancelaciones, versión e historial del calendario; conteos independientes; guardado de compras con revisión de agenda. `schema_versions` debe incluir `2026102603`. Se conserva la agenda anterior; la hora deja de ser obligatoria.
10. Aplicar `supabase/migrations/2026102604_inventory_clarity.sql`. Agrega fechas de inventario sin hora conocida y fecha de registro para los conteos nuevos. No modifica registros históricos. Conserva los permisos existentes y la bitácora; exige `schema_versions` con `2026102604`.
11. Aplicar `supabase/migrations/2026102701_read_only_views.sql`. Restringe las tres vistas de lectura a `SELECT`, revocando los permisos de escritura heredados de Supabase, y agrega barreras de seguridad a las dos vistas con permisos del propietario. No modifica ventas, inventario, precios ni cuentas. La migración siguiente completa la sustitución de esas dos vistas.
12. Publicar primero la lectura del catálogo administrativo desde `products_view` incluida en esta versión, compatible con el esquema anterior. Después aplicar `supabase/migrations/2026102702_invoker_views.sql`. Convierte `products_view` y `ticket_items_view` a `security_invoker=true`, respetando RLS y conservando sus columnas y los permisos funcionales. Protege los costos mediante permisos por columna y funciones acotadas del esquema `olivos_private`, que no debe exponerse en la Data API. Verificar que desaparezcan las dos alertas `Security Definer View`, que las lecturas de las tres cuentas administradoras coincidan con el respaldo y que no cambie ninguna fila de negocio.
13. Aplicar `supabase/migrations/2026102703_parking_corrections.sql`. Agrega versiones de registros de estacionamiento, solicitudes y decisiones inmutables. No mueve registros existentes. Probar el traslado en una copia restaurada y comparar todas las tablas; cualquier cambio real debe usar la herramienta con motivo e identidad de quien lo realiza.
14. Publicar el código con `vercel.json`. Si falta una migración exigida por la app, detiene la captura y reportes con un mensaje explícito.
15. Probar acceso, reportes, carga de un archivo controlado, solicitud y aprobación de corrección, los tres pasos de Compras con cantidades conocidas y desconocidas, borradores manuales y reapertura, guardado de propuesta y recuperación de contraseña. Revisar los encabezados CSP y que los SQL/CSV de desarrollo no sean servidos.

Aplicar primero seguridad es independiente del resto de la actualización. Las migraciones restantes y el frontend deben desplegarse en la misma ventana: revocan las antiguas escrituras directas. No volver a ejecutar los SQL históricos sueltos después de las migraciones; podrían restablecer permisos antiguos.

## Conciliación de históricos

- Reimportar desde los CSV originales por artículo con una cuenta administradora. El nuevo importador preserva montos, descuentos, cantidades, devoluciones y costos del recibo.
- La casilla «Conciliar recibos existentes» permite reemplazar contenido discrepante y deja registro de antes y después. Un día cerrado debe reabrirse primero.
- Ante recibos históricos duplicados el sistema se detiene y pide conciliación; la migración no elimina ventas automáticamente.
- Los registros sin precio por línea o costo original muestran cobertura incompleta de utilidad. Capturar un costo nuevo en el catálogo no altera resultados anteriores.
- Los conteos antiguos sin hora se muestran como referencias inciertas y no generan compras automáticas. El conteo y los movimientos nuevos usan «Ahora» automáticamente; al capturar algo anterior se puede dejar la hora vacía. Se conserva la incertidumbre cuando no se puede ordenar el movimiento con un conteo. Un conteo posterior al registro de ese movimiento restablece la referencia.
- Los importes de merma valorizados al costo del catálogo son estimaciones actuales, diferenciadas de la utilidad histórica.

## Navegación

Jornadas reúne el calendario, las actividades y el acceso a la captura de ventas y correcciones. Compras guía fecha, actividades y lista de compra; Inventario reúne conteos y movimientos. Reportes conserva resumen, productos, comparaciones, venta por hora, combos y estacionamiento. Catálogo y usuarios están en Administración. Los permisos y las tres cuentas existentes no cambian. Los enlaces antiguos de Inicio y vistas operativa/guiada apuntan a Jornadas.

## Preparar una compra

Compras guía en tres pasos: fecha → actividades → compra. Puebla, academia, béisbol, entrenamiento y otra actividad son atajos editables. Cada actividad reúne deporte, equipo, cantidad, horario aproximado opcional e inicios opcionales por partido. No se captura hora de fin. La cantidad vacía es desconocida; cero significa actividad sin partidos. Las horas de fin históricas ya registradas se conservan al editar si su inicio no cambia; no se convierten en datos nuevos inventados.

El modelo v4 prefiere jornadas completas de la misma composición y cantidades, incluyendo días mixtos sin finales. Cuenta su venta una sola vez, evitando repartir tickets arbitrariamente entre deportes o repetir la venta habitual. Si no hay una jornada equivalente, utiliza referencias independientes por actividad. Primero busca el mismo día de semana; solo después otros días del mismo grupo entre semana/fin de semana. No cruza ambos grupos. Prioriza inicios a ±90 minutos o el turno aproximado cuando existen referencias. No sustituye Puebla por academia ni academia por fútbol sin clasificar.

En días homogéneos con todos los inicios diferentes, aproxima ventanas de consumo entre inicios y tickets. Esos límites no son finales reales de los partidos. Con cantidad conocida pero sin horarios usa un promedio por partido. Las ventanas históricas registradas se usan solo cuando no se superponen con otras actividades. Los días mezclados ambiguos solo sirven como jornada completa equivalente; nunca se reparten por categoría sin evidencia. Entrenamientos con cero partidos se comparan con actividades sin partidos.

Cada día tiene el mismo peso aunque contenga varias ventanas. Usa hasta doce días; con cinco o más recorta los extremos de las medias diarias para reducir el efecto de valores atípicos. Excluye días futuros, el día actual y tickets incompletos. La confianza solo sube a media con al menos tres días cerrados del mismo día de semana para cada componente. Las sumas por actividad pueden incluir venta habitual o asistentes compartidos; se advierte esa limitación, sin inventar descuentos ni asistencia.

La lista principal muestra producto, venta estimada, existencias y compra. El detalle de referencias, rangos y reserva está desplegable. Aplica reserva y descuenta inventario una sola vez. La existencia incierta o negativa no equivale a cero; los perecederos sin cupos no reciben compra automática. Los cupos incluyen existencia y deben repartirse para caber en el espacio común. No se pronostican clima, agotados ni ventas entre hoy y el evento.

Si faltan referencias, conteos o límites, se puede guardar un borrador. Activar cantidades manuales exige motivo; cada cantidad y producto agregado queda marcado, conservando por separado el cálculo original. Un producto sin referencia mantiene estimación nula. Guardar no aumenta inventario ni ejecuta una compra. Reabrir usa historial e inventario actuales y conserva las decisiones manuales para revisar una nueva versión. Las propuestas guardadas son inmutables, con autor y fecha. Los borradores y decisiones manuales se excluyen de la calibración y no se presentan como precisión del modelo.

Las actividades reales se capturan en Registrar o se completan mediante correcciones con motivo e historial. No se reclasifican históricos automáticamente. El estacionamiento puede cubrir solo algunos partidos, pero no superar el total de actividades confirmadas. Las importaciones de varios días dejan las actividades pendientes de revisión individual. La lógica de los modelos anteriores sigue disponible para evaluar sus propuestas; el usuario ya no elige entre distintos métodos de compra.

## Corregir clasificación con historial

En «Días en el periodo», «Corregir / solicitar» abre una propuesta con deporte, categoría, evento, etiquetas, notas y motivo obligatorio. El capturista puede aplicar cambios a su propia captura de hoy si está abierta. Las demás propuestas requieren aprobación; administración puede corregir directamente días abiertos. Para aprobar un día cerrado primero debe reabrirse. Una solicitud pendiente no modifica los datos; si otra persona cambió el día, se exige una propuesta actualizada.

Cada solicitud y decisión conserva autor, hora, motivo, valores antes/después y estado. Los registros aplicados muestran «Corregido» y «Ver historial». No hay permisos de editar ni borrar la bitácora desde la app; las tablas de historial también rechazan `UPDATE` y `DELETE`. Revertir exige otra corrección. La conservación a largo plazo depende además de los respaldos del proveedor. Las ventas, costos, conteos y estacionamiento no se modifican mediante este formulario y siguen bajo control administrativo; sus cambios se registran en `audit_log`. El capturista no puede sustituir un conteo existente con otro valor.

## Inventario y resumen — versión 2026102604

Inventario muestra el saldo estimado, la compra para una jornada y el último surtido. Los conteos históricos sí generan cantidades visibles: conteo + movimientos − ventas netas. «Estimada» identifica referencias inciertas; los saldos negativos se muestran como «Saldo a revisar» y los productos sin referencia como «Sin conteo», sin convertirlos en cero. Los conteos sin hora usan las ventas desde el día siguiente, con esa limitación explicada en el detalle. Los filtros separan estos estados y la búsqueda admite nombres y categorías sin exigir acentos.

Cada producto abre sus conteos, entradas, ventas, devoluciones, mermas y cálculo; administración también puede consultar autor y valores antes/después en la bitácora. La comparación física muestra la diferencia frente al saldo estimado sin guardar ni atribuirla a pérdidas. El historial de variaciones y los productos inactivos siguen disponibles. Las acciones de surtido, conteo, merma, ajuste e importación están al inicio; calcular compras y explicar el método son controles desplegables.

Seleccionar una compra guardada actualiza lo que falta con las existencias actuales, conservando la propuesta original y señalando las cantidades manuales para revisión. Los productos sin referencia quedan pendientes. Recibir mercancía pide producto y cantidad; la hora se registra automáticamente. Para capturas anteriores la fecha es obligatoria y la hora opcional. Si no se conoce, se guarda como desconocida, sin inventarla. Mermas y ajustes requieren motivo; los reintentos conservan la misma identidad y fecha para evitar duplicados.

Jornadas recupera las ventas, tickets y producto más vendido de los últimos siete días, además de pendientes y próxima compra. Sus pendientes distinguen saldos negativos y ausencia de conteo. La interfaz se comprobó en escritorio y anchos móviles de 390 y 320 píxeles. Pasan 76 pruebas automatizadas, las auditorías de DOM e importaciones y la compilación. La migración se ensayó sobre un respaldo restaurado y se verificaron guardados, reintentos y bitácora en producción dentro de una transacción revertida. La revisión posterior de presentación no modifica la base de datos ni convierte estimaciones inciertas en inventario confiable para compras automáticas.

## Recuperación y trazabilidad

`audit_log` guarda actor, fecha, tabla, operación y valores antes/después; solo administración lo puede leer. Las importaciones fallidas se revierten completas por día y se pueden reintentar. `source_key` evita duplicación de un recibo y `client_ref` evita duplicación de movimientos.

El respaldo del proveedor y una restauración real deben verificarse desde el panel administrativo. Las pruebas locales de migraciones y restauración de PGlite no certifican por sí solas el respaldo de Supabase. No revertir una migración borrando columnas con datos nuevos; conservar seguridad y corregir mediante una migración posterior.

Desde `2026102702`, un respaldo lógico de aplicación debe incluir también el esquema `olivos_private`, sus funciones y permisos, y los permisos por columna de `public`. Todos los datos de negocio permanecen en sus tablas originales. Las vistas públicas conservan el contrato de lectura: los costos se muestran según la configuración y el historial según el alcance de cada cuenta. Consultar `SELECT *` directamente sobre `products` o `ticket_items` con una cuenta autenticada se rechaza porque incluiría costos sin su filtro; la app lee las vistas. Administración sigue creando y editando productos en la tabla original sin solicitar columnas de retorno. Las funciones de costos comprueban cuenta, configuración y, para partidas, acceso al día, con `search_path` fijo y objetos calificados.

Las pruebas SQL cubren administradores, capturistas, cuentas inactivas y anónimas; las cuatro combinaciones de visibilidad de costos e historial; escrituras del catálogo; intento de leer o filtrar por costos directamente; y acceso a partidas mediante identificadores conocidos. La migración se ensaya con un respaldo restaurado y se comparan filas completas antes y después. El control de publicación verifica que los datos no hayan cambiado desde el respaldo y revierte la transacción completa si encuentra una discrepancia.


## Jornadas y calendario — publicación 2026102603

La navegación principal tiene Jornadas, Compras, Inventario y Reportes. Las rutas anteriores Inicio y Calendario abren Jornadas. En computadora el mes y el detalle de fecha aparecen juntos; en celular comienza con una lista de fechas con actividades y permite abrir el mes completo o elegir cualquier fecha.

Administración puede agregar varias actividades, editar con motivo, cancelar conservando la bitácora y copiar una jornada a una fecha vacía. Las escrituras usan funciones transaccionales con versión e idempotencia. La lectura sigue disponible para cuentas activas; las tres cuentas administradoras existentes no cambian de rol. El historial consulta todos los cambios de las actividades de la fecha, incluso las canceladas.

Compras incorpora lo agendado, permite excluir o ajustar solo para esa compra y añadir extras. Cambiar de fecha limpia los extras de la fecha anterior. Al recargar la agenda se conservan los extras, pero se reemplazan los ajustes y exclusiones de actividades agendadas. Si cambió el calendario, se muestra la agenda actual y se pide revisar o recargar; el servidor vuelve a verificar su versión al guardar. Las compras anteriores siguen inmutables. El calendario por sí solo no se usa como evidencia de venta.

Capturar una nueva jornada exige confirmar las actividades reales. Las existentes se corrigen mediante el flujo con historial; agregar recibos conserva su clasificación. El conteo tiene una entrada propia desde Inventario, admite búsqueda e importación y no crea días de venta. Productos nuevos en un archivo de existencias deben darse de alta primero en Catálogo. La existencia incluye esos conteos y descuenta ventas posteriores.

Publicado con autorización del propietario el 26 de octubre de 2026 en https://olivos-store.vercel.app. Se exportó y restauró el esquema público y sus datos antes de aplicar la migración transaccional con verificación del respaldo. Las pruebas de funciones en producción se ejecutaron dentro de una transacción revertida: calendario, edición, cancelación e historial, copia, reintentos, rechazo de una compra con agenda desactualizada y conteo independiente. Se conservaron 2,119 tickets, 3,555 artículos, 122 días y las tres cuentas administradoras. El respaldo de aplicación no incluye Auth ni Storage.

La revisión en navegador cubre escritorio y anchos móviles de 390 y 320 píxeles; no sustituye una prueba en un dispositivo físico. Jornadas carga antes que el historial, las lecturas se hacen en lotes paralelos limitados y las compras se muestran como tarjetas en celular. Las 65 pruebas automatizadas, auditorías de DOM/importación y compilación pasan. La vista local sigue usando datos sintéticos; no captura ventas reales.

## Detalle de inventario y estacionamiento (27 de octubre)

Inventario conserva la vista sencilla y agrega Vista ampliada: saldo anterior al último surtido, entrada, saldo posterior, ventas netas posteriores, última venta y último conteo/carga. Una carga de existencias reemplaza el saldo; no se convierte en compra. Sin hora conocida se muestra la incertidumbre y las ventas posteriores se cuentan desde el día siguiente. Los conteos posteriores al surtido se señalan porque vuelven a establecer el saldo actual. El detalle reúne los últimos registros y mantiene los historiales y la comprobación física.

Estacionamiento muestra tarifa por auto, autos cobrados, ingreso de estacionamiento, venta de tienda, total combinado y promedios por auto del lote. Los autos exentos están incluidos en el denominador; por eso el ingreso medio de estacionamiento puede ser menor que la tarifa. Las ventas de tienda se atribuyen por ventanas sin duplicar tickets. Partidos simultáneos o importes ocultos quedan sin atribución en lugar de recibir ceros inventados. El total presupone que los tickets de tienda no incluyen el cobro de estacionamiento.

## Corregir estacionamiento — versión 2026102703

En Reportes → Estacionamiento, «Cambiar fecha de un día» traslada todos los registros de estacionamiento de esa fecha en una sola operación. «Corregir» en cada tarjeta o fila permite editar fecha, hora, autos en el lote, autos cobrados, tarifa, condición de cobro y notas. La fecha destino debe tener una jornada registrada y visible para la cuenta. Las ventas, inventarios, actividades, fechas de jornadas y registros originales conservan su identidad; no se borran jornadas vacías ni se inventan actividades.

Administración aplica con motivo obligatorio. El capturista envía una solicitud, que no modifica los registros hasta que administración la aprueba. La cuenta debe seguir activa; para aplicar se exige que origen y destino estén abiertos. No se combinan registros cuando ya existe otro a la misma hora, ni se admite superar el número de partidos confirmado del destino. Los cambios se muestran antes de guardar, y el servidor vuelve a validar todos los valores.

«Correcciones e historial» conserva autor, fecha, motivo, valores anteriores y nuevos y, cuando procede, la decisión administrativa. Las tarjetas corregidas quedan marcadas. Cada usuario ve sus solicitudes y administración puede verlas todas. Un cambio posterior exige otra corrección; no se permite editar ni borrar el historial desde la aplicación. La bitácora administrativa también registra cada fila modificada. La conservación a largo plazo exige mantener respaldos.

Las versiones detectan modificaciones concurrentes, incluso si alguien restableció un valor anterior. Los reintentos reutilizan una identidad de operación y no duplican registros ni cobros. Las pruebas cubren traslado de tres registros, conservación de tickets e inventario, autorizaciones, aprobación/rechazo, cierres, conflictos de horario, cambios obsoletos, entradas inválidas, historial inmutable y presentación en escritorio y celular.
