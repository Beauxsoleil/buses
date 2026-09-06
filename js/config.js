// Central configuration. Everything in this file is safe to ship in a public
// static site: the anon key only grants what Row Level Security allows, which
// is read-only access for anonymous visitors (see supabase/migrations).

export const SUPABASE_URL = 'https://qshrulbcfchmrwffgbes.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzaHJ1bGJjZmNobXJ3ZmZnYmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MzkzMTQsImV4cCI6MjEwNDIxNTMxNH0.zMRrDTszdUKuRozNBFYnK3DcJebz81oH_igZU2vqlx4';

export const APP_NAME = 'Fleet Maintenance Tracker';

// Defaults that the `app_settings` table can override at runtime.
export const DEFAULT_SETTINGS = {
  timezone: 'America/Denver',
  dashboard_auto_refresh_seconds: 60,
  dashboard_auto_rotate_seconds: 30,
  upcoming_threshold_days: 7,
  upcoming_threshold_miles: 500,
  compliance_warning_days: [30, 60, 90],
  stale_mileage_alert_days: 14,
};

// Admin sessions on a shared shop computer are signed out after this much
// idle time.
export const ADMIN_IDLE_MINUTES = 30;

// Dashboard pages in rotation order. Arrow keys, swipes and kiosk mode move
// through this list; Admin and the per-bus page are deliberately excluded.
export const DASHBOARD_PAGES = [
  { href: 'index.html', label: 'Fleet Overview' },
  { href: 'today.html', label: 'Today' },
  { href: '30day.html', label: '30-Day' },
  { href: '60day.html', label: '60-Day' },
  { href: '90day.html', label: '90-Day' },
  { href: 'compliance.html', label: 'Compliance' },
  { href: 'costs.html', label: 'Costs' },
  { href: 'history.html', label: 'History' },
];

export const ADMIN_PAGE = { href: 'admin.html', label: 'Admin' };

// Enumerations mirrored from the database (see supabase/schema.sql).
export const BUS_STATUSES = ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED', 'SOLD'];
export const MAINTENANCE_CATEGORIES = [
  'ENGINE', 'BRAKES', 'TIRES', 'ELECTRICAL', 'DRIVETRAIN', 'FLUIDS', 'EXHAUST',
  'HVAC', 'SAFETY_EQUIPMENT', 'BODY_EXTERIOR', 'COMPLIANCE', 'OTHER',
];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const DEFECT_SEVERITIES = ['MINOR', 'MAJOR', 'SAFETY_CRITICAL'];
export const DEFECT_STATUSES = ['REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DEFERRED', 'RESOLVED'];
export const OPEN_DEFECT_STATUSES = ['REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS'];

// Bus-level document deadlines shown on the Compliance page and bus detail.
export const COMPLIANCE_FIELDS = [
  ['dot_inspection_due_date', 'DOT annual inspection'],
  ['insurance_expiration_date', 'Insurance'],
  ['registration_expiration_date', 'Registration'],
  ['license_plate_expiration', 'License plate'],
];
