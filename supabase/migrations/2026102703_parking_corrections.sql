begin;

alter table public.games add column if not exists revision bigint not null default 1;
create or replace function olivos_private.bump_parking_revision() returns trigger
language plpgsql set search_path = '' as $$
begin new.revision := old.revision + 1; return new; end;
$$;
create trigger parking_revision before update on public.games
for each row execute function olivos_private.bump_parking_revision();

create table public.parking_corrections (
 id uuid primary key default gen_random_uuid(), game_ids uuid[] not null,
 requested_by uuid not null, requested_name text not null,
 requested_at timestamptz not null default now(),
 reason text not null check(length(trim(reason)) between 8 and 1000),
 before_data jsonb not null, after_data jsonb not null, request_payload jsonb not null,
 applied_immediately boolean not null, client_ref uuid not null unique
);
create table public.parking_decisions (
 id uuid primary key default gen_random_uuid(),
 correction_id uuid not null unique references public.parking_corrections,
 decided_by uuid not null, decided_name text not null,
 decided_at timestamptz not null default now(), approved boolean not null,
 note text not null check(length(trim(note)) between 8 and 1000)
);
alter table public.parking_corrections enable row level security;
alter table public.parking_decisions enable row level security;
revoke all on public.parking_corrections, public.parking_decisions from public, anon, authenticated;
grant select on public.parking_corrections, public.parking_decisions to authenticated;
create policy parking_corrections_read on public.parking_corrections for select to authenticated
using ((select public.is_active_user()) and (requested_by = (select auth.uid()) or (select public.is_admin())));
create policy parking_decisions_read on public.parking_decisions for select to authenticated
using (correction_id in (select id from public.parking_corrections));
create trigger immutable_history before update or delete on public.parking_corrections
for each row execute function public.prevent_history_changes();
create trigger immutable_history before update or delete on public.parking_decisions
for each row execute function public.prevent_history_changes();

create or replace function olivos_private.parking_snapshot(p_game public.games) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id',p_game.id,'revision',p_game.revision,
 'date',(select d.date from public.sale_days d where d.id=p_game.sale_day_id),
 'start_time',p_game.start_time,'cars_parked',p_game.cars_parked,
 'cars_charged',p_game.cars_charged,'parking_rate',p_game.parking_rate,
 'charges_parking',p_game.charges_parking,'notes',p_game.notes);
$$;

-- This helper is not callable by API roles. Both public entry points supply
-- validated snapshots and check the caller before reaching it.
create or replace function olivos_private.check_apply_parking(p_before jsonb,p_after jsonb,p_apply boolean)
returns void language plpgsql set search_path = '' as $$
declare b jsonb; a jsonb; g public.games%rowtype; d public.sale_days%rowtype;
 ids uuid[]; capacity integer; final_count integer;
