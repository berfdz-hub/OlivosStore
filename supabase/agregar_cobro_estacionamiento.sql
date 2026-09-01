-- ============================================================
-- Agrega la bandera "se cobra estacionamiento" a cada partido,
-- para los partidos amistosos/de liga entre semana donde no se
-- cobra. Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

alter table public.games
  add column if not exists charges_parking boolean not null default true;
