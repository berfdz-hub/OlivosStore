-- ============================================================
-- Dos interruptores globales para lo que ve un OPERADOR, controlados
-- por el admin en la pestaña Usuarios:
--   1) ¿ve costos y utilidad en los reportes?           (default: SÍ)
--   2) ¿ve el historial completo, o solo el día más reciente?  (default: NO, solo el ultimo dia)
-- Corre esto UNA VEZ, completo, en el SQL Editor de Supabase.
-- Es seguro correrlo aunque antes hayas intentado correr una version anterior y fallara.
-- ============================================================

-- 1. tabla de configuración global (una sola fila)
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  operators_see_costs boolean not null default true,
  operators_see_all_days boolean not null default false
);

-- si la tabla ya existia de un intento anterior, asegura que tenga la columna nueva
alter table public.app_settings
  add column if not exists operators_see_all_days boolean not null default false;

insert into public.app_settings (id, operators_see_costs, operators_see_all_days)
values (true, true, false)
on conflict (id) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists "app_settings_select" on public.app_settings;
create policy "app_settings_select" on public.app_settings
  for select using (auth.uid() is not null);
drop policy if exists "app_settings_update" on public.app_settings;
create policy "app_settings_update" on public.app_settings
  for update using (public.is_admin());

-- 2. funciones: ¿el usuario actual puede ver costos? ¿puede ver todos los dias?
create or replace function public.can_see_costs()
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true
      and (p.role = 'admin' or (select operators_see_costs from public.app_settings limit 1))
  );
$$;

create or replace function public.can_see_all_days()
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true
      and (p.role = 'admin' or (select operators_see_all_days from public.app_settings limit 1))
  );
$$;

-- funciones que calculan "el dia mas reciente" SIN disparar RLS sobre
-- sale_days (si se hace inline dentro de la politica de sale_days, la
-- politica termina consultandose a si misma y Postgres tira
-- "infinite recursion detected in policy for relation sale_days").
create or replace function public.latest_sale_day_id()
returns uuid
language sql security definer stable set search_path = public
as $$
  select id from public.sale_days order by date desc limit 1;
$$;

create or replace function public.latest_sale_day_date()
returns date
language sql security definer stable set search_path = public
as $$
  select max(date) from public.sale_days;
$$;

-- 3. la vista de productos ya usa can_see_costs() (por si no quedo de un intento previo).
--    security_invoker=false para que la vista pueda leer la tabla de
--    abajo aunque el que consulta no sea admin (si no, un operador
--    siempre recibia una lista vacia de productos).
create or replace view public.products_view
with (security_invoker = false) as
select
  id, name, category, sell_price, active,
  case when public.can_see_costs() then cost_price else null end as cost_price
from public.products;

grant select on public.products_view to authenticated;

-- 4. restringe sale_days y todo lo que cuelga de un dia a "solo el mas
--    reciente" cuando el interruptor de historial esta apagado.
drop policy if exists "sale_days_select" on public.sale_days;
create policy "sale_days_select" on public.sale_days
  for select using (
    public.can_see_all_days()
    or date = public.latest_sale_day_date()
  );

drop policy if exists "games_select" on public.games;
create policy "games_select" on public.games
  for select using (
    public.can_see_all_days()
    or sale_day_id = public.latest_sale_day_id()
  );

drop policy if exists "tickets_select" on public.tickets;
create policy "tickets_select" on public.tickets
  for select using (
    public.can_see_all_days()
    or sale_day_id = public.latest_sale_day_id()
  );

drop policy if exists "ticket_items_select" on public.ticket_items;
create policy "ticket_items_select" on public.ticket_items
  for select using (
    public.can_see_all_days()
    or ticket_id in (
      select id from public.tickets where sale_day_id = public.latest_sale_day_id()
    )
  );

drop policy if exists "inventory_counts_select" on public.inventory_counts;
create policy "inventory_counts_select" on public.inventory_counts
  for select using (
    public.can_see_all_days()
    or sale_day_id = public.latest_sale_day_id()
  );

-- Nota: esto solo limita SELECT (lectura). Un operador siempre puede
-- seguir capturando (insert) un dia nuevo sin importar este interruptor.
