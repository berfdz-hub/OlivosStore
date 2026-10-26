begin;
alter table public.sale_days add column if not exists event_tags text[] not null default '{}';
alter table public.products add column if not exists external_ref text;
create unique index if not exists products_external_ref_unique on public.products(external_ref) where external_ref is not null;
alter table public.ticket_items alter column qty type numeric(14,3);
alter table public.ticket_items add column if not exists unit_price numeric(14,4);
alter table public.ticket_items add column if not exists unit_cost numeric(14,4);
alter table public.ticket_items add column if not exists line_net_amount numeric(14,2);
alter table public.ticket_items add column if not exists line_cost_amount numeric(14,2);
alter table public.tickets add column if not exists source_terminal text not null default '';
alter table public.tickets add column if not exists receipt_type text not null default 'sale';
alter table public.tickets add column if not exists source_key text;
alter table public.tickets add column if not exists import_fingerprint text;
create unique index if not exists tickets_source_key_unique on public.tickets(source_key) where source_key is not null;
create index if not exists tickets_day_idx on public.tickets(sale_day_id);
create index if not exists tickets_identity_idx on public.tickets(ticket_number,ts);
create index if not exists ticket_items_ticket_idx on public.ticket_items(ticket_id);
alter table public.inventory_counts alter column physical_count type numeric(14,3);
alter table public.inventory_counts alter column opening_stock type numeric(14,3);
alter table public.inventory_counts alter column sold type numeric(14,3);
alter table public.inventory_counts add column if not exists counted_at timestamptz;
alter table public.inventory_counts add column if not exists count_source text not null default 'legacy';
create index if not exists inventory_product_idx on public.inventory_counts(product_id,counted_at);
create table if not exists public.inventory_movements (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products,
 occurred_at timestamptz not null, qty numeric(14,3) not null check(qty<>0),
 kind text not null check(kind in ('purchase','waste','adjustment')), note text not null check(length(trim(note))>0),
 client_ref uuid not null unique, created_by uuid not null references public.profiles, created_at timestamptz not null default now()
);
create table if not exists public.audit_log (
 id uuid primary key default gen_random_uuid(), occurred_at timestamptz not null default now(),
 actor uuid, table_name text not null, record_id uuid, operation text not null, before_data jsonb, after_data jsonb
);
create table if not exists public.schema_versions (version integer primary key, applied_at timestamptz not null default now());
alter table public.inventory_movements enable row level security;
alter table public.audit_log enable row level security;
alter table public.schema_versions enable row level security;
revoke all on public.inventory_movements,public.audit_log,public.schema_versions from public,anon,authenticated;
grant select on public.inventory_movements,public.audit_log,public.schema_versions to authenticated;
drop policy if exists movements_read on public.inventory_movements;
create policy movements_read on public.inventory_movements for select to authenticated using(public.is_active_user() and (public.is_admin() or public.can_see_all_days() or occurred_at>=now()-interval '32 days'));
drop policy if exists audit_admin on public.audit_log;
create policy audit_admin on public.audit_log for select to authenticated using(public.is_admin());
drop policy if exists versions_read on public.schema_versions;
create policy versions_read on public.schema_versions for select to authenticated using(public.is_active_user());

create or replace function public.record_audit() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into public.audit_log(actor,table_name,record_id,operation,before_data,after_data)
 values(auth.uid(),tg_table_name,case when tg_op='DELETE' then old.id else new.id end,tg_op,
 case when tg_op<>'INSERT' then to_jsonb(old) end,case when tg_op<>'DELETE' then to_jsonb(new) end);
 return coalesce(new,old);
end;
$$;
do $$ declare t text; begin
 foreach t in array array['profiles','products','sale_days','tickets','ticket_items','inventory_counts','inventory_movements','games'] loop
  execute format('drop trigger if exists audit_changes on public.%I',t);
  execute format('create trigger audit_changes after insert or update or delete on public.%I for each row execute function public.record_audit()',t);
 end loop;
end $$;

create or replace view public.products_view with(security_invoker=false) as
select id,name,category,sell_price,active,case when public.can_see_costs() then cost_price else null end as cost_price,external_ref
from public.products where public.is_active_user();
create or replace view public.tickets_view with(security_invoker=true) as
select id,sale_day_id,ts,payment_type,ticket_number,case when public.can_see_amount(sale_day_id) then amount else null end as amount,receipt_type,source_terminal
from public.tickets;
-- Cost snapshots have the same server-side protection as catalogue costs.
create or replace view public.ticket_items_view with(security_invoker=false) as
select i.id,i.ticket_id,i.product_id,i.product_name_raw,i.qty,i.unit_price,i.line_net_amount,
 case when public.can_see_costs() then i.unit_cost else null end as unit_cost,
 case when public.can_see_costs() then i.line_cost_amount else null end as line_cost_amount
