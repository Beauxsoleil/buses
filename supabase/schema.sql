-- =====================================================================
--  Fleet Maintenance Tracker — reference schema
--
--  This is the shape of the production database, reconstructed from the
--  live project so a fresh Supabase project can be stood up from the repo.
--  Every statement is idempotent (IF NOT EXISTS / exception guards), so it
--  is also safe to run against the existing project: it will not alter or
--  drop anything that already exists.
--
--  Apply order:
--    1. supabase/schema.sql                    (this file)
--    2. supabase/migrations/0001_admin_access.sql  (RLS, triggers, RPCs)
--    3. supabase/seed-maintenance-items.sql    (optional starter templates)
--    4. supabase/seed-history.sql              (optional demo data)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------

do $$ begin
  create type public.bus_status as enum ('ACTIVE', 'OUT_OF_SERVICE', 'RETIRED', 'SOLD');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.maintenance_category as enum (
    'ENGINE', 'BRAKES', 'TIRES', 'ELECTRICAL', 'DRIVETRAIN', 'FLUIDS', 'EXHAUST',
    'HVAC', 'SAFETY_EQUIPMENT', 'BODY_EXTERIOR', 'COMPLIANCE', 'OTHER'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.priority_level as enum ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.defect_severity as enum ('MINOR', 'MAJOR', 'SAFETY_CRITICAL');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.defect_status as enum ('REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DEFERRED', 'RESOLVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.mileage_source as enum ('MANUAL');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.buses (
  id                           uuid primary key default gen_random_uuid(),
  bus_number                   text not null unique,
  nickname                     text,
  vin                          text,
  year                         integer,
  make                         text,
  model                        text,
  license_plate                text,
  license_plate_expiration     date,
  current_mileage              integer not null default 0,
  engine_hours                 numeric,
  date_acquired                date,
  status                       public.bus_status not null default 'ACTIVE',
  dot_inspection_due_date      date,
  insurance_expiration_date    date,
  registration_expiration_date date,
  notes                        text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create table if not exists public.maintenance_items (
  id                            uuid primary key default gen_random_uuid(),
  name                          text not null unique,
  description                   text,
  category                      public.maintenance_category not null,
  default_interval_miles        integer,
  default_interval_days         integer,
  default_interval_engine_hours numeric,
  is_regulatory                 boolean not null default false,
  estimated_duration_minutes    integer,
  priority                      public.priority_level not null default 'MEDIUM',
  is_active                     boolean not null default true,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create table if not exists public.bus_maintenance_schedules (
  id                           uuid primary key default gen_random_uuid(),
  bus_id                       uuid not null references public.buses(id) on delete cascade,
  maintenance_item_id          uuid not null references public.maintenance_items(id) on delete restrict,
  custom_interval_miles        integer,
  custom_interval_days         integer,
  custom_interval_engine_hours numeric,
  last_completed_date          date,
  last_completed_mileage       integer,
  last_completed_engine_hours  numeric,
  next_due_date                date,
  next_due_mileage             integer,
  next_due_engine_hours        numeric,
  is_active                    boolean not null default true,
  notes                        text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create table if not exists public.maintenance_logs (
  id                          uuid primary key default gen_random_uuid(),
  bus_id                      uuid not null references public.buses(id) on delete cascade,
  maintenance_item_id         uuid references public.maintenance_items(id) on delete set null,
  bus_maintenance_schedule_id uuid references public.bus_maintenance_schedules(id) on delete set null,
  date_performed              date not null default current_date,
  mileage_at_service          integer,
  engine_hours_at_service     numeric,
  performed_by                text,
  cost                        numeric,
  parts_cost                  numeric,
  labor_cost                  numeric,
  vendor                      text,
  work_order_number           text,
  description                 text,
  parts_used                  jsonb not null default '[]'::jsonb,
  next_due_date               date,
  next_due_mileage            integer,
  attachments                 jsonb not null default '[]'::jsonb,
  notes                       text,
  created_at                  timestamptz not null default now()
);

create table if not exists public.mileage_log (
  id            uuid primary key default gen_random_uuid(),
  bus_id        uuid not null references public.buses(id) on delete cascade,
  mileage       integer not null,
  engine_hours  numeric,
  date_recorded timestamptz not null default now(),
  source        public.mileage_source not null default 'MANUAL',
  notes         text
);

create table if not exists public.defect_reports (
  id                      uuid primary key default gen_random_uuid(),
  bus_id                  uuid not null references public.buses(id) on delete cascade,
  reported_by             text,
  reported_date           timestamptz not null default now(),
  category                public.maintenance_category not null default 'OTHER',
  severity                public.defect_severity not null default 'MINOR',
  description             text not null,
  status                  public.defect_status not null default 'REPORTED',
  resolution_description  text,
  resolved_date           timestamptz,
  resolved_by             text,
  maintenance_log_id      uuid references public.maintenance_logs(id) on delete set null,
  photos                  jsonb not null default '[]'::jsonb,
  is_bus_safe_to_operate  boolean not null default true
);

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes the dashboards lean on
-- ---------------------------------------------------------------------

create index if not exists bus_maintenance_schedules_bus_id_idx on public.bus_maintenance_schedules (bus_id);
create index if not exists bus_maintenance_schedules_next_due_idx on public.bus_maintenance_schedules (next_due_date) where is_active;
create index if not exists maintenance_logs_bus_date_idx on public.maintenance_logs (bus_id, date_performed desc);
create index if not exists mileage_log_bus_date_idx on public.mileage_log (bus_id, date_recorded);
create index if not exists defect_reports_bus_status_idx on public.defect_reports (bus_id, status);

-- ---------------------------------------------------------------------
-- Default settings (only inserted when missing)
-- ---------------------------------------------------------------------

insert into public.app_settings (key, value) values
  ('timezone', '"America/Denver"'),
  ('dashboard_auto_refresh_seconds', '60'),
  ('dashboard_auto_rotate_seconds', '30'),
  ('upcoming_threshold_days', '7'),
  ('upcoming_threshold_miles', '500'),
  ('compliance_warning_days', '[30, 60, 90]'),
  ('stale_mileage_alert_days', '14'),
  ('daily_digest_time', '"07:00"'),
  ('weekly_report_day', '"MONDAY"'),
  ('notification_cooldown_hours', '{"due": 12, "overdue": 24, "upcoming": 24}')
on conflict (key) do nothing;
