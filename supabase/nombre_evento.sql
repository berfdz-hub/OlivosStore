-- ============================================================
-- Agrega un "nombre de evento" a cada dia, para poder agrupar
-- varios dias consecutivos (ej. un torneo de 5 dias) como un
-- solo evento en el comparativo, en vez de verlos como 5 dias
-- sueltos. Los dias sin nombre se agrupan solos, por su fecha.
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

alter table public.sale_days
  add column if not exists event_name text;