from public.ticket_items i join public.tickets t on t.id=i.ticket_id where public.can_read_day(t.sale_day_id);
revoke all on public.products_view,public.tickets_view,public.ticket_items_view from public,anon;
grant select on public.products_view,public.tickets_view,public.ticket_items_view to authenticated;
-- All receipt/count mutations go through the atomic endpoint from now on.
revoke insert,update,delete on public.tickets,public.ticket_items,public.inventory_counts,public.games from authenticated;
drop policy if exists items_read on public.ticket_items;
create policy items_read on public.ticket_items for select to authenticated using(public.is_admin());

create or replace function public.resolve_import_product(p_item jsonb) returns uuid
language plpgsql security definer set search_path=public as $$
declare result uuid; matches int; v_name text:=trim(coalesce(p_item->>'raw',p_item->>'name')); v_ref text:=nullif(trim(p_item->>'external_ref'),''); v_price numeric:=nullif(coalesce(p_item->>'unit_price',p_item->>'sell_price'),'')::numeric;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if nullif(v_name,'') is null then raise exception 'Nombre vacío'; end if;
 perform pg_advisory_xact_lock(hashtext(lower(v_name)));
 if v_ref is not null then select id into result from public.products where external_ref=v_ref; end if;
 if result is null then
  select count(*),(array_agg(id))[1] into matches,result from public.products where lower(regexp_replace(trim(name),'\s+',' ','g'))=lower(regexp_replace(v_name,'\s+',' ','g'));
  if matches>1 then raise exception 'Producto ambiguo: %',v_name; end if;
 end if;
 if result is not null and v_ref is not null and exists(select 1 from public.products where id=result and external_ref is not null and external_ref<>v_ref) then raise exception 'Referencia incompatible para %',v_name; end if;
 if result is not null and v_ref is not null then update public.products set external_ref=v_ref where id=result and external_ref is null; end if;
 if result is null and v_price is not null and v_price>=0 then
  insert into public.products(name,category,sell_price,cost_price,external_ref) values(v_name,coalesce(nullif(p_item->>'category',''),'Otro'),v_price,nullif(coalesce(p_item->>'unit_cost',p_item->>'cost_price'),'')::numeric,v_ref) returning id into result;
 end if;
 -- Do not replace current catalogue prices with an old receipt's values.
 return result;
end;
$$;

