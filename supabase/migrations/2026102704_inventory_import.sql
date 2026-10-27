begin;
-- Historical imports have no recoverable filename. Preserve those NULLs.
alter table public.inventory_counts add column source_file text;

create or replace function public.save_inventory_count(p_counts jsonb,p_client_ref uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare
 c jsonb; pid uuid; resolved uuid; matches integer; at_time timestamptz; event_date date;
 prior public.inventory_count_requests%rowtype; v_name text; v_ref text; v_file text;
 v_price numeric; v_cost numeric;
begin
 if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
 if p_client_ref is null or jsonb_typeof(p_counts) is distinct from 'array' or jsonb_array_length(p_counts) not between 1 and 2000 then raise exception 'Agrega al menos un conteo'; end if;
 perform pg_advisory_xact_lock(hashtext('inventory-count-import'));
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
  v_file:=nullif(trim(c->>'source_file'),'');
  if length(v_file)>255 or v_file ~ E'[\\\\/\\n\\r]' then raise exception 'Nombre de archivo inválido'; end if;
  if v_file is not null then
   v_name:=nullif(trim(c->>'raw'),''); v_ref:=nullif(trim(c->>'external_ref'),'');
   if v_name is null or length(v_name)>300 or length(v_ref)>200 then raise exception 'Nombre o código de producto inválido'; end if;
   perform pg_advisory_xact_lock(hashtext(lower(v_name)));
   resolved:=null;
   if v_ref is not null then select id into resolved from public.products where external_ref=v_ref; end if;
   if resolved is null then
    select count(*),(array_agg(id))[1] into matches,resolved from public.products
    where lower(regexp_replace(normalize(trim(name),NFC),'\s+',' ','g'))=lower(regexp_replace(normalize(v_name,NFC),'\s+',' ','g'));
    if matches>1 then raise exception 'Hay varios productos con el nombre %. Revisa su código en Catálogo',v_name; end if;
   end if;
   if resolved is not null and pid is not null and pid<>resolved then raise exception 'El catálogo cambió para %. Recarga el archivo',v_name; end if;
   if resolved is null and pid is not null then raise exception 'El catálogo cambió para %. Recarga el archivo',v_name; end if;
   if resolved is not null and v_ref is not null and exists(select 1 from public.products where id=resolved and external_ref is not null and external_ref<>v_ref) then raise exception 'Código incompatible para %',v_name; end if;
   if resolved is null then
    if jsonb_typeof(c->'sell_price') is distinct from 'number' or (c->>'sell_price')::numeric<0 then raise exception 'Falta un precio válido para % en el archivo',v_name; end if;
    if c->'cost_price' is not null and c->'cost_price'<>'null'::jsonb and (jsonb_typeof(c->'cost_price') is distinct from 'number' or (c->>'cost_price')::numeric<0) then raise exception 'Costo inválido para %',v_name; end if;
    v_price:=(c->>'sell_price')::numeric; v_cost:=(c->>'cost_price')::numeric;
    insert into public.products(name,category,sell_price,cost_price,external_ref)
    values(v_name,coalesce(nullif(trim(c->>'category'),''),'Otro'),v_price,v_cost,v_ref) returning id into resolved;
   end if;
   -- Preserve prices, costs and active status for every existing product.
   pid:=resolved;
  end if;
  if pid is null or not exists(select 1 from public.products where id=pid and active) then raise exception 'Producto no disponible. Revisa el catálogo o importa el archivo de existencias'; end if;
  if exists(select 1 from public.inventory_counts where product_id=pid and ((at_time is not null and counted_at=at_time) or (at_time is null and counted_at is null and counted_on=event_date))) then raise exception 'Ya hay un conteo para ese producto y momento. Administración debe revisar el existente'; end if;
  insert into public.inventory_counts(product_id,physical_count,counted_at,counted_on,count_source,created_by,client_ref,note,source_file)
  values(pid,(c->>'physical_count')::numeric,at_time,event_date,c->>'count_source',auth.uid(),p_client_ref,coalesce(nullif(trim(c->>'note'),''),'Conteo independiente'),v_file);
 end loop;
 insert into public.inventory_count_requests values(p_client_ref,auth.uid(),p_counts);
 return jsonb_array_length(p_counts);
end; $$;
revoke all on function public.save_inventory_count(jsonb,uuid) from public,anon;
grant execute on function public.save_inventory_count(jsonb,uuid) to authenticated;
insert into public.schema_versions(version) values(2026102704);
notify pgrst,'reload schema';
commit;
