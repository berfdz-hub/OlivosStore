-- Permite que admin y operador registren productos nuevos encontrados
-- en un CSV de Loyverse sin dar acceso directo al catálogo completo.

create or replace function public.register_imported_product(
  p_name text,
  p_category text,
  p_sell_price numeric,
  p_cost_price numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_role text;
  v_name text := trim(p_name);
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión';
  end if;

  select role into v_role from public.profiles where id = auth.uid();
  if v_role not in ('admin', 'operador') then
    raise exception 'Rol sin permiso para importar productos';
  end if;
  if v_name is null or v_name = '' then
    raise exception 'El nombre del producto está vacío';
  end if;
  if p_sell_price is null or p_sell_price < 0 then
    raise exception 'El precio de venta no es válido';
  end if;

  -- Evita duplicados simultáneos y diferencias solo de mayúsculas.
  perform pg_advisory_xact_lock(hashtext(lower(v_name)));
  select id into v_product_id
  from public.products
  where lower(trim(name)) = lower(v_name)
  limit 1;

  if v_product_id is null then
    insert into public.products(name, category, sell_price, cost_price, active)
    values (
      v_name,
      coalesce(nullif(trim(p_category), ''), 'Otro'),
      p_sell_price,
      case when p_cost_price is not null and p_cost_price > 0 then p_cost_price else null end,
      true
    )
    returning id into v_product_id;
  end if;

  -- Repara ventas ya importadas antes de que el producto existiera.
  update public.ticket_items
  set product_id = v_product_id
  where product_id is null
    and lower(trim(product_name_raw)) = lower(v_name);

  return v_product_id;
end;
$$;

revoke all on function public.register_imported_product(text, text, numeric, numeric) from public;
grant execute on function public.register_imported_product(text, text, numeric, numeric) to authenticated;
