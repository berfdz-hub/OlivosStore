-- ============================================================
-- Agrega un interruptor global: "¿los operadores ven costos y
-- utilidad en los reportes?" Por ahora queda en SÍ (true), y hay
-- un switch en Usuarios (solo admin) para apagarlo cuando quieras.
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

-- 1. tabla de configuración global (una sola fila)
create table public.app_settings (
  id boolean primary key default true check (id),
  operators_see_costs boolean not null default true
);
insert into public.app_settings (id, operators_see_costs) values (true, true);

alter table public.app_settings enable row level security;
create policy "app_settings_select" on public.app_settings
  for select using (auth.uid() is not null);
create policy "app_settings_update" on public.app_settings
  for update using (public.is_admin());

-- 2. función: ¿el usuario actual puede ver costos?
--    admin siempre puede; operador solo si el interruptor está en true.
create or replace function public.can_see_costs()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true
      and (p.role = 'admin' or (select operators_see_costs from public.app_settings limit 1))
  );
$$;

-- 3. la vista de productos ahora usa can_see_costs() en vez de is_admin()
create or replace view public.products_view
with (security_invoker = true) as
select
  id, name, category, sell_price, active,
  case when public.can_see_costs() then cost_price else null end as cost_price
from public.products;
