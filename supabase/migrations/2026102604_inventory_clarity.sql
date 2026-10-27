begin;
-- Add precision explicitly; never invent an hour or rewrite historical rows.
alter table public.inventory_counts add column counted_on date;
alter table public.inventory_counts add column created_at timestamptz;
alter table public.inventory_counts alter column created_at set default now();
alter table public.inventory_movements add column occurred_on date;
alter table public.inventory_movements alter column occurred_at drop not null;
alter table public.inventory_movements add constraint movement_date_present check(occurred_at is not null or occurred_on is not null);
alter table public.inventory_movements add constraint movement_date_matches check(occurred_at is null or occurred_on is null or occurred_on=(occurred_at at time zone 'America/Mexico_City')::date);
alter table public.inventory_counts add constraint count_date_matches check(counted_at is null or counted_on is null or counted_on=(counted_at at time zone 'America/Mexico_City')::date);

drop policy movements_read on public.inventory_movements;
create policy movements_read on public.inventory_movements for select to authenticated using(public.is_active_user() and (public.is_admin() or public.can_see_all_days() or occurred_at>=now()-interval '32 days' or (occurred_at is null and occurred_on>=(now() at time zone 'America/Mexico_City')::date-31)));
drop policy independent_count_read on public.inventory_counts;
create policy independent_count_read on public.inventory_counts for select to authenticated using(sale_day_id is null and public.is_active_user() and (public.is_admin() or public.can_see_all_days() or created_by=auth.uid() or counted_at>=now()-interval '32 days' or (counted_at is null and counted_on>=(now() at time zone 'America/Mexico_City')::date-31)));

create function public.record_inventory_movement_dated(p_product uuid,p_at timestamptz,p_on date,p_qty numeric,p_kind text,p_note text,p_client_ref uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid; event_date date; prior public.inventory_movements%rowtype;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 event_date:=coalesce(p_on,(p_at at time zone 'America/Mexico_City')::date);
 if event_date is null or event_date>(now() at time zone 'America/Mexico_City')::date or p_at>now()+interval '5 minutes' or (p_at is not null and event_date<>(p_at at time zone 'America/Mexico_City')::date) or (not public.is_admin() and event_date<(now() at time zone 'America/Mexico_City')::date-31) or p_qty is null or p_qty=0 or p_qty::text in ('NaN','Infinity','-Infinity') or coalesce(p_kind,'') not in ('purchase','waste','adjustment') or nullif(trim(p_note),'') is null or p_client_ref is null then raise exception 'Movimiento inválido: revisa fecha, cantidad y motivo'; end if;
 if (p_kind='purchase' and p_qty<0) or (p_kind='waste' and p_qty>0) then raise exception 'El signo no coincide con el movimiento'; end if;
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.inventory_movements where client_ref=p_client_ref;
 if found then
  if prior.product_id<>p_product or prior.occurred_at is distinct from p_at or coalesce(prior.occurred_on,(prior.occurred_at at time zone 'America/Mexico_City')::date) is distinct from event_date or prior.qty<>p_qty or prior.kind<>p_kind or prior.note<>trim(p_note) or prior.created_by<>auth.uid() then raise exception 'Identidad de movimiento usada con otros datos'; end if;
  return prior.id;
 end if;
 if not exists(select 1 from public.products where id=p_product and active) then raise exception 'Producto no disponible'; end if;
 if exists(select 1 from public.sale_days where date=event_date and status='reviewed') then raise exception 'Reabre el día cerrado antes de modificar inventario'; end if;
 insert into public.inventory_movements(product_id,occurred_at,occurred_on,qty,kind,note,client_ref,created_by) values(p_product,p_at,event_date,p_qty,p_kind,trim(p_note),p_client_ref,auth.uid()) returning id into result;
 return result;
end; $$;

create or replace function public.save_inventory_count(p_counts jsonb,p_client_ref uuid) returns integer language plpgsql security definer set search_path=public as $$
declare c jsonb; pid uuid; at_time timestamptz; event_date date; prior public.inventory_count_requests%rowtype;
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
  at_time:=nullif(c->>'counted_at','')::timestamptz;
  event_date:=coalesce(nullif(c->>'counted_on','')::date,(at_time at time zone 'America/Mexico_City')::date);
  if event_date is null or event_date>(now() at time zone 'America/Mexico_City')::date or at_time>now()+interval '5 minutes' or (at_time is not null and event_date<>(at_time at time zone 'America/Mexico_City')::date) or jsonb_typeof(c->'physical_count') is distinct from 'number' or (c->>'physical_count')::numeric<0 or coalesce(c->>'count_source','') not in ('manual','pos') then raise exception 'Revisa la cantidad, origen y fecha del conteo'; end if;
  pid:=nullif(c->>'product_id','')::uuid;
  if pid is null then raise exception 'Da de alta primero los productos nuevos en Catálogo'; end if;
  if not exists(select 1 from public.products where id=pid and active) then raise exception 'Producto no disponible'; end if;
  if exists(select 1 from public.inventory_counts where product_id=pid and ((at_time is not null and counted_at=at_time) or (at_time is null and counted_at is null and counted_on=event_date))) then raise exception 'Ya hay un conteo para ese producto y momento. Administración debe revisar el existente'; end if;
  insert into public.inventory_counts(product_id,physical_count,counted_at,counted_on,count_source,created_by,client_ref,note) values(pid,(c->>'physical_count')::numeric,at_time,event_date,c->>'count_source',auth.uid(),p_client_ref,coalesce(nullif(trim(c->>'note'),''),'Conteo independiente'));
 end loop;
 insert into public.inventory_count_requests values(p_client_ref,auth.uid(),p_counts);
 return jsonb_array_length(p_counts);
end; $$;
revoke all on function public.record_inventory_movement_dated(uuid,timestamptz,date,numeric,text,text,uuid) from public,anon;
grant execute on function public.record_inventory_movement_dated(uuid,timestamptz,date,numeric,text,text,uuid) to authenticated;
insert into public.schema_versions(version) values(2026102604);
notify pgrst,'reload schema';
commit;
