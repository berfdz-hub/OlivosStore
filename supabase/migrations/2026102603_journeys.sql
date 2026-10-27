begin;
alter table public.scheduled_games alter column start_time drop not null;
alter table public.scheduled_games add column activity jsonb;
alter table public.scheduled_games add column status text not null default 'scheduled' check(status in ('scheduled','cancelled'));
alter table public.scheduled_games add column version integer not null default 1;
alter table public.scheduled_games add column updated_at timestamptz not null default now();
alter table public.scheduled_games add column change_reason text;
alter table public.scheduled_games add constraint scheduled_activity_valid check(activity is null or public.valid_event_groups(jsonb_build_array(activity)));
create index scheduled_date_idx on public.scheduled_games(date);
revoke insert,update,delete on public.scheduled_games from authenticated,anon;
create trigger scheduled_audit after insert or update or delete on public.scheduled_games for each row execute function public.record_audit();

create table public.calendar_requests(client_ref uuid primary key, actor uuid not null references public.profiles(id), payload jsonb not null, result jsonb not null);
alter table public.calendar_requests enable row level security;
revoke all on public.calendar_requests from public,anon,authenticated;

create function public.save_scheduled_activities(p_date date,p_activities jsonb,p_notes text,p_id uuid,p_version integer,p_cancel boolean,p_reason text,p_client_ref uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare prior public.calendar_requests%rowtype; current_row public.scheduled_games%rowtype; payload jsonb; g jsonb; result jsonb:='[]'; new_id uuid; all_groups jsonb;
begin
 if not public.is_active_user() or not public.is_admin() then raise exception 'Solo administración puede cambiar el calendario'; end if;
 if p_date is null or p_client_ref is null or p_cancel is null or p_notes is null or length(p_notes)>1000 or jsonb_typeof(p_activities) is distinct from 'array' or not public.valid_event_groups(p_activities) then raise exception 'Revisa la fecha y las actividades'; end if;
 if p_id is not null and (jsonb_array_length(p_activities)<>1 or p_version is null or length(trim(coalesce(p_reason,'')))<8 or length(p_reason)>1000) then raise exception 'Explica el cambio con al menos 8 caracteres'; end if;
 if p_cancel and p_id is null then raise exception 'Selecciona la actividad a cancelar'; end if;
 payload:=jsonb_build_object('date',p_date,'activities',p_activities,'notes',p_notes,'id',p_id,'version',p_version,'cancel',p_cancel,'reason',p_reason);
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.calendar_requests where client_ref=p_client_ref;
 if found then
  if prior.actor<>auth.uid() or prior.payload<>payload then raise exception 'Este reintento contiene otros datos; vuelve a abrir el formulario'; end if;
  return prior.result;
 end if;
 perform pg_advisory_xact_lock(hashtext('calendar:'||p_date::text));
 if p_id is not null then
  select * into current_row from public.scheduled_games where id=p_id for update;
  if not found or current_row.date<>p_date or current_row.version<>p_version or current_row.status='cancelled' then raise exception 'La actividad cambió; actualiza el calendario y vuelve a abrirla'; end if;
 end if;
 if not p_cancel then
  select coalesce(jsonb_agg(coalesce(activity,jsonb_build_object('type',sport,'teamMode','unknown','team','','games',1))), '[]') into all_groups from public.scheduled_games where date=p_date and status='scheduled' and (p_id is null or id<>p_id);
  if not public.valid_event_groups(all_groups||p_activities) then raise exception 'Una jornada admite hasta 12 actividades y 50 partidos'; end if;
 end if;
 if p_id is not null then
  g:=p_activities->0;
  update public.scheduled_games set activity=case when p_cancel then activity else g end,
    status=case when p_cancel then 'cancelled' else 'scheduled' end,
    start_time=case when p_cancel then start_time else nullif(g#>>'{slots,0,start}','')::time end,
    sport=case when p_cancel then sport when g->>'type' in ('futbol','beisbol') then g->>'type' else 'otro' end,
    notes=p_notes,version=version+1,updated_at=now(),change_reason=trim(p_reason) where id=p_id;
  result:=jsonb_build_array(p_id);
 else
  for g in select value from jsonb_array_elements(p_activities) loop
   insert into public.scheduled_games(date,activity,start_time,sport,notes,created_by,change_reason)
   values(p_date,g,nullif(g#>>'{slots,0,start}','')::time,case when g->>'type' in ('futbol','beisbol') then g->>'type' else 'otro' end,p_notes,auth.uid(),coalesce(nullif(trim(p_reason),''),'Alta en calendario')) returning id into new_id;
   result:=result||jsonb_build_array(new_id);
  end loop;
 end if;
 insert into public.calendar_requests values(p_client_ref,auth.uid(),payload,result);
 return result;
end; $$;

create function public.duplicate_scheduled_day(p_source date,p_target date,p_client_ref uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare groups jsonb; prior public.calendar_requests%rowtype; result jsonb; payload jsonb;
begin
 if not public.is_active_user() or not public.is_admin() then raise exception 'Solo administración puede cambiar el calendario'; end if;
 if p_source is null or p_target is null or p_source=p_target or p_client_ref is null then raise exception 'Elige otra fecha válida'; end if;
 payload:=jsonb_build_object('source',p_source,'target',p_target);
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.calendar_requests where client_ref=p_client_ref;
 if found then
  if prior.actor<>auth.uid() or prior.payload<>payload then raise exception 'El reintento contiene otra jornada'; end if;
  return prior.result;
 end if;
 perform pg_advisory_xact_lock(hashtext('calendar:'||least(p_source,p_target)::text));
 perform pg_advisory_xact_lock(hashtext('calendar:'||greatest(p_source,p_target)::text));
 if exists(select 1 from public.scheduled_games where date=p_target and status='scheduled') then raise exception 'La fecha destino ya tiene actividades. Agrégalas una a una para evitar duplicados'; end if;
 select jsonb_agg(coalesce(activity,jsonb_build_object('type',sport,'teamMode',case when notes ilike '%club puebla%' then 'club_puebla' else 'unknown' end,'team',case when notes ilike '%club puebla%' then 'Club Puebla' else '' end,'games',1,'slots',case when start_time is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('start',to_char(start_time,'HH24:MI'),'end','')) end))) into groups from public.scheduled_games where date=p_source and status='scheduled';
 if groups is null then raise exception 'La jornada origen no tiene actividades'; end if;
 result:=public.save_scheduled_activities(p_target,groups,'Copiado de '||p_source,null,1,false,'Copia de jornada',gen_random_uuid());
 insert into public.calendar_requests values(p_client_ref,auth.uid(),payload,result);
 return result;
end; $$;

-- A stale purchase cannot be saved even if another administrator changed the
-- calendar after this browser's last refresh. Existing saved plans stay immutable.
alter function public.save_purchase_plan(jsonb,uuid) rename to save_purchase_plan_2602;
revoke all on function public.save_purchase_plan_2602(jsonb,uuid) from public,anon,authenticated;
create function public.save_purchase_plan(p_plan jsonb,p_client_ref uuid) returns uuid language plpgsql security definer set search_path=public as $$
declare current_schedule jsonb;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 perform pg_advisory_xact_lock(hashtext('calendar:'||(p_plan->>'event_date')::date::text));
 -- Previous clients can still save legacy plans without a calendar snapshot.
 if p_plan->'summary' ? 'scheduleFingerprint' then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]') into current_schedule from public.scheduled_games where date=(p_plan->>'event_date')::date and status='scheduled';
  if (p_plan#>>'{summary,scheduleFingerprint}')::jsonb is distinct from current_schedule then raise exception 'El calendario cambió. Actualiza y revisa las actividades antes de guardar la compra'; end if;
 end if;
 return public.save_purchase_plan_2602(p_plan,p_client_ref);
end; $$;

-- Independent inventory counts do not create fictitious sales/event history.
alter table public.inventory_counts alter column sale_day_id drop not null;
alter table public.inventory_counts add column created_by uuid references public.profiles(id);
alter table public.inventory_counts add column client_ref uuid;
create unique index inventory_count_request_idx on public.inventory_counts(client_ref,product_id) where client_ref is not null;
create table public.inventory_count_requests(client_ref uuid primary key,actor uuid not null references public.profiles(id),counts jsonb not null);
alter table public.inventory_count_requests enable row level security;
revoke all on public.inventory_count_requests from public,anon,authenticated;
create policy independent_count_read on public.inventory_counts for select to authenticated using(sale_day_id is null and public.is_active_user() and (public.is_admin() or public.can_see_all_days() or created_by=auth.uid() or counted_at>=now()-interval '32 days'));
create function public.save_inventory_count(p_counts jsonb,p_client_ref uuid) returns integer language plpgsql security definer set search_path=public as $$
declare c jsonb; pid uuid; at_time timestamptz; prior public.inventory_count_requests%rowtype;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or jsonb_typeof(p_counts) is distinct from 'array' or jsonb_array_length(p_counts) not between 1 and 2000 then raise exception 'Agrega al menos un conteo'; end if;
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.inventory_count_requests where client_ref=p_client_ref;
 if found then
  if prior.actor<>auth.uid() or prior.counts<>p_counts then raise exception 'El reintento contiene otro conteo'; end if;
  return jsonb_array_length(p_counts);
 end if;
 for c in select value from jsonb_array_elements(p_counts) loop
  at_time:=(c->>'counted_at')::timestamptz;
  if at_time is null or at_time>now()+interval '5 minutes' or jsonb_typeof(c->'physical_count') is distinct from 'number' or (c->>'physical_count')::numeric<0 or coalesce(c->>'count_source','') not in ('manual','pos') then raise exception 'Revisa la cantidad, origen y hora del conteo'; end if;
  pid:=nullif(c->>'product_id','')::uuid;
  if pid is null then raise exception 'Da de alta primero los productos nuevos en Catálogo'; end if;
  if not exists(select 1 from public.products where id=pid and active) then raise exception 'Producto no disponible'; end if;
  if exists(select 1 from public.inventory_counts where product_id=pid and counted_at=at_time) then raise exception 'Ya hay un conteo para ese producto y hora. Administración debe revisar el existente'; end if;
  insert into public.inventory_counts(product_id,physical_count,counted_at,count_source,created_by,client_ref,note) values(pid,(c->>'physical_count')::numeric,at_time,c->>'count_source',auth.uid(),p_client_ref,'Conteo independiente');
 end loop;
 insert into public.inventory_count_requests values(p_client_ref,auth.uid(),p_counts);
 return jsonb_array_length(p_counts);
end; $$;
revoke all on function public.save_scheduled_activities(date,jsonb,text,uuid,integer,boolean,text,uuid),public.duplicate_scheduled_day(date,date,uuid),public.save_purchase_plan(jsonb,uuid),public.save_inventory_count(jsonb,uuid) from public,anon;
grant execute on function public.save_scheduled_activities(date,jsonb,text,uuid,integer,boolean,text,uuid),public.duplicate_scheduled_day(date,date,uuid),public.save_purchase_plan(jsonb,uuid),public.save_inventory_count(jsonb,uuid) to authenticated;
insert into public.schema_versions(version) values(2026102603);
notify pgrst,'reload schema';
commit;
