begin;

-- Preserve every stored value and the public view contracts. RLS now governs
-- the ordinary columns; cost columns cannot be selected from the base tables.
-- Narrow helpers disclose costs only after checking the caller's app rights.
create schema if not exists olivos_private;
revoke all on schema olivos_private from public, anon, authenticated;
grant usage on schema olivos_private to authenticated, service_role;

create or replace function olivos_private.product_cost(p_product uuid)
returns numeric language sql stable security definer set search_path = ''
as $$
  select p.cost_price from public.products p
  where p.id = p_product and public.can_see_costs();
$$;

create or replace function olivos_private.ticket_item_costs(p_item uuid)
returns table(unit_cost numeric, line_cost_amount numeric)
language sql stable security definer set search_path = '' rows 1
as $$
  select i.unit_cost, i.line_cost_amount
  from public.ticket_items i join public.tickets t on t.id = i.ticket_id
  where i.id = p_item and public.can_see_costs()
    and public.can_read_day(t.sale_day_id);
$$;
revoke all on function olivos_private.product_cost(uuid), olivos_private.ticket_item_costs(uuid)
  from public, anon, authenticated;
grant execute on function olivos_private.product_cost(uuid), olivos_private.ticket_item_costs(uuid)
  to authenticated, service_role;

revoke select on public.products, public.ticket_items from public, anon, authenticated;
revoke select(cost_price) on public.products from public, anon, authenticated;
revoke select(unit_cost, line_cost_amount) on public.ticket_items from public, anon, authenticated;
grant select(id, name, category, sell_price, active, external_ref, perishable, storage_limit, perishable_limit)
  on public.products to authenticated;
grant select(id, ticket_id, product_id, product_name_raw, qty, unit_price, line_net_amount)
  on public.ticket_items to authenticated;

-- Split the former administrator ALL policy by operation, keeping the same
-- write checks without overlapping permissive SELECT policies.
drop policy if exists products_admin on public.products;
drop policy if exists products_read_active on public.products;
drop policy if exists products_insert_admin on public.products;
drop policy if exists products_update_admin on public.products;
drop policy if exists products_delete_admin on public.products;
create policy products_read_active on public.products for select to authenticated
  using ((select public.is_active_user()));
create policy products_insert_admin on public.products for insert to authenticated
  with check ((select public.is_admin()));
create policy products_update_admin on public.products for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy products_delete_admin on public.products for delete to authenticated
  using ((select public.is_admin()));
drop policy if exists items_read on public.ticket_items;
create policy items_read on public.ticket_items for select to authenticated
  using (ticket_id in (select t.id from public.tickets t));

create or replace view public.products_view
with (security_invoker = true, security_barrier = true) as
select p.id, p.name, p.category, p.sell_price, p.active,
  olivos_private.product_cost(p.id) as cost_price,
  p.external_ref, p.perishable, p.storage_limit, p.perishable_limit
from public.products p where (select public.is_active_user());

create or replace view public.ticket_items_view
with (security_invoker = true, security_barrier = true) as
select i.id, i.ticket_id, i.product_id, i.product_name_raw, i.qty,
  i.unit_price, i.line_net_amount, costs.unit_cost, costs.line_cost_amount
from public.ticket_items i
left join lateral olivos_private.ticket_item_costs(i.id) costs on true
where (select public.is_active_user());

revoke all on public.products_view, public.ticket_items_view from public, anon, authenticated;
grant select on public.products_view, public.ticket_items_view to authenticated;
insert into public.schema_versions(version) values (2026102702) on conflict do nothing;
notify pgrst, 'reload schema';
commit;
