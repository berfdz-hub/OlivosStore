-- Apply before deploying the updated frontend. Existing approved users retain access.
begin;
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where id=auth.uid() and active);
$$;
create or replace function public.can_read_day(p_day uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select public.is_active_user() and exists(select 1 from public.sale_days d where d.id=p_day and
    (public.is_admin() or public.can_see_all_days() or d.day_type='evento_especial' or d.date >= (now() at time zone 'America/Mexico_City')::date - 31));
$$;
create or replace function public.can_edit_day(p_day uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select public.is_active_user() and exists(select 1 from public.sale_days d where d.id=p_day and
    (public.is_admin() or (d.status <> 'reviewed' and d.date >= (now() at time zone 'America/Mexico_City')::date - 31)));
$$;

alter table public.profiles alter column active set default false;
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,full_name,role,active) values(new.id,new.raw_user_meta_data->>'full_name','operador',false);
  return new;
end;
$$;

-- Replace permissive policies, including any older overlapping versions.
do $$ declare p record; t text; begin
  foreach t in array array['profiles','products','sale_days','games','tickets','ticket_items','inventory_counts','scheduled_games','app_settings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, public',t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated',t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I',p.policyname,t);
    end loop;
  end loop;
end $$;

create policy profiles_read on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
create policy profiles_admin on public.profiles for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy products_admin on public.products for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy settings_read on public.app_settings for select to authenticated using(public.is_active_user());
create policy settings_write on public.app_settings for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy days_read on public.sale_days for select to authenticated using(public.can_read_day(id));
create policy days_insert on public.sale_days for insert to authenticated with check(public.is_active_user() and created_by=auth.uid() and status<>'reviewed');
create policy days_update on public.sale_days for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy days_delete on public.sale_days for delete to authenticated using(public.is_admin());
do $$ declare t text; begin
  foreach t in array array['games','tickets','inventory_counts'] loop
    execute format('create policy scoped_read on public.%I for select to authenticated using(public.can_read_day(sale_day_id))',t);
    execute format('create policy scoped_insert on public.%I for insert to authenticated with check(public.can_edit_day(sale_day_id))',t);
    execute format('create policy admin_change on public.%I for update to authenticated using(public.is_admin()) with check(public.is_admin())',t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using(public.is_admin())',t);
  end loop;
end $$;
create policy items_read on public.ticket_items for select to authenticated using(exists(select 1 from public.tickets t where t.id=ticket_id and public.can_read_day(t.sale_day_id)));
create policy items_insert on public.ticket_items for insert to authenticated with check(exists(select 1 from public.tickets t where t.id=ticket_id and public.can_edit_day(t.sale_day_id)));
create policy items_admin on public.ticket_items for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy items_delete on public.ticket_items for delete to authenticated using(public.is_admin());
create policy scheduled_read on public.scheduled_games for select to authenticated using(public.is_active_user());
create policy scheduled_insert on public.scheduled_games for insert to authenticated with check(public.is_active_user() and created_by=auth.uid());
create policy scheduled_update on public.scheduled_games for update to authenticated using(public.is_active_user() and (public.is_admin() or created_by=auth.uid())) with check(public.is_active_user() and (public.is_admin() or created_by=auth.uid()));
create policy scheduled_delete on public.scheduled_games for delete to authenticated using(public.is_active_user() and (public.is_admin() or created_by=auth.uid()));

create or replace view public.products_view with (security_invoker=false) as
select id,name,category,sell_price,active,case when public.can_see_costs() then cost_price else null end as cost_price
from public.products where public.is_active_user();
revoke all on public.products_view, public.tickets_view from anon, public;
grant select on public.products_view, public.tickets_view to authenticated;

-- The old import helper could change existing catalogue prices and accepted NULL roles.
create or replace function public.register_imported_product(p_name text,p_category text,p_sell_price numeric,p_cost_price numeric default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid;
begin
  if not public.is_active_user() then raise exception 'Cuenta no autorizada'; end if;
  if nullif(trim(p_name),'') is null or p_sell_price is null or p_sell_price<0 or p_cost_price<0 then raise exception 'Producto inválido'; end if;
  perform pg_advisory_xact_lock(hashtext(lower(trim(p_name))));
  select id into result from public.products where lower(trim(name))=lower(trim(p_name)) limit 1;
  if result is null then
    insert into public.products(name,category,sell_price,cost_price) values(trim(p_name),coalesce(nullif(trim(p_category),''),'Otro'),p_sell_price,p_cost_price) returning id into result;
  end if;
  return result;
end;
$$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('is_active_user','can_read_day','can_edit_day','is_admin','can_see_all_days','can_see_costs','can_see_amount','dia_visible_operador','latest_sale_day_id','latest_sale_day_date','register_imported_product','handle_new_user') loop
    execute format('revoke all on function %s from public, anon',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
revoke all on function public.handle_new_user() from authenticated;
commit;
