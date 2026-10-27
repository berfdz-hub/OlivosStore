begin;

-- These API views only serve reads. Supabase's default grants can otherwise
-- make an owner-rights, automatically updatable view a path around table RLS.
revoke all on public.products_view, public.ticket_items_view, public.tickets_view
  from public, anon, authenticated;
grant select on public.products_view, public.ticket_items_view, public.tickets_view
  to authenticated;

-- Keep account/day guards ahead of caller-supplied, non-leakproof predicates.
alter view public.products_view set (security_barrier = true);
alter view public.ticket_items_view set (security_barrier = true);

insert into public.schema_versions(version) values (2026102701)
  on conflict do nothing;
notify pgrst, 'reload schema';
commit;
