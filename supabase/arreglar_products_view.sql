-- ============================================================
-- Arregla products_view: estaba creada con security_invoker=true,
-- lo que hacia que heredara el permiso "solo admin" de la tabla
-- products de abajo -- un operador obtenia SIEMPRE una lista vacia
-- de productos (por eso ningun producto del CSV emparejaba, sin
-- importar el formato del archivo).
--
-- Con security_invoker=false (el default de Postgres) la vista
-- corre con permisos del dueño (bypassa el RLS de la tabla base
-- para leerla), y el enmascarado de costo lo sigue haciendo el
-- CASE WHEN can_see_costs() de adentro -- eso no cambia.
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

create or replace view public.products_view
with (security_invoker = false) as
select
  id, name, category, sell_price, active,
  case when public.can_see_costs() then cost_price else null end as cost_price
from public.products;

grant select on public.products_view to authenticated;
