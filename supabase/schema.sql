-- ============================================================
-- Tienda Olivos — esquema de base de datos
-- Pegar completo en Supabase: Project > SQL Editor > New query > Run
-- ============================================================

-- ---------- extensiones ----------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ============================================================
-- 1. PERFILES (rol de cada usuario: admin | operador)
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'operador' check (role in ('admin','operador')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- función helper: ¿el usuario actual es admin activo?
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active = true
  );
$$;

-- cada quien ve su propio perfil; el admin ve todos
create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- solo el admin edita perfiles (incluido el rol)
create policy "profiles_update" on public.profiles
  for update using (public.is_admin());

-- crear perfil automáticamente cuando alguien se registra
-- (nace como 'operador'; el primer admin se promueve a mano, ver hacer_admin.sql)
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 2. PRODUCTOS (catálogo, costos — el costo se oculta a operadores)
-- ============================================================
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null default 'Otro',
  cost_price numeric(10,2),
  sell_price numeric(10,2) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;

-- la tabla base solo la lee el admin directamente (para no exponer costos)
create policy "products_select_admin" on public.products
  for select using (public.is_admin());

create policy "products_write_admin" on public.products
  for insert with check (public.is_admin());
create policy "products_update_admin" on public.products
  for update using (public.is_admin());
create policy "products_delete_admin" on public.products
  for delete using (public.is_admin());

-- vista pública: cualquier usuario autenticado la usa para los formularios
-- de captura; el costo de compra viaja como NULL si no eres admin.
create view public.products_view
with (security_invoker = true) as
select
  id, name, category, sell_price, active,
  case when public.is_admin() then cost_price else null end as cost_price
from public.products;

grant select on public.products_view to authenticated;

-- ============================================================
-- 3. DÍAS DE VENTA (una fila por día capturado)
-- ============================================================
create table public.sale_days (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  sport text,
  status text not null default 'draft' check (status in ('draft','submitted','reviewed')),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.sale_days enable row level security;

create policy "sale_days_select" on public.sale_days
  for select using (auth.uid() is not null);
create policy "sale_days_insert" on public.sale_days
  for insert with check (auth.uid() is not null);
create policy "sale_days_update" on public.sale_days
  for update using (public.is_admin() or (created_by = auth.uid() and status = 'draft'));
create policy "sale_days_delete" on public.sale_days
  for delete using (public.is_admin());

-- ============================================================
-- 4. PARTIDOS / ESTACIONAMIENTO (por día)
-- ============================================================
create table public.games (
  id uuid primary key default gen_random_uuid(),
  sale_day_id uuid not null references public.sale_days(id) on delete cascade,
  start_time time not null,
  cars_parked int not null default 0,
  cars_charged int not null default 0,
  parking_rate numeric(10,2) not null default 30,
  charges_parking boolean not null default true,
  notes text
);

alter table public.games enable row level security;

create policy "games_select" on public.games for select using (auth.uid() is not null);
create policy "games_insert" on public.games for insert with check (auth.uid() is not null);
create policy "games_update" on public.games for update using (public.is_admin());
create policy "games_delete" on public.games for delete using (public.is_admin());

-- ============================================================
-- 5. TICKETS (recibos del día) y sus productos
-- ============================================================
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  sale_day_id uuid not null references public.sale_days(id) on delete cascade,
  ticket_number text,
  ts timestamptz not null,
  amount numeric(10,2) not null,
  payment_type text,
  raw_description text,
  created_at timestamptz not null default now()
);

alter table public.tickets enable row level security;

create policy "tickets_select" on public.tickets for select using (auth.uid() is not null);
create policy "tickets_insert" on public.tickets for insert with check (auth.uid() is not null);
create policy "tickets_update" on public.tickets for update using (public.is_admin());
create policy "tickets_delete" on public.tickets for delete using (public.is_admin());

create table public.ticket_items (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  product_id uuid references public.products(id),
  product_name_raw text not null,
  qty int not null default 1
);

alter table public.ticket_items enable row level security;

create policy "ticket_items_select" on public.ticket_items for select using (auth.uid() is not null);
create policy "ticket_items_insert" on public.ticket_items for insert with check (auth.uid() is not null);
create policy "ticket_items_update" on public.ticket_items for update using (public.is_admin());
create policy "ticket_items_delete" on public.ticket_items for delete using (public.is_admin());

-- ============================================================
-- 6. CONTEOS DE INVENTARIO (teórico vs físico, por día)
-- ============================================================
create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  sale_day_id uuid not null references public.sale_days(id) on delete cascade,
  product_id uuid references public.products(id),
  opening_stock int,
  sold int,
  physical_count int,
  note text
);

alter table public.inventory_counts enable row level security;

create policy "inventory_counts_select" on public.inventory_counts for select using (auth.uid() is not null);
create policy "inventory_counts_insert" on public.inventory_counts for insert with check (auth.uid() is not null);
create policy "inventory_counts_update" on public.inventory_counts for update using (public.is_admin());
create policy "inventory_counts_delete" on public.inventory_counts for delete using (public.is_admin());

-- ============================================================
-- Listo. Siguiente paso: registra tu primer usuario desde la app
-- y luego corre notas.sql para volverlo admin.
-- ============================================================
