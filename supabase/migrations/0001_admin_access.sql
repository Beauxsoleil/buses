-- =====================================================================
--  0001_admin_access.sql
--
--  Locks the fleet database down to "anyone can read, only listed admins
--  can write", adds the integrity rules the Admin page relies on, and
--  creates the transactional RPCs behind the Add Bus wizard.
--
--  Safe to re-run. It is the single source of truth for the RLS policies
--  on the tables below: any policy that exists on them beforehand is
--  dropped and replaced.
--
--  After running it, list your admin account with supabase/grant-admin.sql
--  and turn off public sign-ups (Authentication -> Providers -> Email).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Admin allow-list
-- ---------------------------------------------------------------------

create table if not exists public.admin_users (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  email    text,
  note     text,
  added_at timestamptz not null default now()
);

comment on table public.admin_users is
  'Accounts allowed to write fleet data. Rows are added by the project owner in the SQL editor; there is no self-service path.';

-- True when the calling JWT belongs to a listed admin. SECURITY DEFINER so
-- the check works even though admin_users itself is not readable by clients.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------

create or replace function public.nz_text(j jsonb, key text)
returns text language sql immutable as $$
  select nullif(btrim(j ->> key), '');
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Raise a clean, client-friendly error. All admin-facing validation uses
-- SQLSTATE P0001 with a readable message; the UI shows it verbatim.
create or replace function public.assert_admin()
returns void language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'You are not authorised to change fleet records.' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Integrity rules
-- ---------------------------------------------------------------------

