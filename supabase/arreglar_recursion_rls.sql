-- ============================================================
-- Arregla "infinite recursion detected in policy for relation
-- sale_days": las politicas calculaban "el dia mas reciente"
-- consultando la misma tabla sale_days dentro de su propia regla,
-- lo que la hacia llamarse a si misma sin parar.
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

-- funciones que calculan "el dia mas reciente" sin disparar RLS
-- (SECURITY DEFINER + dueño admin = evita el ciclo)
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

-- vuelve a crear las 5 politicas usando las funciones de arriba
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
