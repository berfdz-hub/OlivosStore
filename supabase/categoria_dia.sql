-- ============================================================
-- Reemplaza is_strong_sale por una categoria de dia mas completa:
--   'evento_especial'     -- torneos, eventos grandes
--   'dia_partido'         -- partido normal de temporada
--   'entrenamiento_normal' -- operacion entre semana sin partido
--
-- El operador ve dinero completo solo en dias 'evento_especial'
-- (reemplaza la logica vieja de is_strong_sale).
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

alter table public.sale_days
  add column if not exists day_type text not null default 'entrenamiento_normal'
  check (day_type in ('evento_especial','dia_partido','entrenamiento_normal'));

-- migra lo que ya estaba marcado como venta fuerte
update public.sale_days set day_type = 'evento_especial' where is_strong_sale = true;

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
          where sd.id = p_sale_day_id and sd.day_type = 'evento_especial'
        )
      )
  );
$$;
