-- ============================================================
-- Cambia el nombre del rol "trabajador" a "operador" en toda la
-- base de datos. Corre esto UNA VEZ en Supabase (SQL Editor > Run).
-- Es seguro correrlo aunque ya tengas cuentas creadas.
-- ============================================================

-- 1. quitar la validación vieja para poder actualizar los datos
alter table public.profiles drop constraint if exists profiles_role_check;

-- 2. renombrar el valor en las filas existentes
update public.profiles set role = 'operador' where role = 'trabajador';

-- 3. las cuentas nuevas nacerán como 'operador'
alter table public.profiles alter column role set default 'operador';

-- 4. volver a poner la validación, ahora con el nombre nuevo
alter table public.profiles add constraint profiles_role_check
  check (role in ('operador', 'admin'));

-- 5. la función que crea el perfil al registrarse también debe
--    usar el nuevo nombre por default
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', 'operador');
  return new;
end;
$$;

-- Verifica que quedó bien:
select id, full_name, role, active from public.profiles;
