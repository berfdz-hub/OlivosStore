begin;
create or replace function public.valid_event_groups(p_groups jsonb) returns boolean language plpgsql immutable set search_path=public as $$
declare g jsonb; s jsonb; total numeric:=0;
begin
 if p_groups is null or p_groups='null'::jsonb then return true; end if;
 if jsonb_typeof(p_groups)<>'array' then return false; end if;
 if jsonb_array_length(p_groups)<1 or jsonb_array_length(p_groups)>12 then return false; end if;
 for g in select value from jsonb_array_elements(p_groups) loop
  if jsonb_typeof(g)<>'object' or coalesce(g->>'type','') not in ('futbol','beisbol','entrenamiento','otro','sin_especificar') or coalesce(g->>'teamMode','') not in ('unknown','none','club_puebla','academy','non_club','named') or jsonb_typeof(g->'team') is distinct from 'string' or length(g->>'team')>120 then return false; end if;
  if jsonb_typeof(g->'games') is null or jsonb_typeof(g->'games') not in ('number','null') then return false; end if;
  if g->>'games' is not null and ((g->>'games')::numeric<>trunc((g->>'games')::numeric) or (g->>'games')::numeric<0 or (g->>'games')::numeric>50) then return false; end if;
  total:=total+coalesce((g->>'games')::numeric,0);
  if (g->>'teamMode'='named' and trim(g->>'team')='') or (g->>'teamMode'='club_puebla' and g->>'team'<>'Club Puebla') or (g->>'teamMode' not in ('named','club_puebla') and g->>'team'<>'') then return false; end if;
  if g ? 'period' and (jsonb_typeof(g->'period') is distinct from 'string' or g->>'period' not in ('unknown','morning','afternoon','evening')) then return false; end if;
  if g ? 'slots' then
   if jsonb_typeof(g->'slots')<>'array' then return false; end if;
   if jsonb_array_length(g->'slots')>(case when g->>'games' is null then 0 else greatest(1,(g->>'games')::int) end) then return false; end if;
   for s in select value from jsonb_array_elements(g->'slots') loop
    if jsonb_typeof(s)<>'object' or jsonb_typeof(s->'start') is distinct from 'string' or jsonb_typeof(s->'end') is distinct from 'string' then return false; end if;
    if (s->>'start'<>'' and s->>'start'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') or (s->>'end'<>'' and s->>'end'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') or (s->>'start'<>'' and s->>'end'<>'' and s->>'end'<=s->>'start') then return false; end if;
   end loop;
  end if;
 end loop;
 return total<=50;