create or replace function public.save_sale_day(p_day jsonb,p_tickets jsonb default '[]',p_games jsonb default '[]',p_counts jsonb default '[]',p_replace_existing boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_day public.sale_days%rowtype; v_date date:=(p_day->>'date')::date; v_t jsonb; v_i jsonb; v_g jsonb; v_c jsonb;
 v_id uuid; v_pid uuid; v_existing public.tickets%rowtype; v_key text; v_fingerprint text; v_amount numeric; v_sum numeric; v_ts timestamptz; v_count_ts timestamptz;
 v_matches int; v_inserted int:=0; v_skipped int:=0; v_repaired int:=0; v_count_id uuid; v_previous record; v_sales numeric; v_moves numeric; v_open numeric; v_game_id uuid;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_replace_existing and not public.is_admin() then raise exception 'Solo administración puede reemplazar recibos'; end if;
 if v_date is null or v_date>(now() at time zone 'America/Mexico_City')::date then raise exception 'Fecha de captura inválida'; end if;
 if not public.is_admin() and v_date<(now() at time zone 'America/Mexico_City')::date-31 then raise exception 'Un administrador debe importar fechas anteriores a 31 días'; end if;
 if jsonb_typeof(p_tickets)<>'array' or jsonb_typeof(p_games)<>'array' or jsonb_typeof(p_counts)<>'array' then raise exception 'Carga inválida'; end if;
 if jsonb_array_length(p_tickets)>5000 then raise exception 'Divide el archivo en días más pequeños'; end if;
 if not coalesce(array(select jsonb_array_elements_text(coalesce(p_day->'event_tags','[]')))<@array['futbol','beisbol','club_puebla','otro'],false) then raise exception 'Etiquetas inválidas'; end if;
 perform pg_advisory_xact_lock(hashtext('day|'||v_date));
 select * into v_day from public.sale_days where date=v_date for update;
 if found then
  if v_day.status='reviewed' then raise exception 'El día está cerrado. Un administrador debe reabrirlo antes de modificarlo'; end if;
 else
  insert into public.sale_days(date,sport,day_type,event_name,event_tags,notes,status,created_by)
  values(v_date,p_day->>'sport',coalesce(p_day->>'day_type','entrenamiento_normal'),nullif(p_day->>'event_name',''),array(select jsonb_array_elements_text(coalesce(p_day->'event_tags','[]'))),nullif(p_day->>'notes',''),'submitted',auth.uid()) returning * into v_day;
 end if;
 for v_t in select value from jsonb_array_elements(p_tickets) loop
  v_ts:=(v_t->>'ts')::timestamptz;v_amount:=(v_t->>'amount')::numeric;
  if v_ts is null or (v_ts at time zone 'America/Mexico_City')::date<>v_date or v_amount is null or nullif(v_t->>'ticket_number','') is null then raise exception 'Fecha o identidad de recibo inválida'; end if;
  if coalesce(v_t->>'receipt_type','sale') not in ('sale','refund') or ((v_t->>'receipt_type'='refund') and v_amount>0) or (coalesce(v_t->>'receipt_type','sale')='sale' and v_amount<0) then raise exception 'Signo o tipo de recibo inválido'; end if;
  if jsonb_typeof(v_t->'items')<>'array' or jsonb_array_length(v_t->'items')=0 then raise exception 'Recibo sin detalle'; end if;
  if exists(select 1 from jsonb_array_elements(v_t->'items') i where nullif(i->>'qty','')::numeric is null or (i->>'qty')::numeric=0 or (i->>'unit_cost')::numeric<0 or (i->>'unit_price')::numeric<0 or ((i->>'qty')::numeric<0)<>(coalesce(v_t->>'receipt_type','sale')='refund')) then raise exception 'Cantidad o costo inválidos'; end if;
  if exists(select 1 from jsonb_array_elements(v_t->'items') i where
    (coalesce(v_t->>'receipt_type','sale')='sale' and ((i->>'line_net_amount')::numeric<0 or (i->>'line_cost_amount')::numeric<0)) or
    (v_t->>'receipt_type'='refund' and ((i->>'line_net_amount')::numeric>0 or (i->>'line_cost_amount')::numeric>0))) then raise exception 'Signo del importe por artículo inválido'; end if;
  if not exists(select 1 from jsonb_array_elements(v_t->'items') i where i->>'line_net_amount' is null) then
   select sum((i->>'line_net_amount')::numeric) into v_sum from jsonb_array_elements(v_t->'items') i;
   if abs(v_sum-v_amount)>0.01 then raise exception 'El detalle no concilia con el total del recibo'; end if;
  end if;
  v_key:=md5(concat_ws('|',v_t->>'ticket_number',extract(epoch from v_ts)::text,coalesce(v_t->>'source_terminal',''),coalesce(v_t->>'receipt_type','sale')));
  -- Ignore transient catalogue IDs and line ordering in the content fingerprint.
  select md5((v_t-'items'-'sale_date'-'raw_description')::text||coalesce(jsonb_agg(i-'product_id' order by (i-'product_id')::text)::text,'')) into v_fingerprint from jsonb_array_elements(v_t->'items') i;
  perform pg_advisory_xact_lock(hashtext(v_key));
  select count(*) into v_matches from public.tickets where source_key=v_key or (source_key is null and ticket_number=v_t->>'ticket_number' and ts=v_ts and receipt_type=coalesce(v_t->>'receipt_type','sale'));
  if v_matches>1 then raise exception 'Hay recibos históricos duplicados (%). Requieren conciliación antes de importar',v_t->>'ticket_number'; end if;
  select * into v_existing from public.tickets where source_key=v_key or (source_key is null and ticket_number=v_t->>'ticket_number' and ts=v_ts and receipt_type=coalesce(v_t->>'receipt_type','sale')) limit 1 for update;
  if found then
   if v_existing.import_fingerprint=v_fingerprint and exists(select 1 from public.ticket_items where ticket_id=v_existing.id) then v_skipped:=v_skipped+1;continue; end if;
   if not public.is_admin() or (v_existing.import_fingerprint is not null and not p_replace_existing) then raise exception 'El recibo % ya existe con otro contenido. Administración debe conciliarlo',v_t->>'ticket_number'; end if;
   if exists(select 1 from public.sale_days where id=v_existing.sale_day_id and status='reviewed') then raise exception 'El recibo pertenece a un día cerrado'; end if;
   v_id:=v_existing.id;
   update public.tickets set sale_day_id=v_day.id,amount=v_amount,payment_type=v_t->>'payment_type',raw_description=v_t->>'raw_description',source_terminal=coalesce(v_t->>'source_terminal',''),source_key=v_key,import_fingerprint=v_fingerprint where id=v_id;
   delete from public.ticket_items where ticket_id=v_id;
   v_repaired:=v_repaired+1;
  else
   insert into public.tickets(sale_day_id,ticket_number,ts,amount,payment_type,raw_description,source_terminal,receipt_type,source_key,import_fingerprint)
   values(v_day.id,v_t->>'ticket_number',v_ts,v_amount,v_t->>'payment_type',v_t->>'raw_description',coalesce(v_t->>'source_terminal',''),coalesce(v_t->>'receipt_type','sale'),v_key,v_fingerprint) returning id into v_id;
   v_inserted:=v_inserted+1;
  end if;
  for v_i in select value from jsonb_array_elements(v_t->'items') loop
   v_pid:=public.resolve_import_product(v_i);
   insert into public.ticket_items(ticket_id,product_id,product_name_raw,qty,unit_price,unit_cost,line_net_amount,line_cost_amount)
   values(v_id,v_pid,v_i->>'raw',(v_i->>'qty')::numeric,(v_i->>'unit_price')::numeric,(v_i->>'unit_cost')::numeric,(v_i->>'line_net_amount')::numeric,(v_i->>'line_cost_amount')::numeric);
  end loop;
 end loop;
 for v_g in select value from jsonb_array_elements(p_games) loop
  if (v_g->>'cars_parked')::int<0 or (v_g->>'cars_charged')::int<0 or (v_g->>'parking_rate')::numeric<0 or (v_g->>'cars_charged')::int>(v_g->>'cars_parked')::int then raise exception 'Datos de estacionamiento inválidos'; end if;
  select count(*),(array_agg(id))[1] into v_matches,v_game_id from public.games where sale_day_id=v_day.id and start_time=(v_g->>'start_time')::time;
  if v_matches>1 then raise exception 'Existen partidos duplicados a la misma hora'; end if;
  if v_game_id is null then
   insert into public.games(sale_day_id,start_time,cars_parked,cars_charged,parking_rate,charges_parking,notes) values(v_day.id,(v_g->>'start_time')::time,(v_g->>'cars_parked')::int,(v_g->>'cars_charged')::int,(v_g->>'parking_rate')::numeric,(v_g->>'charges_parking')::boolean,v_g->>'notes');
  elsif public.is_admin() then
   update public.games set cars_parked=(v_g->>'cars_parked')::int,cars_charged=(v_g->>'cars_charged')::int,parking_rate=(v_g->>'parking_rate')::numeric,charges_parking=(v_g->>'charges_parking')::boolean,notes=v_g->>'notes' where id=v_game_id;
  elsif exists(select 1 from public.games g where g.id=v_game_id and (g.cars_parked<>(v_g->>'cars_parked')::int or g.cars_charged<>(v_g->>'cars_charged')::int or g.parking_rate<>(v_g->>'parking_rate')::numeric or g.charges_parking<>(v_g->>'charges_parking')::boolean or coalesce(g.notes,'')<>coalesce(v_g->>'notes',''))) then raise exception 'Administración debe corregir el partido existente';
  end if;
 end loop;
 for v_c in select value from jsonb_array_elements(p_counts) loop
  v_pid:=public.resolve_import_product(v_c);v_count_ts:=(v_c->>'counted_at')::timestamptz;
  if v_pid is null or (v_c->>'physical_count')::numeric<0 or v_c->>'physical_count' is null or v_count_ts is null or v_count_ts>now()+interval '5 minutes' or (v_count_ts at time zone 'America/Mexico_City')::date<>v_date or coalesce(v_c->>'count_source','') not in ('manual','pos') then raise exception 'Conteo, producto o fecha/hora inválidos'; end if;
  select count(*),(array_agg(id))[1] into v_matches,v_count_id from public.inventory_counts where sale_day_id=v_day.id and product_id=v_pid;
  if v_matches>1 then raise exception 'Hay conteos históricos duplicados para este producto'; end if;
  select * into v_previous from public.inventory_counts where product_id=v_pid and counted_at<v_count_ts and (v_count_id is null or id<>v_count_id) order by counted_at desc limit 1;
  v_open:=null;v_sales:=null;
  if found then
   select coalesce(sum(i.qty),0) into v_sales from public.ticket_items i join public.tickets t on t.id=i.ticket_id where i.product_id=v_pid and t.ts>v_previous.counted_at and t.ts<=v_count_ts;
   select coalesce(sum(qty),0) into v_moves from public.inventory_movements where product_id=v_pid and occurred_at>v_previous.counted_at and occurred_at<=v_count_ts;
   v_open:=v_previous.physical_count+v_moves;
  end if;
  if v_count_id is null then
   insert into public.inventory_counts(sale_day_id,product_id,physical_count,counted_at,count_source,opening_stock,sold,note) values(v_day.id,v_pid,(v_c->>'physical_count')::numeric,v_count_ts,v_c->>'count_source',v_open,v_sales,v_c->>'note');
  else
   if not public.is_admin() and exists(select 1 from public.inventory_counts c where c.id=v_count_id and (c.physical_count is distinct from (v_c->>'physical_count')::numeric or c.counted_at is distinct from v_count_ts or c.count_source is distinct from v_c->>'count_source' or coalesce(c.note,'')<>coalesce(v_c->>'note',''))) then raise exception 'Administración debe corregir el conteo existente'; end if;
   update public.inventory_counts set physical_count=(v_c->>'physical_count')::numeric,counted_at=v_count_ts,count_source=v_c->>'count_source',opening_stock=v_open,sold=v_sales,note=v_c->>'note' where id=v_count_id;
  end if;
 end loop;
 return jsonb_build_object('day_id',v_day.id,'inserted',v_inserted,'skipped',v_skipped,'repaired',v_repaired);
end;
$$;

create or replace function public.record_inventory_movement(p_product uuid,p_at timestamptz,p_qty numeric,p_kind text,p_note text,p_client_ref uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_at is null or p_at>now()+interval '5 minutes' or (not public.is_admin() and p_at<now()-interval '31 days') or p_qty is null or p_qty=0 or p_kind not in ('purchase','waste','adjustment') or nullif(trim(p_note),'') is null or p_client_ref is null then raise exception 'Movimiento inválido'; end if;
 if (p_kind='purchase' and p_qty<0) or (p_kind='waste' and p_qty>0) then raise exception 'El signo no coincide con el movimiento'; end if;
 if exists(select 1 from public.sale_days where date=(p_at at time zone 'America/Mexico_City')::date and status='reviewed') then raise exception 'Reabre el día cerrado antes de modificar inventario'; end if;
 insert into public.inventory_movements(product_id,occurred_at,qty,kind,note,client_ref,created_by) values(p_product,p_at,p_qty,p_kind,trim(p_note),p_client_ref,auth.uid()) on conflict(client_ref) do nothing returning id into result;
 if result is null then
  select id into result from public.inventory_movements where client_ref=p_client_ref and product_id=p_product and occurred_at=p_at and qty=p_qty and kind=p_kind and note=trim(p_note) and created_by=auth.uid();
  if result is null then raise exception 'Identidad de movimiento usada con otros datos'; end if;
 end if;
 return result;
end;
$$;

create or replace function public.set_day_reviewed(p_day uuid,p_reviewed boolean) returns void
language plpgsql security definer set search_path=public as $$
begin
 if not public.is_admin() then raise exception 'Solo administración puede cerrar o reabrir'; end if;
 if p_reviewed and exists(select 1 from public.tickets t where t.sale_day_id=p_day and not exists(select 1 from public.ticket_items i where i.ticket_id=t.id)) then raise exception 'Hay recibos sin detalle. Concilia antes de cerrar'; end if;
 update public.sale_days set status=case when p_reviewed then 'reviewed' else 'submitted' end where id=p_day;
 if not found then raise exception 'Día inexistente'; end if;
end;
$$;
revoke all on function public.resolve_import_product(jsonb), public.record_audit() from public,anon,authenticated;
revoke all on function public.save_sale_day(jsonb,jsonb,jsonb,jsonb,boolean),public.record_inventory_movement(uuid,timestamptz,numeric,text,text,uuid),public.set_day_reviewed(uuid,boolean) from public,anon;
grant execute on function public.save_sale_day(jsonb,jsonb,jsonb,jsonb,boolean),public.record_inventory_movement(uuid,timestamptz,numeric,text,text,uuid),public.set_day_reviewed(uuid,boolean) to authenticated;

create or replace function public.protect_last_admin() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if old.role='admin' and old.active and (new.role<>'admin' or not new.active) then
  perform pg_advisory_xact_lock(hashtext('olivos-admin-roles'));
  if not exists(select 1 from public.profiles where id<>old.id and role='admin' and active) then raise exception 'Debe quedar al menos un administrador activo'; end if;
 end if;
 return new;
end;$$;
drop trigger if exists protect_last_admin on public.profiles;
create trigger protect_last_admin before update on public.profiles for each row execute function public.protect_last_admin();
revoke all on function public.protect_last_admin() from public,anon,authenticated;

insert into public.schema_versions(version) values(2026100502) on conflict do nothing;
notify pgrst, 'reload schema';
commit;
