-- Permite que un operador corrija un conteo de inventario reciente.
-- El administrador conserva acceso a cualquier fecha.

drop policy if exists "inventory_counts_update" on public.inventory_counts;

create policy "inventory_counts_update" on public.inventory_counts
  for update
  using (
    public.is_admin()
    or exists (
      select 1
      from public.sale_days d
      where d.id = inventory_counts.sale_day_id
        and d.date >= current_date - 30
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1
      from public.sale_days d
      where d.id = inventory_counts.sale_day_id
        and d.date >= current_date - 30
    )
  );
