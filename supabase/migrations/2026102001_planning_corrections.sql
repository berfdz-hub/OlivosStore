begin;

alter table public.products add column if not exists perishable boolean not null default false;
alter table public.products add column if not exists storage_limit numeric(14,3) check(storage_limit>=0);
alter table public.products add column if not exists perishable_limit numeric(14,3) check(perishable_limit>=0);
update public.products set perishable=true where lower(trim(category))='comida preparada';
create or replace view public.products_view with(security_invoker=false) as
select id,name,category,sell_price,active,case when public.can_see_costs() then cost_price else null end as cost_price,external_ref,
 perishable,storage_limit,perishable_limit from public.products where public.is_active_user();

create table if not exists public.day_corrections (
 id uuid primary key default gen_random_uuid(), day_id uuid not null references public.sale_days,
 requested_by uuid not null, requested_name text not null, requested_at timestamptz not null default now(),
 reason text not null check(length(trim(reason))>=8), before_data jsonb not null, after_data jsonb not null,
 applied_immediately boolean not null, client_ref uuid not null unique
);
create table if not exists public.correction_decisions (
 id uuid primary key default gen_random_uuid(), correction_id uuid not null unique references public.day_corrections,
 decided_by uuid not null, decided_name text not null, decided_at timestamptz not null default now(),
 approved boolean not null, note text not null check(length(trim(note))>=8)
);
create table if not exists public.purchase_plans (
 id uuid primary key default gen_random_uuid(), created_by uuid not null, created_at timestamptz not null default now(),
 event_date date not null, event_type text not null check(event_type in ('club_puebla','futbol','beisbol','entrenamiento','otro')),
 games integer not null check(games>=0 and games<=50), model_version text not null,
 summary jsonb not null, rows jsonb not null, client_ref uuid not null unique
);
alter table public.day_corrections enable row level security;
alter table public.correction_decisions enable row level security;
alter table public.purchase_plans enable row level security;
revoke all on public.day_corrections,public.correction_decisions,public.purchase_plans from public,anon,authenticated;
grant select on public.day_corrections,public.correction_decisions,public.purchase_plans to authenticated;
create policy corrections_read on public.day_corrections for select to authenticated using(public.is_active_user() and (requested_by=auth.uid() or public.can_read_day(day_id)));
create policy decisions_read on public.correction_decisions for select to authenticated using(exists(select 1 from public.day_corrections c where c.id=correction_id));
create policy plans_read on public.purchase_plans for select to authenticated using(public.is_active_user() and (public.is_admin() or created_by=auth.uid() or event_date >= (now() at time zone 'America/Mexico_City')::date-31));

create or replace function public.prevent_history_changes() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'El historial es permanente: registra un nuevo cambio para revertirlo'; end; $$;
do $$ declare t text; begin
 foreach t in array array['day_corrections','correction_decisions','purchase_plans','audit_log'] loop
  execute format('create trigger immutable_history before update or delete on public.%I for each row execute function public.prevent_history_changes()',t);
 end loop;
end $$;

create or replace function public.day_metadata(p_day public.sale_days) returns jsonb
language sql immutable set search_path=public as $$
 select jsonb_build_object('sport',p_day.sport,'day_type',p_day.day_type,'event_name',p_day.event_name,'event_tags',p_day.event_tags,'notes',p_day.notes);
$$;