begin
 select array_agg((x->>'id')::uuid) into ids from jsonb_array_elements(p_before) x;
 -- Match the existing import lock order: days first, then parking rows.
 perform d0.id from public.sale_days d0
 where d0.id in (select g0.sale_day_id from public.games g0 where g0.id=any(ids))
 or d0.date in (select (x->>'date')::date from jsonb_array_elements(p_after) x)
 order by d0.id for update;
 perform g0.id from public.games g0 where g0.id=any(ids) order by g0.id for update;
 for b in select value from jsonb_array_elements(p_before) loop
  select * into g from public.games where id=(b->>'id')::uuid;
  if not found or olivos_private.parking_snapshot(g) is distinct from b then
   raise exception 'El estacionamiento cambió. Recarga y prepara una nueva corrección';
  end if;
  select value into a from jsonb_array_elements(p_after) where value->>'id'=b->>'id';
  if not public.can_read_day(g.sale_day_id) then raise exception 'No tienes acceso a este estacionamiento'; end if;
  select * into d from public.sale_days where date=(a->>'date')::date;
  if not found or not public.can_read_day(d.id) then
   raise exception 'La fecha destino debe tener una jornada registrada y disponible para tu cuenta';
  end if;
  if p_apply and (d.status='reviewed' or exists(select 1 from public.sale_days where id=g.sale_day_id and status='reviewed')) then
   raise exception 'Reabre los días cerrados antes de aplicar la corrección';
  end if;
  if exists(select 1 from public.games other where other.sale_day_id=d.id
    and other.start_time=(a->>'start_time')::time and not(other.id=any(ids))) then
   raise exception 'Ya existe estacionamiento a esa hora en la fecha destino. Revisa los registros; no se combinaron';
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_after) x group by x->>'date',x->>'start_time' having count(*)>1) then
  raise exception 'La corrección repite fecha y hora de estacionamiento';
 end if;
 -- A date move must not exceed a destination's confirmed activity count.
 for d in select * from public.sale_days where date in
  (select (a0->>'date')::date from jsonb_array_elements(p_after) a0
   join jsonb_array_elements(p_before) b0 on b0->>'id'=a0->>'id' where b0->>'date'<>a0->>'date') loop
  if d.event_groups is not null and not exists(select 1 from jsonb_array_elements(d.event_groups) x where x->>'games' is null) then
   select coalesce(sum((x->>'games')::int),0) into capacity from jsonb_array_elements(d.event_groups) x;
   select count(*) into final_count from public.games where sale_day_id=d.id and not(id=any(ids));
   final_count := final_count + (select count(*) from jsonb_array_elements(p_after) x where (x->>'date')::date=d.date);
   if final_count>capacity then raise exception 'El estacionamiento supera los partidos confirmados del destino. Revisa primero sus actividades'; end if;
  end if;
 end loop;
 if p_apply then
  if not public.is_admin() then raise exception 'Solo administración puede aplicar cambios de estacionamiento'; end if;
  for a in select value from jsonb_array_elements(p_after) loop
   update public.games set
    sale_day_id=(select id from public.sale_days where date=(a->>'date')::date),
    start_time=(a->>'start_time')::time,cars_parked=(a->>'cars_parked')::int,
    cars_charged=(a->>'cars_charged')::int,parking_rate=(a->>'parking_rate')::numeric,
    charges_parking=(a->>'charges_parking')::boolean,notes=a->>'notes'
   where id=(a->>'id')::uuid;
  end loop;
 end if;
end;
$$;

