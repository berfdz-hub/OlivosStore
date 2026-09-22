-- Permite clasificar un evento con una o varias etiquetas.
-- Valores disponibles: futbol, beisbol, club_puebla y otro.

alter table public.sale_days
  add column if not exists event_tags text[] not null default '{}'::text[];

do $$
begin
  alter table public.sale_days
    add constraint sale_days_event_tags_valid
    check (event_tags <@ array['futbol','beisbol','club_puebla','otro']::text[]);
exception
  when duplicate_object then null;
end $$;

-- Precarga una etiqueta en eventos existentes usando únicamente los datos
-- que ya están registrados en Deporte y Nombre del evento.
update public.sale_days
set event_tags = array_remove(array[
  case
    when sport = 'futbol' then 'futbol'
    when sport = 'beisbol' then 'beisbol'
    when sport = 'otro' then 'otro'
    else null
  end,
  case when coalesce(event_name, '') ilike '%club puebla%' then 'club_puebla' else null end
]::text[], null)
where day_type = 'evento_especial'
  and coalesce(array_length(event_tags, 1), 0) = 0;