create or replace function public.request_day_correction(p_day uuid,p_after jsonb,p_before jsonb,p_reason text,p_client_ref uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare d public.sale_days%rowtype; current_data jsonb; proposed jsonb; tags text[]; direct boolean; result uuid; prior public.day_corrections%rowtype;
begin
 if not public.is_active_user() or not public.can_read_day(p_day) then raise exception 'No tienes acceso a este día'; end if;
 if p_client_ref is null or length(trim(coalesce(p_reason,'')))<8 then raise exception 'Explica el motivo del cambio (al menos 8 caracteres)'; end if;
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.day_corrections where client_ref=p_client_ref;
 if found then
  if prior.day_id<>p_day or prior.requested_by<>auth.uid() or prior.reason<>trim(p_reason) or prior.before_data<>p_before or prior.after_data<>p_after then raise exception 'El reintento contiene otros datos'; end if;
  return jsonb_build_object('id',prior.id,'applied',prior.applied_immediately);
 end if;
 select * into d from public.sale_days where id=p_day for update;
 current_data:=public.day_metadata(d);
 if p_before is distinct from current_data then raise exception 'El día cambió desde que lo abriste. Recarga y revisa la propuesta'; end if;
 if p_after->>'sport' is null or p_after->>'sport' not in ('futbol','beisbol','otro') or p_after->>'day_type' is null or p_after->>'day_type' not in ('evento_especial','dia_partido','entrenamiento_normal') or jsonb_typeof(p_after->'event_tags') is distinct from 'array' then raise exception 'Clasificación inválida'; end if;
 tags:=array(select jsonb_array_elements_text(p_after->'event_tags'));
 if not tags<@array['futbol','beisbol','club_puebla','otro'] then raise exception 'Etiquetas inválidas'; end if;
 proposed:=jsonb_build_object('sport',p_after->>'sport','day_type',p_after->>'day_type','event_name',nullif(trim(p_after->>'event_name'),''),'event_tags',tags,'notes',nullif(trim(p_after->>'notes'),''));
 if proposed<>p_after then raise exception 'Envía solo la clasificación, el evento, las etiquetas y las notas'; end if;
 if current_data=proposed then raise exception 'No hay cambios para guardar'; end if;
 direct:=d.status<>'reviewed' and (public.is_admin() or (d.created_by=auth.uid() and d.date=(now() at time zone 'America/Mexico_City')::date));
 insert into public.day_corrections(day_id,requested_by,requested_name,reason,before_data,after_data,applied_immediately,client_ref)
 values(d.id,auth.uid(),coalesce((select full_name from public.profiles where id=auth.uid()),'Usuario'),trim(p_reason),current_data,proposed,direct,p_client_ref) returning id into result;
 if direct then
  update public.sale_days set sport=proposed->>'sport',day_type=proposed->>'day_type',event_name=proposed->>'event_name',event_tags=tags,notes=proposed->>'notes' where id=d.id;
 end if;
 return jsonb_build_object('id',result,'applied',direct);
end; $$;

create or replace function public.review_day_correction(p_request uuid,p_approve boolean,p_note text)
returns void language plpgsql security definer set search_path=public as $$
declare c public.day_corrections%rowtype; d public.sale_days%rowtype;
begin
 if not public.is_admin() then raise exception 'Solo administración puede aprobar o rechazar'; end if;
 if p_approve is null or length(trim(coalesce(p_note,'')))<8 then raise exception 'Indica el motivo de la decisión (al menos 8 caracteres)'; end if;
 select * into c from public.day_corrections where id=p_request for update;
 if not found or c.applied_immediately then raise exception 'Esta solicitud no está pendiente'; end if;
 if exists(select 1 from public.correction_decisions where correction_id=c.id) then raise exception 'La solicitud ya fue resuelta'; end if;
 select * into d from public.sale_days where id=c.day_id for update;
 if p_approve then
  if d.status='reviewed' then raise exception 'Reabre el día antes de aprobar la corrección'; end if;
  if public.day_metadata(d)<>c.before_data then raise exception 'El día cambió después de la solicitud. Recházala y registra una propuesta actualizada'; end if;
  update public.sale_days set sport=c.after_data->>'sport',day_type=c.after_data->>'day_type',event_name=c.after_data->>'event_name',event_tags=array(select jsonb_array_elements_text(c.after_data->'event_tags')),notes=c.after_data->>'notes' where id=c.day_id;
 end if;
 insert into public.correction_decisions(correction_id,decided_by,decided_name,approved,note) values(c.id,auth.uid(),coalesce((select full_name from public.profiles where id=auth.uid()),'Administrador'),p_approve,trim(p_note));
end; $$;

-- All classification changes now have a mandatory reason and an immutable record.
revoke update,delete on public.sale_days from authenticated;

create or replace function public.save_purchase_plan(p_plan jsonb,p_client_ref uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare result uuid; prior public.purchase_plans%rowtype; r jsonb;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or (p_plan->>'event_date')::date<(now() at time zone 'America/Mexico_City')::date or p_plan->>'model_version'<>'eventos-2026-10-v1' or jsonb_typeof(p_plan->'rows') is distinct from 'array' or jsonb_array_length(p_plan->'rows')=0 or jsonb_array_length(p_plan->'rows')>2000 then raise exception 'Propuesta inválida'; end if;
 for r in select value from jsonb_array_elements(p_plan->'rows') loop
  if jsonb_typeof(r->'expected') is distinct from 'number' or jsonb_typeof(r->'demand') is distinct from 'number' or coalesce(jsonb_typeof(r->'buy'),'null') not in ('number','null') or coalesce(jsonb_typeof(r->'chosen'),'null') not in ('number','null') then raise exception 'Cantidades de propuesta inválidas'; end if;
  if not exists(select 1 from public.products where id=(r->>'productId')::uuid) or (r->>'expected')::numeric<0 or (r->>'demand')::numeric<0 or (r->>'buy')::numeric<0 or (r->>'chosen')::numeric<0 then raise exception 'Cantidades de propuesta inválidas'; end if;
 end loop;
 if (select count(distinct entry->>'productId') from jsonb_array_elements(p_plan->'rows') as entries(entry))<>jsonb_array_length(p_plan->'rows') then raise exception 'La propuesta contiene productos repetidos'; end if;
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.purchase_plans where client_ref=p_client_ref;
 if found then
  if prior.created_by<>auth.uid() or prior.event_date<>(p_plan->>'event_date')::date or prior.event_type<>p_plan->>'event_type' or prior.games<>(p_plan->>'games')::int or prior.rows<>p_plan->'rows' or prior.summary<>p_plan->'summary' then raise exception 'El reintento contiene otra propuesta'; end if;
  return prior.id;
 end if;
 insert into public.purchase_plans(created_by,event_date,event_type,games,model_version,summary,rows,client_ref)
 values(auth.uid(),(p_plan->>'event_date')::date,p_plan->>'event_type',(p_plan->>'games')::int,p_plan->>'model_version',p_plan->'summary',p_plan->'rows',p_client_ref) returning id into result;
 return result;
end; $$;

revoke all on function public.prevent_history_changes(),public.day_metadata(public.sale_days),public.request_day_correction(uuid,jsonb,jsonb,text,uuid),public.review_day_correction(uuid,boolean,text),public.save_purchase_plan(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.request_day_correction(uuid,jsonb,jsonb,text,uuid),public.review_day_correction(uuid,boolean,text),public.save_purchase_plan(jsonb,uuid) to authenticated;
insert into public.schema_versions(version) values(2026102001) on conflict do nothing;
notify pgrst,'reload schema';
commit;
