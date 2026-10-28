begin;
alter table public.products add column merged_into uuid references public.products(id);
alter table public.products add constraint merged_product_archived check(merged_into is null or (merged_into<>id and not active));
grant select(merged_into) on public.products to authenticated;
create index products_merged_into_idx on public.products(merged_into) where merged_into is not null;

-- Reconciliation evidence is append-only. Original product rows are archived,
-- while ticket/count/movement row identities and source values are retained.
create table public.product_reconciliations (
 id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
 performed_by text not null, reason text not null check(length(trim(reason))>=8),
 source_product uuid not null references public.products, target_product uuid not null references public.products,
 before_data jsonb not null, after_data jsonb not null,
 item_ids uuid[] not null default '{}', count_ids uuid[] not null default '{}', movement_ids uuid[] not null default '{}'
);
alter table public.product_reconciliations enable row level security;
revoke all on public.product_reconciliations from public,anon,authenticated;
grant select on public.product_reconciliations to authenticated;
create policy reconciliation_admin_read on public.product_reconciliations for select to authenticated using(public.is_admin());
create trigger immutable_history before update or delete on public.product_reconciliations for each row execute function public.prevent_history_changes();

create or replace view public.products_view with(security_invoker=true,security_barrier=true) as
select p.id,p.name,p.category,p.sell_price,p.active,olivos_private.product_cost(p.id) as cost_price,
 p.external_ref,p.perishable,p.storage_limit,p.perishable_limit,p.merged_into,
 coalesce((select jsonb_agg(jsonb_build_object('name',a.name,'external_ref',a.external_ref) order by a.name)
   from public.products a where a.merged_into=p.id),'[]'::jsonb) as aliases
from public.products p where (select public.is_active_user());

-- Extend the established import routines without widening their privileges.
-- Canonicalize IDs before checking active status or SKU compatibility.
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.resolve_import_product(jsonb)'::regprocedure) into definition;
 if position('if result is not null and v_ref is not null and exists' in definition)=0 then raise exception 'Unexpected receipt resolver'; end if;
 definition:=replace(definition,'if result is not null and v_ref is not null and exists',
  'if result is not null then select coalesce(merged_into,id) into result from public.products where id=result; end if;'||chr(10)||' if result is not null and v_ref is not null and exists');
 execute definition;

 select pg_get_functiondef('public.save_inventory_count(jsonb,uuid)'::regprocedure) into definition;
 if position('pid:=nullif(c->>''product_id'','''')::uuid;' in definition)=0 or position('if resolved is not null and pid is not null and pid<>resolved' in definition)=0 then raise exception 'Unexpected inventory resolver'; end if;
 definition:=replace(definition,'pid:=nullif(c->>''product_id'','''')::uuid;',
  'pid:=nullif(c->>''product_id'','''')::uuid;'||chr(10)||'  if pid is not null then select coalesce(merged_into,id) into pid from public.products where id=pid; end if;');
 definition:=replace(definition,'if resolved is not null and pid is not null and pid<>resolved',
  'if resolved is not null then select coalesce(merged_into,id) into resolved from public.products where id=resolved; end if;'||chr(10)||'   if resolved is not null and pid is not null and pid<>resolved');
 execute definition;

 select pg_get_functiondef('public.register_imported_product(text,text,numeric,numeric)'::regprocedure) into definition;
 if position('return result;' in definition)=0 then raise exception 'Unexpected legacy resolver'; end if;
 execute replace(definition,'return result;','select coalesce(merged_into,id) into result from public.products where id=result;'||chr(10)||'  return result;');
end;
$migration$;
insert into public.schema_versions(version) values(2026102801);
notify pgrst,'reload schema';
commit;
