-- Vehicle information and legacy records imported from the district Access back end.
-- Individual driver records and the complete source snapshots are admin-only.
alter table public.buses
  add column if not exists vehicle_type text,
  add column if not exists fuel_type text,
  add column if not exists capacity integer,
  add column if not exists mileage_as_of date,
  add column if not exists engine_serial text,
  add column if not exists body_serial text,
  add column if not exists chassis_serial text,
  add column if not exists transmission_serial text,
  add column if not exists body_service_number text,
  add column if not exists engine_type text,
  add column if not exists bliss_bus boolean,
  add column if not exists source_system text;

create table if not exists public.vehicle_details (
  bus_id uuid primary key references public.buses(id) on delete cascade,
  specifications jsonb not null default '{}'::jsonb,
  tires jsonb not null default '{}'::jsonb,
  filters jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.vehicle_details enable row level security;
drop policy if exists "public read" on public.vehicle_details;
create policy "public read" on public.vehicle_details for select to anon, authenticated using (true);
drop policy if exists "admin insert" on public.vehicle_details;
create policy "admin insert" on public.vehicle_details for insert to authenticated with check (public.is_admin());
drop policy if exists "admin update" on public.vehicle_details;
create policy "admin update" on public.vehicle_details for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select on public.vehicle_details to anon, authenticated;
grant insert, update on public.vehicle_details to authenticated;

-- Captures fields that do not fit the operational schema, including driver
-- contacts and exact original inspection/service rows. Never expose to anon.
create table if not exists public.access_import_rows (
  source_table text not null,
  source_key text not null,
  bus_id uuid references public.buses(id) on delete set null,
  source_data jsonb not null,
  imported_at timestamptz not null default now(),
  primary key (source_table, source_key)
);
create index if not exists access_import_rows_bus_idx on public.access_import_rows(bus_id);
alter table public.access_import_rows enable row level security;
drop policy if exists "admin read" on public.access_import_rows;
create policy "admin read" on public.access_import_rows for select to authenticated using (public.is_admin());
drop policy if exists "admin insert" on public.access_import_rows;
create policy "admin insert" on public.access_import_rows for insert to authenticated with check (public.is_admin());
drop policy if exists "admin update" on public.access_import_rows;
create policy "admin update" on public.access_import_rows for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update on public.access_import_rows to authenticated;
