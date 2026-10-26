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
alter table public.sale_days add column if not exists event_groups jsonb;
alter table public.sale_days add constraint sale_days_event_groups_check check(public.valid_event_groups(event_groups));
create or replace function public.day_metadata(p_day public.sale_days) returns jsonb language sql immutable set search_path=public as $$
select jsonb_build_object('sport',p_day.sport,'day_type',p_day.day_type,'event_name',p_day.event_name,'event_tags',p_day.event_tags,'notes',p_day.notes,'event_groups',p_day.event_groups);
$$;
create or replace function public.request_day_correction(p_day uuid,p_after jsonb,p_before jsonb,p_reason text,p_client_ref uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare d public.sale_days%rowtype; current_data jsonb; proposed jsonb; tags text[]; direct boolean; result uuid; prior public.day_corrections%rowtype;
begin
 p_before:=jsonb_build_object('event_groups',null)||p_before;
 p_after:=jsonb_build_object('event_groups',p_before->'event_groups')||p_after;
 if not public.valid_event_groups(p_after->'event_groups') then raise exception 'Desglose de eventos inválido'; end if;
 if not public.is_active_user() or not public.can_read_day(p_day) then raise exception 'No tienes acceso a este día'; end if;
 if p_client_ref is null or length(trim(coalesce(p_reason,'')))<8 then raise exception 'Explica el motivo del cambio (al menos 8 caracteres)'; end if;
 perform pg_advisory_xact_lock(hashtext(p_client_ref::text));
 select * into prior from public.day_corrections where client_ref=p_client_ref;
 if found then
  if prior.day_id<>p_day or prior.requested_by<>auth.uid() or prior.reason<>trim(p_reason) or (jsonb_build_object('event_groups',null)||prior.before_data)<>p_before or (jsonb_build_object('event_groups',null)||prior.after_data)<>p_after then raise exception 'El reintento contiene otros datos'; end if;
  return jsonb_build_object('id',prior.id,'applied',prior.applied_immediately);
 end if;
 select * into d from public.sale_days where id=p_day for update;
 current_data:=public.day_metadata(d);
 if p_before is distinct from current_data then raise exception 'El día cambió desde que lo abriste. Recarga y revisa la propuesta'; end if;
 if p_after->>'sport' is null or p_after->>'sport' not in ('futbol','beisbol','otro') or p_after->>'day_type' is null or p_after->>'day_type' not in ('evento_especial','dia_partido','entrenamiento_normal') or jsonb_typeof(p_after->'event_tags') is distinct from 'array' then raise exception 'Clasificación inválida'; end if;
 tags:=array(select jsonb_array_elements_text(p_after->'event_tags'));
 if not tags<@array['futbol','beisbol','club_puebla','otro'] then raise exception 'Etiquetas inválidas'; end if;
 proposed:=jsonb_build_object('sport',p_after->>'sport','day_type',p_after->>'day_type','event_name',nullif(trim(p_after->>'event_name'),''),'event_tags',tags,'notes',nullif(trim(p_after->>'notes'),''),'event_groups',p_after->'event_groups');
 if proposed<>p_after then raise exception 'Envía solo la clasificación, el evento, las etiquetas y las notas'; end if;
 if current_data=proposed then raise exception 'No hay cambios para guardar'; end if;
 direct:=d.status<>'reviewed' and (public.is_admin() or (d.created_by=auth.uid() and d.date=(now() at time zone 'America/Mexico_City')::date));
 insert into public.day_corrections(day_id,requested_by,requested_name,reason,before_data,after_data,applied_immediately,client_ref)
 values(d.id,auth.uid(),coalesce((select full_name from public.profiles where id=auth.uid()),'Usuario'),trim(p_reason),current_data,proposed,direct,p_client_ref) returning id into result;
 if direct then
  update public.sale_days set sport=proposed->>'sport',day_type=proposed->>'day_type',event_name=proposed->>'event_name',event_tags=tags,notes=proposed->>'notes',event_groups=nullif(proposed->'event_groups','null'::jsonb) where id=d.id;
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
  if public.day_metadata(d)<>(jsonb_build_object('event_groups',null)||c.before_data) then raise exception 'El día cambió después de la solicitud. Recházala y registra una propuesta actualizada'; end if;
  update public.sale_days set sport=c.after_data->>'sport',day_type=c.after_data->>'day_type',event_name=c.after_data->>'event_name',event_tags=array(select jsonb_array_elements_text(c.after_data->'event_tags')),notes=c.after_data->>'notes',event_groups=nullif(c.after_data->'event_groups','null'::jsonb) where id=c.day_id;
 end if;
 insert into public.correction_decisions(correction_id,decided_by,decided_name,approved,note) values(c.id,auth.uid(),coalesce((select full_name from public.profiles where id=auth.uid()),'Administrador'),p_approve,trim(p_note));
end; $$;
create or replace function public.save_sale_day(p_day jsonb,p_tickets jsonb default '[]',p_games jsonb default '[]',p_counts jsonb default '[]',p_replace_existing boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_day public.sale_days%rowtype; v_date date:=(p_day->>'date')::date; v_t jsonb; v_i jsonb; v_g jsonb; v_c jsonb;
 v_id uuid; v_pid uuid; v_existing public.tickets%rowtype; v_key text; v_fingerprint text; v_amount numeric; v_sum numeric; v_ts timestamptz; v_count_ts timestamptz;
 v_matches int; v_inserted int:=0; v_skipped int:=0; v_repaired int:=0; v_count_id uuid; v_previous record; v_sales numeric; v_moves numeric; v_open numeric; v_game_id uuid;
begin
 if not public.valid_event_groups(p_day->'event_groups') then raise exception 'Desglose de eventos inválido'; end if;
 if p_day->'event_groups' is not null and p_day->'event_groups'<>'null'::jsonb and jsonb_array_length(p_games)>0 and not exists(select 1 from jsonb_array_elements(p_day->'event_groups') g where g->>'games' is null) and (select sum((g->>'games')::int) from jsonb_array_elements(p_day->'event_groups') g)<>jsonb_array_length(p_games) then raise exception 'El desglose no coincide con los partidos de estacionamiento'; end if;
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
  insert into public.sale_days(date,sport,day_type,event_name,event_tags,notes,status,created_by,event_groups)
  values(v_date,p_day->>'sport',coalesce(p_day->>'day_type','entrenamiento_normal'),nullif(p_day->>'event_name',''),array(select jsonb_array_elements_text(coalesce(p_day->'event_tags','[]'))),nullif(p_day->>'notes',''),'submitted',auth.uid(),nullif(p_day->'event_groups','null'::jsonb)) returning * into v_day;
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
alter table public.purchase_plans drop constraint purchase_plans_event_type_check;
alter table public.purchase_plans add constraint purchase_plans_event_type_check check(event_type in ('club_puebla','futbol','beisbol','entrenamiento','otro','sin_especificar','mixto'));
create or replace function public.save_purchase_plan(p_plan jsonb,p_client_ref uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare result uuid; prior public.purchase_plans%rowtype; r jsonb;
begin
 if not public.valid_event_groups(p_plan->'summary'->'groups') then raise exception 'Desglose de eventos inválido'; end if;
 if p_plan->>'event_type'='mixto' then
  if jsonb_typeof(p_plan->'summary'->'groups') is distinct from 'array' or p_plan->>'model_version'<>'eventos-2026-10-v3' then raise exception 'Falta el desglose de eventos'; end if;
  if exists(select 1 from jsonb_array_elements(p_plan->'summary'->'groups') g where g->>'games' is null) then
   if p_plan->>'games' is not null then raise exception 'El total debe quedar desconocido'; end if;
  elsif (p_plan->>'games')::numeric is distinct from (select sum((g->>'games')::numeric) from jsonb_array_elements(p_plan->'summary'->'groups') g) then raise exception 'El total no coincide con el desglose'; end if;
 end if;
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or (p_plan->>'event_date')::date<(now() at time zone 'America/Mexico_City')::date or coalesce(p_plan->>'model_version','') not in ('eventos-2026-10-v1','eventos-2026-10-v2','eventos-2026-10-v3') or jsonb_typeof(p_plan->'rows') is distinct from 'array' or jsonb_array_length(p_plan->'rows')=0 or jsonb_array_length(p_plan->'rows')>2000 then raise exception 'Propuesta inválida'; end if;
 if p_plan->>'event_date' is null or coalesce(p_plan->>'event_type','') not in ('club_puebla','futbol','beisbol','entrenamiento','otro','sin_especificar','mixto') or jsonb_typeof(p_plan->'summary') is distinct from 'object' then raise exception 'Revisa fecha y tipo de evento'; end if;
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
revoke all on function public.valid_event_groups(jsonb) from public,anon;
grant execute on function public.valid_event_groups(jsonb) to authenticated;
insert into public.schema_versions(version) values(2026102601) on conflict do nothing;
notify pgrst,'reload schema';
commit;