begin;
alter table public.purchase_plans alter column games drop not null;
alter table public.purchase_plans drop constraint if exists purchase_plans_event_type_check;
alter table public.purchase_plans add constraint purchase_plans_event_type_check check(event_type in ('club_puebla','futbol','beisbol','entrenamiento','otro','sin_especificar'));
create or replace function public.save_purchase_plan(p_plan jsonb,p_client_ref uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare result uuid; prior public.purchase_plans%rowtype; r jsonb;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or (p_plan->>'event_date')::date<(now() at time zone 'America/Mexico_City')::date or coalesce(p_plan->>'model_version','') not in ('eventos-2026-10-v1','eventos-2026-10-v2') or jsonb_typeof(p_plan->'rows') is distinct from 'array' or jsonb_array_length(p_plan->'rows')=0 or jsonb_array_length(p_plan->'rows')>2000 then raise exception 'Propuesta inválida'; end if;
 if p_plan->>'event_date' is null or coalesce(p_plan->>'event_type','') not in ('club_puebla','futbol','beisbol','entrenamiento','otro','sin_especificar') or jsonb_typeof(p_plan->'summary') is distinct from 'object' then raise exception 'Revisa fecha y tipo de evento'; end if;
 if coalesce(jsonb_typeof(p_plan->'games'),'null') not in ('number','null') then raise exception 'Partidos inválidos'; end if;
 if p_plan->>'games' is not null and ((p_plan->>'games')::numeric<>trunc((p_plan->>'games')::numeric) or (p_plan->>'games')::numeric<0 or (p_plan->>'games')::numeric>50) then raise exception 'Partidos inválidos'; end if;
 for r in select value from jsonb_array_elements(p_plan->'rows') loop
  if jsonb_typeof(r->'expected') is distinct from 'number' or jsonb_typeof(r->'demand') is distinct from 'number' or coalesce(jsonb_typeof(r->'buy'),'null') not in ('number','null') or coalesce(jsonb_typeof(r->'chosen'),'null') not in ('number','null') then raise exception 'Cantidades de propuesta inválidas'; end if;
  if not exists(select 1 from public.products where id=(r->>'productId')::uuid) or (r->>'expected')::numeric<0 or (r->>'demand')::numeric<0 or (r->>'buy')::numeric<0 or (r->>'chosen')::numeric<0 then raise exception 'Cantidades de propuesta inválidas'; end if;
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

revoke all on function public.save_purchase_plan(jsonb,uuid) from public,anon;
grant execute on function public.save_purchase_plan(jsonb,uuid) to authenticated;
insert into public.schema_versions(version) values(2026102101) on conflict do nothing;
notify pgrst,'reload schema';
commit;