end; $$;
create or replace function public.save_purchase_plan(p_plan jsonb,p_client_ref uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare result uuid; prior public.purchase_plans%rowtype; r jsonb;
begin
 if not public.valid_event_groups(p_plan->'summary'->'groups') then raise exception 'Desglose de eventos inválido'; end if;
 if p_plan->>'event_type'='mixto' then
  if jsonb_typeof(p_plan->'summary'->'groups') is distinct from 'array' or p_plan->>'model_version' not in ('eventos-2026-10-v3','eventos-2026-10-v4') then raise exception 'Falta el desglose de eventos'; end if;
  if exists(select 1 from jsonb_array_elements(p_plan->'summary'->'groups') g where g->>'games' is null) then
   if p_plan->>'games' is not null then raise exception 'El total debe quedar desconocido'; end if;
  elsif (p_plan->>'games')::numeric is distinct from (select sum((g->>'games')::numeric) from jsonb_array_elements(p_plan->'summary'->'groups') g) then raise exception 'El total no coincide con el desglose'; end if;
 end if;
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or (p_plan->>'event_date')::date<(now() at time zone 'America/Mexico_City')::date or coalesce(p_plan->>'model_version','') not in ('eventos-2026-10-v1','eventos-2026-10-v2','eventos-2026-10-v3','eventos-2026-10-v4') or jsonb_typeof(p_plan->'rows') is distinct from 'array' or jsonb_array_length(p_plan->'rows')=0 or jsonb_array_length(p_plan->'rows')>2000 then raise exception 'Propuesta inválida'; end if;
 if p_plan->>'event_date' is null or coalesce(p_plan->>'event_type','') not in ('club_puebla','futbol','beisbol','entrenamiento','otro','sin_especificar','mixto') or jsonb_typeof(p_plan->'summary') is distinct from 'object' then raise exception 'Revisa fecha y tipo de evento'; end if;
 if coalesce(jsonb_typeof(p_plan->'games'),'null') not in ('number','null') then raise exception 'Partidos inválidos'; end if;
 if p_plan->>'games' is not null and ((p_plan->>'games')::numeric<>trunc((p_plan->>'games')::numeric) or (p_plan->>'games')::numeric<0 or (p_plan->>'games')::numeric>50) then raise exception 'Partidos inválidos'; end if;
 if p_plan->>'model_version'='eventos-2026-10-v4' then
  if jsonb_typeof(p_plan->'summary'->'manual') is distinct from 'boolean' or jsonb_typeof(p_plan->'summary'->'draft') is distinct from 'boolean' or jsonb_typeof(p_plan->'summary'->'partial') is distinct from 'boolean' then raise exception 'Falta el estado de la compra'; end if;
  if (p_plan->'summary'->>'manual')::boolean and (jsonb_typeof(p_plan->'summary'->'manualReason') is distinct from 'string' or length(trim(p_plan->'summary'->>'manualReason'))<8 or length(p_plan->'summary'->>'manualReason')>1000) then raise exception 'Explica el motivo de las cantidades manuales'; end if;
  if (p_plan->'summary'->>'partial')::boolean and not (p_plan->'summary'->>'draft')::boolean then raise exception 'Una estimación parcial debe guardarse como borrador'; end if;
 end if;
 for r in select value from jsonb_array_elements(p_plan->'rows') loop
  if jsonb_typeof(r) is distinct from 'object' or coalesce(jsonb_typeof(r->'buy'),'null') not in ('number','null') or coalesce(jsonb_typeof(r->'chosen'),'null') not in ('number','null') then raise exception 'Cantidades de propuesta inválidas'; end if;
  if coalesce((r->>'manualOnly')::boolean,false) then
   if p_plan->>'model_version'<>'eventos-2026-10-v4' or not coalesce((p_plan->'summary'->>'manual')::boolean,false) or not coalesce((p_plan->'summary'->>'draft')::boolean,false) or r->>'expected' is not null or r->>'demand' is not null or r->>'buy' is not null then raise exception 'Un producto sin estimación requiere borrador manual'; end if;
  elsif jsonb_typeof(r->'expected') is distinct from 'number' or jsonb_typeof(r->'demand') is distinct from 'number' then raise exception 'Cantidades de propuesta inválidas'; end if;
  if not exists(select 1 from public.products where id=(r->>'productId')::uuid) or (r->>'expected')::numeric<0 or (r->>'demand')::numeric<0 or (r->>'buy')::numeric<0 or (r->>'chosen')::numeric<0 or (r->>'chosen')::numeric<>trunc((r->>'chosen')::numeric) or (r->>'buy')::numeric<>trunc((r->>'buy')::numeric) then raise exception 'Cantidades de propuesta inválidas'; end if;
  if p_plan->>'model_version'='eventos-2026-10-v4' then
   if (r->>'buy' is null or r->>'chosen' is null) and not (p_plan->'summary'->>'draft')::boolean then raise exception 'La compra tiene pendientes; guarda un borrador'; end if;
   if r->'chosen' is distinct from r->'buy' and not (p_plan->'summary'->>'manual')::boolean and r->>'chosen' is not null then raise exception 'La cantidad manual necesita motivo'; end if;
  end if;
 end loop;
 if (select count(distinct entry->>'productId') from jsonb_array_elements(p_plan->'rows') as entries(entry))<>jsonb_array_length(p_plan->'rows') then raise exception 'La propuesta contiene productos repetidos'; end if;
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.purchase_plans where client_ref=p_client_ref;
 if found then
  if prior.created_by<>auth.uid() or prior.event_date<>(p_plan->>'event_date')::date or prior.event_type<>p_plan->>'event_type' or prior.games is distinct from (p_plan->>'games')::int or prior.rows<>p_plan->'rows' or prior.summary<>p_plan->'summary' or prior.model_version is distinct from p_plan->>'model_version' then raise exception 'El reintento contiene otra propuesta'; end if;
  return prior.id;
 end if;
 insert into public.purchase_plans(created_by,event_date,event_type,games,model_version,summary,rows,client_ref)
 values(auth.uid(),(p_plan->>'event_date')::date,p_plan->>'event_type',(p_plan->>'games')::int,p_plan->>'model_version',p_plan->'summary',p_plan->'rows',p_client_ref) returning id into result;
 return result;
end; $$;
insert into public.schema_versions(version) values(2026102602) on conflict do nothing;
notify pgrst,'reload schema';
commit;
