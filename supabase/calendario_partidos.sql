-- ============================================================
-- Calendario de partidos agendados (a futuro, antes de que exista
-- una captura de venta para ese dia). Sirve para que la app avise
-- "este fin de semana hay N partidos" en la pantalla de captura.
-- Corre esto UNA VEZ en el SQL Editor de Supabase.
-- ============================================================

create table public.scheduled_games (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_time time not null,
  sport text not null default 'futbol' check (sport in ('futbol','beisbol','otro')),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.scheduled_games enable row level security;

create policy "scheduled_games_select" on public.scheduled_games
  for select using (auth.uid() is not null);
create policy "scheduled_games_insert" on public.scheduled_games
  for insert with check (auth.uid() is not null);
create policy "scheduled_games_update" on public.scheduled_games
  for update using (public.is_admin() or created_by = auth.uid());
create policy "scheduled_games_delete" on public.scheduled_games
  for delete using (public.is_admin() or created_by = auth.uid());
