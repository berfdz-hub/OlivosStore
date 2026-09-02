-- ============================================================
-- Reemplaza la regla de que ve un operador (reemplaza la logica de
-- "solo el dia mas reciente" de permiso_operador_costos.sql y la de
-- "solo dias evento especial" de categoria_dia.sql):
--
-- Un operador ahora ve TODO -- dias, partidos, tickets, productos,
-- dinero, costo y utilidad -- de:
--   1) cualquier dia marcado como "evento especial" (sin importar
--      que tan viejo sea), y
--   2) cualquier dia de los ultimos 31 dias (rodante desde hoy).
-- Fuera de eso no ve nada de ese dia (ni siquiera unidades), para
-- que no se acumule un historial completo con el que pueda armar
-- totales fuertes (venta o utilidad de un mes completo o de un año).
-- Por eso los comparativos "Por mes" y "Por año" del reporte quedan
-- solo para administracion (ya se oculto en el codigo).
--
-- El interruptor "Los operadores ven el historial completo" (Usuarios)
-- se conserva como forma de que un admin le de a un operador acceso a
-- TODO el historial si asi lo decide -- se combina con lo de arriba,
-- no lo reemplaza.
--
-- Corre esto UNA VEZ, completo, en el SQL Editor de Supabase.
-- ============================================================

-- 1. dia visible para un operador (evento especial, o dentro de los
--    ultimos 31 dias). Se usa tanto para las filas como para el dinero.
create or replace function public.dia_visible_operador(p_sale_day_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.sale_days sd
    where sd.id = p_sale_day_id
      and (sd.day_type = 'evento_especial' or sd.date >= (current_date - interval '31 days'))
  );
$$;

-- 2. dinero: si el dia es visible (evento especial, ultimos 31 dias,
--    admin, o el interruptor de historial completo), se ve completo.
--    Ya no se esconde el monto de un dia que si es visible.
create or replace function public.can_see_amount(p_sale_day_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.active = true
      and (
        pr.role = 'admin'
        or public.can_see_all_days()
        or public.dia_visible_operador(p_sale_day_id)
      )
  );
$$;

-- 3. filas: mismo criterio para sale_days y todo lo que cuelga de un dia.
drop policy if exists "sale_days_select" on public.sale_days;
create policy "sale_days_select" on public.sale_days
  for select using (
    public.is_admin()
    or public.can_see_all_days()
    or day_type = 'evento_especial'
    or date >= (current_date - interval '31 days')
  );

drop policy if exists "games_select" on public.games;
create policy "games_select" on public.games
  for select using (
    public.is_admin()
    or public.can_see_all_days()
    or public.dia_visible_operador(sale_day_id)
  );

drop policy if exists "tickets_select" on public.tickets;
create policy "tickets_select" on public.tickets
  for select using (
    public.is_admin()
    or public.can_see_all_days()
    or public.dia_visible_operador(sale_day_id)
  );

drop policy if exists "ticket_items_select" on public.ticket_items;
create policy "ticket_items_select" on public.ticket_items
  for select using (
    public.is_admin()
    or public.can_see_all_days()
    or ticket_id in (
      select id from public.tickets where public.dia_visible_operador(sale_day_id)
    )
  );

drop policy if exists "inventory_counts_select" on public.inventory_counts;
create policy "inventory_counts_select" on public.inventory_counts
  for select using (
    public.is_admin()
    or public.can_see_all_days()
    or public.dia_visible_operador(sale_day_id)
  );
