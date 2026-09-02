-- ============================================================
-- El operador por default SOLO ve unidades (nunca dinero). Si un
-- dia se marca como "venta fuerte" (torneo, evento grande), el
-- operador SI ve venta/ticket promedio en dinero para ESE dia.
-- Costos y utilidad siguen dependiendo aparte del interruptor
-- global "Los operadores ven costos y utilidad" en Usuarios.
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

-- 1. bandera por dia
alter table public.sale_days
  add column if not exists is_strong_sale boolean not null default false;

-- 2. ¿puede este usuario ver el monto en dinero de ESTE dia?
--    admin siempre; operador solo si el dia esta marcado venta fuerte.
create or replace function public.can_see_amount(p_sale_day_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.active = true
      and (
        pr.role = 'admin'
        or exists (
          select 1 from public.sale_days sd
          where sd.id = p_sale_day_id and sd.is_strong_sale = true
        )
      )
  );
$$;

-- 3. vista de tickets: mismo RLS que la tabla (respeta el limite de
--    "solo el dia mas reciente" si aplica), pero enmascara el monto
--    segun can_see_amount() por cada ticket.
create or replace view public.tickets_view
with (security_invoker = true) as
select
  id, sale_day_id, ts, payment_type, ticket_number,
  case when public.can_see_amount(sale_day_id) then amount else null end as amount
from public.tickets;

grant select on public.tickets_view to authenticated;