create or replace function public.request_parking_correction(p_changes jsonb,p_reason text,p_client_ref uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.parking_corrections%rowtype; item jsonb; a jsonb; b jsonb;
 before_list jsonb:='[]'; after_list jsonb:='[]'; ids uuid[]; result uuid; direct boolean;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or length(trim(coalesce(p_reason,''))) not between 8 and 1000 then
  raise exception 'Explica el motivo del cambio (8 a 1000 caracteres)';
 end if;
 if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Corrección inválida'; end if;
 if jsonb_array_length(p_changes) not between 1 and 50 then raise exception 'Elige de 1 a 50 registros'; end if;
 perform pg_advisory_xact_lock(hashtext('parking:'||p_client_ref::text));
 select * into prior from public.parking_corrections where client_ref=p_client_ref;
 if found then
  if prior.requested_by<>auth.uid() or prior.request_payload<>p_changes or prior.reason<>trim(p_reason) then
   raise exception 'El reintento contiene otra corrección';
  end if;
  return jsonb_build_object('id',prior.id,'applied',prior.applied_immediately);
 end if;
 for item in select value from jsonb_array_elements(p_changes) loop
  b := item->'before'; a := item->'after';
  if jsonb_typeof(b) is distinct from 'object' or jsonb_typeof(a) is distinct from 'object'
   or b->>'id' is null or b->>'revision' is null then raise exception 'Falta la referencia original'; end if;
  if jsonb_typeof(a->'date') is distinct from 'string' or a->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
   or (a->>'date')::date::text<>a->>'date' or not isfinite((a->>'date')::date)
   or jsonb_typeof(a->'start_time') is distinct from 'string'
   or a->>'start_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
   or jsonb_typeof(a->'charges_parking') is distinct from 'boolean'
   or jsonb_typeof(a->'notes') is null or jsonb_typeof(a->'notes') not in ('null','string')
   or length(coalesce(a->>'notes',''))>2000 then raise exception 'Revisa fecha, hora y notas'; end if;
  if jsonb_typeof(a->'cars_parked') is distinct from 'number' or jsonb_typeof(a->'cars_charged') is distinct from 'number'
   or jsonb_typeof(a->'parking_rate') is distinct from 'number' then raise exception 'Completa autos y tarifa'; end if;
  if (a->>'cars_parked')::numeric not between 0 and 1000000 or (a->>'cars_charged')::numeric not between 0 and (a->>'cars_parked')::numeric
   or (a->>'cars_parked')::numeric<>trunc((a->>'cars_parked')::numeric) or (a->>'cars_charged')::numeric<>trunc((a->>'cars_charged')::numeric)
   or (a->>'parking_rate')::numeric not between 0 and 1000000 or (a->>'parking_rate')::numeric<>round((a->>'parking_rate')::numeric,2) then
   raise exception 'Autos enteros, cobrados no mayores al lote y tarifa válida de hasta dos decimales';
  end if;
  a := jsonb_build_object('id',(b->>'id')::uuid,'revision',(b->>'revision')::bigint+1,
   'date',(a->>'date')::date,'start_time',(a->>'start_time')::time,'cars_parked',(a->>'cars_parked')::int,
   'cars_charged',(a->>'cars_charged')::int,'parking_rate',(a->>'parking_rate')::numeric,
   'charges_parking',(a->>'charges_parking')::boolean,'notes',a->>'notes');
  if a-'revision'=b-'revision' then raise exception 'No hay cambios en uno de los registros'; end if;
  before_list := before_list || jsonb_build_array(b); after_list := after_list || jsonb_build_array(a);
 end loop;
 select array_agg((x->>'id')::uuid) into ids from jsonb_array_elements(before_list) x;
 if cardinality(ids)<>(select count(distinct v) from unnest(ids) v) then raise exception 'Registros repetidos'; end if;
 direct := public.is_admin();
 perform olivos_private.check_apply_parking(before_list,after_list,direct);
 insert into public.parking_corrections(game_ids,requested_by,requested_name,reason,before_data,after_data,request_payload,applied_immediately,client_ref)
 values(ids,auth.uid(),coalesce((select full_name from public.profiles where id=auth.uid()),'Usuario'),trim(p_reason),before_list,after_list,p_changes,direct,p_client_ref)
 returning id into result;
 return jsonb_build_object('id',result,'applied',direct);
end;
$$;

create or replace function public.review_parking_correction(p_request uuid,p_approve boolean,p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.parking_corrections%rowtype; prior public.parking_decisions%rowtype;
begin
 if not public.is_admin() then raise exception 'Solo administración puede decidir'; end if;
 if p_approve is null or length(trim(coalesce(p_note,''))) not between 8 and 1000 then raise exception 'Explica el motivo de la decisión (8 a 1000 caracteres)'; end if;
 select * into c from public.parking_corrections where id=p_request for update;
 if not found or c.applied_immediately then raise exception 'La solicitud no está pendiente'; end if;
 select * into prior from public.parking_decisions where correction_id=c.id;
 if found then
  if prior.decided_by=auth.uid() and prior.approved=p_approve and prior.note=trim(p_note) then return; end if;
  raise exception 'La solicitud ya fue resuelta';
 end if;
 if p_approve then perform olivos_private.check_apply_parking(c.before_data,c.after_data,true); end if;
 insert into public.parking_decisions(correction_id,decided_by,decided_name,approved,note)
 values(c.id,auth.uid(),coalesce((select full_name from public.profiles where id=auth.uid()),'Administrador'),p_approve,trim(p_note));
end;
$$;

revoke all on function olivos_private.bump_parking_revision(),olivos_private.parking_snapshot(public.games),
 olivos_private.check_apply_parking(jsonb,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.request_parking_correction(jsonb,text,uuid),public.review_parking_correction(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.request_parking_correction(jsonb,text,uuid),public.review_parking_correction(uuid,boolean,text) to authenticated;
insert into public.schema_versions(version) values(2026102703) on conflict do nothing;
notify pgrst,'reload schema';
commit;
