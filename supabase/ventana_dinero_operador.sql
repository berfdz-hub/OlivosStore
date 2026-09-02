-- ============================================================
-- Cambia la regla de cuanto dinero ve un operador en los reportes:
-- antes solo veia montos en los dias marcados "evento especial";
-- ahora ve venta/ticket promedio/utilidad completos en CUALQUIER
-- dia dentro de los ultimos 31 dias (rodante desde hoy), sin
-- importar la categoria del dia. Mas alla de esos 31 dias solo ve
-- unidades y cantidades, igual que antes.
--
-- Los comparativos "Por mes" y "Por año" del reporte ya se
-- ocultaron para operador en el codigo (cruzan ese limite por
-- naturaleza), esto solo cambia el permiso de fondo en la base de
-- datos que usa tickets_view.
--
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

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
          where sd.id = p_sale_day_id
            and sd.date >= (current_date - interval '31 days')
        )
      )
  );
$$;
