-- ============================================================
-- Correr UNA SOLA VEZ, después de registrar tu primer usuario
-- desde la app (pantalla de "Crear cuenta").
--
-- Reemplaza el correo por el que usaste para registrarte y
-- corre esto en Supabase: Project > SQL Editor > New query > Run
-- ============================================================

update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'TU_CORREO_AQUI@ejemplo.com');

-- Verifica que sí quedó como admin:
select p.id, p.full_name, p.role, u.email
from public.profiles p
join auth.users u on u.id = p.id;