-- Non-negative odometers, enforced at the column level.
do $$ begin
  alter table public.buses add constraint buses_current_mileage_nonneg check (current_mileage >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.mileage_log add constraint mileage_log_mileage_nonneg check (mileage >= 0);
exception when duplicate_object then null; end $$;

-- Bus numbers are unique regardless of case or stray whitespace ("101 " and
-- "101" are the same bus). The plain UNIQUE constraint stays as well.
create unique index if not exists buses_bus_number_ci_uidx
  on public.buses (lower(btrim(bus_number)));

-- One active schedule per (bus, item). Inactive historical rows may repeat.
create unique index if not exists bus_maintenance_schedules_active_uidx
  on public.bus_maintenance_schedules (bus_id, maintenance_item_id) where is_active;

-- Normalise identifiers and protect the odometer on the buses table itself.
-- To deliberately roll an odometer back (typo correction) run, in one
-- transaction:  set local app.allow_mileage_rollback = 'on'; update ...
create or replace function public.buses_before_write()
returns trigger language plpgsql as $$
begin
  new.bus_number := btrim(new.bus_number);
  if new.bus_number = '' then
    raise exception 'Bus number is required.';
  end if;
  if new.vin is not null then
    new.vin := nullif(upper(btrim(new.vin)), '');
  end if;
  if new.license_plate is not null then
    new.license_plate := nullif(upper(btrim(new.license_plate)), '');
  end if;
  if tg_op = 'UPDATE'
     and new.current_mileage < old.current_mileage
     and coalesce(current_setting('app.allow_mileage_rollback', true), 'off') <> 'on' then
    raise exception 'Odometer cannot decrease (bus % is at % mi, attempted % mi).',
      old.bus_number, old.current_mileage, new.current_mileage;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists buses_before_write on public.buses;
create trigger buses_before_write
  before insert or update on public.buses
  for each row execute function public.buses_before_write();

drop trigger if exists maintenance_items_set_updated_at on public.maintenance_items;
create trigger maintenance_items_set_updated_at
  before update on public.maintenance_items
  for each row execute function public.set_updated_at();

drop trigger if exists bus_maintenance_schedules_set_updated_at on public.bus_maintenance_schedules;
create trigger bus_maintenance_schedules_set_updated_at
  before update on public.bus_maintenance_schedules
  for each row execute function public.set_updated_at();

-- A mileage reading must fit chronologically between its neighbours: not
-- lower than any earlier reading and not higher than any later one. The
-- newest reading also may not fall below the bus's current odometer.
create or replace function public.mileage_log_before_insert()
returns trigger language plpgsql as $$
declare
  v_prev integer;
  v_next integer;
  v_current integer;
  v_bus_number text;
begin
  select current_mileage, bus_number into v_current, v_bus_number
    from public.buses where id = new.bus_id;
  if not found then
    raise exception 'Unknown bus.';
  end if;

  select max(mileage) into v_prev from public.mileage_log
    where bus_id = new.bus_id and date_recorded <= new.date_recorded;
  select min(mileage) into v_next from public.mileage_log
    where bus_id = new.bus_id and date_recorded > new.date_recorded;

  if v_prev is not null and new.mileage < v_prev then
    raise exception 'Odometer cannot decrease: bus % already had a reading of % mi on or before that date.',
      v_bus_number, v_prev;
  end if;
  if v_next is not null and new.mileage > v_next then
    raise exception 'Reading conflicts with a later entry: bus % was at % mi after that date.',
      v_bus_number, v_next;
  end if;
  if v_next is null and new.mileage < v_current then
    raise exception 'Odometer cannot decrease: bus % is currently at % mi.',
      v_bus_number, v_current;
  end if;
  return new;
end;
$$;

drop trigger if exists mileage_log_before_insert on public.mileage_log;
create trigger mileage_log_before_insert
  before insert on public.mileage_log
  for each row execute function public.mileage_log_before_insert();

-- Roll the newest reading forward onto the bus record.
create or replace function public.mileage_log_after_insert()
returns trigger language plpgsql as $$
begin
  update public.buses
     set current_mileage = greatest(current_mileage, new.mileage),
         engine_hours = case
           when new.engine_hours is null then engine_hours
           else greatest(coalesce(engine_hours, 0), new.engine_hours)
         end
   where id = new.bus_id;
  return new;
end;
$$;

drop trigger if exists mileage_log_after_insert on public.mileage_log;
create trigger mileage_log_after_insert
  after insert on public.mileage_log
  for each row execute function public.mileage_log_after_insert();

-- ---------------------------------------------------------------------
-- 4. Row Level Security
--    anon / authenticated : read everything the dashboards show
--    listed admins        : insert / update (delete only where noted)
-- ---------------------------------------------------------------------

do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'buses', 'maintenance_items', 'bus_maintenance_schedules', 'maintenance_logs',
    'mileage_log', 'defect_reports', 'app_settings', 'admin_users'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- Public read access for the dashboards.
create policy "public read" on public.buses                     for select to anon, authenticated using (true);
create policy "public read" on public.maintenance_items         for select to anon, authenticated using (true);
create policy "public read" on public.bus_maintenance_schedules for select to anon, authenticated using (true);
create policy "public read" on public.maintenance_logs          for select to anon, authenticated using (true);
create policy "public read" on public.mileage_log               for select to anon, authenticated using (true);
create policy "public read" on public.defect_reports            for select to anon, authenticated using (true);
create policy "public read" on public.app_settings              for select to anon, authenticated using (true);

-- Admin writes. Buses, templates and maintenance history are never hard
-- deleted from the app (retire a bus, deactivate a template instead).
create policy "admin insert" on public.buses for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.buses for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin insert" on public.maintenance_items for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.maintenance_items for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin insert" on public.bus_maintenance_schedules for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.bus_maintenance_schedules for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin delete" on public.bus_maintenance_schedules for delete to authenticated using (public.is_admin());

create policy "admin insert" on public.maintenance_logs for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.maintenance_logs for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin insert" on public.mileage_log for insert to authenticated with check (public.is_admin());
create policy "admin delete" on public.mileage_log for delete to authenticated using (public.is_admin());

create policy "admin insert" on public.defect_reports for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.defect_reports for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin delete" on public.defect_reports for delete to authenticated using (public.is_admin());

create policy "admin update" on public.app_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin insert" on public.app_settings for insert to authenticated with check (public.is_admin());

-- Users may see their own admin row (handy for debugging); nothing else.
create policy "self read" on public.admin_users for select to authenticated using (user_id = auth.uid());

-- Table privileges: belt and braces on top of RLS. anon can only ever read.
grant usage on schema public to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
grant select on public.buses, public.maintenance_items, public.bus_maintenance_schedules,
  public.maintenance_logs, public.mileage_log, public.defect_reports, public.app_settings
  to anon, authenticated;
grant insert, update on public.buses, public.maintenance_items, public.maintenance_logs, public.app_settings to authenticated;
grant insert, update, delete on public.bus_maintenance_schedules, public.defect_reports to authenticated;
grant insert, delete on public.mileage_log to authenticated;
grant select on public.admin_users to authenticated;

-- ---------------------------------------------------------------------
-- 5. RPCs used by the Admin page
--    All SECURITY INVOKER: RLS still applies, and assert_admin() gives a
--    readable error before any work is attempted.
-- ---------------------------------------------------------------------

-- Shared by the wizard (new bus) and "Assign templates" (existing bus).
-- Each element of p_schedules:
--   { maintenance_item_id, custom_interval_days?, custom_interval_miles?,
--     custom_interval_engine_hours?, last_completed_date?,
--     last_completed_mileage?, last_completed_engine_hours?,
--     next_due_date?, next_due_mileage?, next_due_engine_hours?, notes? }
-- Missing next_due_* values are calculated: one interval after the last
-- completion, or after the anchor (start date / current odometer) when the
-- work has never been done.
create or replace function public.assign_schedules_internal(
  p_bus_id uuid,
  p_anchor_date date,
  p_schedules jsonb
)
returns setof public.bus_maintenance_schedules
language plpgsql
security invoker
set search_path = ''
as $$
declare
  s jsonb;
  item public.maintenance_items%rowtype;
  bus public.buses%rowtype;
  v_interval_days integer;
  v_interval_miles integer;
  v_interval_hours numeric;
  v_last_date date;
  v_last_miles integer;
  v_last_hours numeric;
  v_next_date date;
  v_next_miles integer;
  v_next_hours numeric;
  v_existing uuid;
  v_row public.bus_maintenance_schedules%rowtype;
begin
  select * into bus from public.buses where id = p_bus_id;
  if not found then
    raise exception 'Unknown bus.';
  end if;
  if p_schedules is null or jsonb_typeof(p_schedules) <> 'array' then
    return;
  end if;

  for s in select * from jsonb_array_elements(p_schedules) loop
    select * into item from public.maintenance_items
      where id = (s ->> 'maintenance_item_id')::uuid;
    if not found then
      raise exception 'Unknown maintenance template %.', s ->> 'maintenance_item_id';
    end if;
    if not item.is_active then
      raise exception 'Template "%" is inactive and cannot be assigned.', item.name;
    end if;

    v_interval_days  := coalesce((public.nz_text(s, 'custom_interval_days'))::integer, item.default_interval_days);
    v_interval_miles := coalesce((public.nz_text(s, 'custom_interval_miles'))::integer, item.default_interval_miles);
    v_interval_hours := coalesce((public.nz_text(s, 'custom_interval_engine_hours'))::numeric, item.default_interval_engine_hours);
    if v_interval_days is null and v_interval_miles is null and v_interval_hours is null then
      raise exception 'Template "%" has no interval; set a custom interval before assigning it.', item.name;
    end if;

    v_last_date  := (public.nz_text(s, 'last_completed_date'))::date;
    v_last_miles := (public.nz_text(s, 'last_completed_mileage'))::integer;
    v_last_hours := (public.nz_text(s, 'last_completed_engine_hours'))::numeric;
    if v_last_date is not null and v_last_date > current_date then
      raise exception '"%": last completed date cannot be in the future.', item.name;
    end if;
    if v_last_miles is not null and v_last_miles > bus.current_mileage then
      raise exception '"%": last completed mileage (%) is above the bus odometer (%).', item.name, v_last_miles, bus.current_mileage;
    end if;

    v_next_date := coalesce(
      (public.nz_text(s, 'next_due_date'))::date,
      case when v_interval_days is null then null
           else coalesce(v_last_date, p_anchor_date, current_date) + v_interval_days end);
    v_next_miles := coalesce(
      (public.nz_text(s, 'next_due_mileage'))::integer,
      case when v_interval_miles is null then null
           else coalesce(v_last_miles, bus.current_mileage) + v_interval_miles end);
    v_next_hours := coalesce(
      (public.nz_text(s, 'next_due_engine_hours'))::numeric,
      case when v_interval_hours is null or coalesce(v_last_hours, bus.engine_hours) is null then null
           else coalesce(v_last_hours, bus.engine_hours) + v_interval_hours end);

    select id into v_existing from public.bus_maintenance_schedules
      where bus_id = p_bus_id and maintenance_item_id = item.id and is_active;

    if v_existing is null then
      insert into public.bus_maintenance_schedules (
        bus_id, maintenance_item_id,
        custom_interval_days, custom_interval_miles, custom_interval_engine_hours,
        last_completed_date, last_completed_mileage, last_completed_engine_hours,
        next_due_date, next_due_mileage, next_due_engine_hours, is_active, notes
      ) values (
        p_bus_id, item.id,
        (public.nz_text(s, 'custom_interval_days'))::integer,
        (public.nz_text(s, 'custom_interval_miles'))::integer,
        (public.nz_text(s, 'custom_interval_engine_hours'))::numeric,
        v_last_date, v_last_miles, v_last_hours,
        v_next_date, v_next_miles, v_next_hours, true, public.nz_text(s, 'notes')
      ) returning * into v_row;
    else
      update public.bus_maintenance_schedules set
        custom_interval_days = (public.nz_text(s, 'custom_interval_days'))::integer,
        custom_interval_miles = (public.nz_text(s, 'custom_interval_miles'))::integer,
        custom_interval_engine_hours = (public.nz_text(s, 'custom_interval_engine_hours'))::numeric,
        last_completed_date = v_last_date,
        last_completed_mileage = v_last_miles,
        last_completed_engine_hours = v_last_hours,
        next_due_date = v_next_date,
        next_due_mileage = v_next_miles,
        next_due_engine_hours = v_next_hours,
        notes = coalesce(public.nz_text(s, 'notes'), notes),
        updated_at = now()
      where id = v_existing
      returning * into v_row;
    end if;
    return next v_row;
  end loop;
end;
$$;

-- SECURITY INVOKER: callers still need to pass RLS to insert anything, so
-- granting execute to authenticated leaks no capability. It is "internal"
-- only in that it skips the friendly assert_admin() message.
revoke all on function public.assign_schedules_internal(uuid, date, jsonb) from public, anon;
grant execute on function public.assign_schedules_internal(uuid, date, jsonb) to authenticated, service_role;

-- The wizard's final step: bus + first odometer reading + schedules in one
-- transaction. Returns { bus: {...}, schedules: n }.
-- p_bus keys: bus_number*, nickname, vin, year, make, model, license_plate,
--   license_plate_expiration, current_mileage*, engine_hours, date_acquired,
--   status, dot_inspection_due_date, insurance_expiration_date,
--   registration_expiration_date, notes
-- p_mileage keys: date_recorded (ISO timestamp or date), notes
create or replace function public.create_bus_with_schedules(
  p_bus jsonb,
  p_mileage jsonb default '{}'::jsonb,
  p_schedules jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bus public.buses%rowtype;
  v_number text := public.nz_text(p_bus, 'bus_number');
  v_mileage integer;
  v_recorded timestamptz;
  v_count integer := 0;
begin
  perform public.assert_admin();

  if v_number is null then
    raise exception 'Bus number is required.';
  end if;
  if exists (select 1 from public.buses where lower(btrim(bus_number)) = lower(v_number)) then
    raise exception 'Bus % already exists.', v_number;
  end if;

  v_mileage := coalesce((public.nz_text(p_bus, 'current_mileage'))::integer, 0);
  if v_mileage < 0 then
    raise exception 'Starting mileage cannot be negative.';
  end if;

  v_recorded := coalesce((public.nz_text(p_mileage, 'date_recorded'))::timestamptz, now());
  if v_recorded > now() + interval '1 day' then
    raise exception 'The odometer reading date cannot be in the future.';
  end if;

  insert into public.buses (
    bus_number, nickname, vin, year, make, model, license_plate, license_plate_expiration,
    current_mileage, engine_hours, date_acquired, status,
    dot_inspection_due_date, insurance_expiration_date, registration_expiration_date, notes
  ) values (
    v_number,
    public.nz_text(p_bus, 'nickname'),
    public.nz_text(p_bus, 'vin'),
    (public.nz_text(p_bus, 'year'))::integer,
    public.nz_text(p_bus, 'make'),
    public.nz_text(p_bus, 'model'),
    public.nz_text(p_bus, 'license_plate'),
    (public.nz_text(p_bus, 'license_plate_expiration'))::date,
    v_mileage,
    (public.nz_text(p_bus, 'engine_hours'))::numeric,
    (public.nz_text(p_bus, 'date_acquired'))::date,
    coalesce((public.nz_text(p_bus, 'status'))::public.bus_status, 'ACTIVE'),
    (public.nz_text(p_bus, 'dot_inspection_due_date'))::date,
    (public.nz_text(p_bus, 'insurance_expiration_date'))::date,
    (public.nz_text(p_bus, 'registration_expiration_date'))::date,
    public.nz_text(p_bus, 'notes')
  ) returning * into v_bus;

  insert into public.mileage_log (bus_id, mileage, engine_hours, date_recorded, source, notes)
  values (v_bus.id, v_mileage, v_bus.engine_hours, v_recorded, 'MANUAL',
          coalesce(public.nz_text(p_mileage, 'notes'), 'Starting odometer when added to fleet'));

  select count(*) into v_count
    from public.assign_schedules_internal(v_bus.id, v_recorded::date, p_schedules);

  select * into v_bus from public.buses where id = v_bus.id;
  return jsonb_build_object('bus', to_jsonb(v_bus), 'schedules', v_count);
end;
$$;

-- Assign or re-baseline templates on an existing bus.
create or replace function public.assign_schedules(p_bus_id uuid, p_schedules jsonb)
returns setof public.bus_maintenance_schedules
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query select * from public.assign_schedules_internal(p_bus_id, current_date, p_schedules);
end;
$$;

-- Record an odometer reading. Validation and roll-forward happen in the
-- mileage_log triggers; returns the updated bus.
create or replace function public.record_mileage(
  p_bus_id uuid,
  p_mileage integer,
  p_engine_hours numeric default null,
  p_date_recorded timestamptz default now(),
  p_notes text default null
)
returns public.buses
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bus public.buses%rowtype;
begin
  perform public.assert_admin();
  if p_mileage is null or p_mileage < 0 then
    raise exception 'Enter a valid odometer reading.';
  end if;
  if p_date_recorded > now() + interval '1 day' then
    raise exception 'The reading date cannot be in the future.';
  end if;
  insert into public.mileage_log (bus_id, mileage, engine_hours, date_recorded, source, notes)
  values (p_bus_id, p_mileage, p_engine_hours, coalesce(p_date_recorded, now()), 'MANUAL', nullif(btrim(p_notes), ''));
  select * into v_bus from public.buses where id = p_bus_id;
  return v_bus;
end;
$$;

-- Log completed work. If the work matches an active schedule (by id, or by
-- bus + template), the schedule's last/next values roll forward one interval,
-- and a higher service mileage becomes a new odometer reading.
-- p_log keys: bus_id*, maintenance_item_id, bus_maintenance_schedule_id,
--   date_performed*, mileage_at_service, engine_hours_at_service,
--   performed_by, vendor, work_order_number, cost, parts_cost, labor_cost,
--   description, notes
create or replace function public.log_maintenance(p_log jsonb)
returns public.maintenance_logs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bus public.buses%rowtype;
  v_sched public.bus_maintenance_schedules%rowtype;
  v_item public.maintenance_items%rowtype;
  v_log public.maintenance_logs%rowtype;
  v_date date := coalesce((public.nz_text(p_log, 'date_performed'))::date, current_date);
  v_miles integer := (public.nz_text(p_log, 'mileage_at_service'))::integer;
  v_hours numeric := (public.nz_text(p_log, 'engine_hours_at_service'))::numeric;
  v_parts numeric := (public.nz_text(p_log, 'parts_cost'))::numeric;
  v_labor numeric := (public.nz_text(p_log, 'labor_cost'))::numeric;
  v_cost numeric := (public.nz_text(p_log, 'cost'))::numeric;
  v_interval_days integer;
  v_interval_miles integer;
  v_interval_hours numeric;
  v_next_date date;
  v_next_miles integer;
  v_next_hours numeric;
  v_reading_at timestamptz;
begin
  perform public.assert_admin();

  select * into v_bus from public.buses where id = (p_log ->> 'bus_id')::uuid;
  if not found then
    raise exception 'Choose a bus.';
  end if;
  if v_date > current_date then
    raise exception 'Service date cannot be in the future.';
  end if;
  if v_miles is not null and v_miles < 0 then
    raise exception 'Mileage at service must be zero or more.';
  end if;
  if v_cost is null and (v_parts is not null or v_labor is not null) then
    v_cost := coalesce(v_parts, 0) + coalesce(v_labor, 0);
  end if;

  if public.nz_text(p_log, 'bus_maintenance_schedule_id') is not null then
    select * into v_sched from public.bus_maintenance_schedules
      where id = (p_log ->> 'bus_maintenance_schedule_id')::uuid and bus_id = v_bus.id;
  elsif public.nz_text(p_log, 'maintenance_item_id') is not null then
    select * into v_sched from public.bus_maintenance_schedules
      where bus_id = v_bus.id and maintenance_item_id = (p_log ->> 'maintenance_item_id')::uuid and is_active
      limit 1;
  end if;

  if v_sched.id is not null then
    select * into v_item from public.maintenance_items where id = v_sched.maintenance_item_id;
    v_interval_days  := coalesce(v_sched.custom_interval_days, v_item.default_interval_days);
    v_interval_miles := coalesce(v_sched.custom_interval_miles, v_item.default_interval_miles);
    v_interval_hours := coalesce(v_sched.custom_interval_engine_hours, v_item.default_interval_engine_hours);
    v_next_date  := case when v_interval_days is null then null else v_date + v_interval_days end;
    v_next_miles := case when v_interval_miles is null or coalesce(v_miles, v_bus.current_mileage) is null then null
                         else coalesce(v_miles, v_bus.current_mileage) + v_interval_miles end;
    v_next_hours := case when v_interval_hours is null or coalesce(v_hours, v_bus.engine_hours) is null then null
                         else coalesce(v_hours, v_bus.engine_hours) + v_interval_hours end;
  end if;

  insert into public.maintenance_logs (
    bus_id, maintenance_item_id, bus_maintenance_schedule_id, date_performed,
    mileage_at_service, engine_hours_at_service, performed_by, cost, parts_cost, labor_cost,
    vendor, work_order_number, description, next_due_date, next_due_mileage, notes
  ) values (
    v_bus.id,
    coalesce(v_sched.maintenance_item_id, (public.nz_text(p_log, 'maintenance_item_id'))::uuid),
    v_sched.id, v_date, v_miles, v_hours,
    public.nz_text(p_log, 'performed_by'), v_cost, v_parts, v_labor,
    public.nz_text(p_log, 'vendor'), public.nz_text(p_log, 'work_order_number'),
    public.nz_text(p_log, 'description'), v_next_date, v_next_miles, public.nz_text(p_log, 'notes')
  ) returning * into v_log;

  if v_sched.id is not null then
    update public.bus_maintenance_schedules set
      last_completed_date = v_date,
      last_completed_mileage = coalesce(v_miles, last_completed_mileage),
      last_completed_engine_hours = coalesce(v_hours, last_completed_engine_hours),
      next_due_date = v_next_date,
      next_due_mileage = v_next_miles,
      next_due_engine_hours = v_next_hours,
      updated_at = now()
    where id = v_sched.id;
  end if;

  -- A higher service mileage becomes a new odometer reading, but only when it
  -- fits the timeline: if a later reading already exists the log row still
  -- keeps mileage_at_service and the odometer is left alone. Work logged for
  -- today/yesterday is stamped "now" so it lands after this morning's reading.
  v_reading_at := case when v_date >= current_date - 1 then now()
                       else v_date::timestamptz + interval '12 hours' end;
  if v_miles is not null and v_miles > v_bus.current_mileage
     and not exists (select 1 from public.mileage_log where bus_id = v_bus.id and date_recorded > v_reading_at) then
    insert into public.mileage_log (bus_id, mileage, engine_hours, date_recorded, source, notes)
    values (v_bus.id, v_miles, v_hours, v_reading_at, 'MANUAL',
            'Recorded with maintenance log ' || coalesce(v_log.work_order_number, v_log.id::text));
  end if;

  return v_log;
end;
$$;

revoke all on function public.create_bus_with_schedules(jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.assign_schedules(uuid, jsonb) from public, anon;
revoke all on function public.record_mileage(uuid, integer, numeric, timestamptz, text) from public, anon;
revoke all on function public.log_maintenance(jsonb) from public, anon;
grant execute on function public.create_bus_with_schedules(jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.assign_schedules(uuid, jsonb) to authenticated, service_role;
grant execute on function public.record_mileage(uuid, integer, numeric, timestamptz, text) to authenticated, service_role;
grant execute on function public.log_maintenance(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Realtime: let the wall dashboards refresh the moment data changes.
--    Silently skipped where the publication does not exist (local tests).
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['buses', 'bus_maintenance_schedules', 'maintenance_logs', 'mileage_log', 'defect_reports'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
