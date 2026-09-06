-- Starter maintenance templates. These match the templates in the production
-- project, so a fresh Supabase project gets the same catalogue the Add Bus
-- wizard offers. Safe to re-run: matches on the unique name and only fills
-- in rows that are missing.

insert into public.maintenance_items
  (name, category, default_interval_miles, default_interval_days, is_regulatory, priority, description)
values
  ('Air Filter Replacement',          'ENGINE',           15000, 365, false, 'MEDIUM',   null),
  ('Annual DOT Inspection',           'COMPLIANCE',       null,  365, true,  'CRITICAL', 'Annual federal/state commercial vehicle inspection.'),
  ('Battery Check',                   'ELECTRICAL',       10000, 90,  false, 'MEDIUM',   null),
  ('Belt Inspection',                 'ENGINE',           20000, 180, false, 'MEDIUM',   null),
  ('Brake Inspection',                'BRAKES',           10000, 90,  true,  'CRITICAL', null),
  ('Coolant System Inspection',       'ENGINE',           15000, 180, false, 'MEDIUM',   null),
  ('DEF Fluid Check',                 'FLUIDS',           5000,  30,  false, 'HIGH',     null),
  ('Differential Fluid Change',       'DRIVETRAIN',       30000, 365, false, 'MEDIUM',   null),
  ('Emergency Exit Inspection',       'SAFETY_EQUIPMENT', null,  90,  true,  'CRITICAL', null),
  ('Engine Oil & Filter Change',      'ENGINE',           5000,  90,  false, 'HIGH',     null),
  ('Exhaust System Inspection',       'EXHAUST',          15000, 180, true,  'HIGH',     null),
  ('Fire Extinguisher Inspection',    'SAFETY_EQUIPMENT', null,  180, true,  'CRITICAL', null),
  ('Fuel Filter Replacement',         'ENGINE',           15000, 365, false, 'MEDIUM',   null),
  ('HVAC System Check',               'HVAC',             null,  180, false, 'LOW',      null),
  ('Lights & Signals Check',          'ELECTRICAL',       null,  30,  true,  'HIGH',     null),
  ('Steering & Suspension Check',     'DRIVETRAIN',       15000, 180, false, 'HIGH',     null),
  ('Tire Inspection & Rotation',      'TIRES',            7500,  90,  false, 'HIGH',     null),
  ('Transmission Fluid Check',        'DRIVETRAIN',       15000, 180, false, 'HIGH',     null),
  ('Wheelchair Lift/Ramp Inspection', 'SAFETY_EQUIPMENT', null,  90,  true,  'CRITICAL', null),
  ('Windshield Wiper Replacement',    'BODY_EXTERIOR',    null,  180, false, 'LOW',      null)
on conflict (name) do nothing;
