# Bus Maintenance Tracker

A wall-display-friendly maintenance dashboard for a small school-bus fleet,
plus a sign-in-protected Admin page for keeping the records current.

* **Public, read-only dashboards** — Fleet Overview, Today, 30/60/90-day
  plans, Compliance, Costs & Analytics, Maintenance History and a per-bus
  detail page. No sign-in; built for a kiosk on the shop wall.
* **Protected Admin page** — an *Add Bus* wizard, odometer updates, work
  logging, defect reporting and template assignment. Only accounts on the
  `admin_users` allow-list can change anything; Row Level Security enforces
  that on the server, not just in the browser.
* **Zero build step** — plain HTML, CSS and ES modules on GitHub Pages,
  backed by Supabase (Postgres + Auth + PostgREST). Chart.js and supabase-js
  are vendored and pinned; the pages carry a Content Security Policy.

Live: <https://beauxsoleil.github.io/buses/>

---

## Contents

1. [Running it locally](#running-it-locally)
2. [Database setup](#database-setup)
3. [Creating the admin account](#creating-the-admin-account)
4. [Adding a bus](#adding-a-bus)
5. [How urgency is calculated](#how-urgency-is-calculated)
6. [Project layout](#project-layout)
7. [Tests](#tests)
8. [Kiosk mode and navigation](#kiosk-mode-and-navigation)
9. [Security model](#security-model)
10. [Updating vendored libraries](#updating-vendored-libraries)

---

## Running it locally

ES modules do not load from `file://`, so serve the folder:

```sh
npm start            # http://localhost:8080  (no dependencies; Node 20+)
# or: python3 -m http.server 8080
```

The site talks to the Supabase project configured in `js/config.js`
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`). The anon key is *meant* to be public;
what it can do is decided entirely by the Row Level Security policies in
`supabase/`.

## Database setup

Run these in the Supabase SQL editor, in order. Each script is idempotent and
safe to re-run.

| Step | File | What it does |
| --- | --- | --- |
| 1 | `supabase/schema.sql` | Enums, tables (`buses`, `maintenance_items`, `bus_maintenance_schedules`, `maintenance_logs`, `mileage_log`, `defect_reports`, `app_settings`), triggers that keep `buses.current_mileage` in step with `mileage_log`, and public read-only RLS. |
| 2 | `supabase/migrations/0001_admin_access.sql` | The `admin_users` allow-list, `is_admin()`, admin-only write policies, and the transactional RPCs the Admin page calls (`create_bus_with_schedules`, `assign_schedules`, `record_mileage`, `log_maintenance`). |
| 3 | `supabase/seed-maintenance-items.sql` | The standard maintenance templates (oil, brakes, DOT inspection, …). Inserts only names that do not exist yet, so your edits to existing templates are kept. |
| 4 | `supabase/grant-admin.sql` | Puts **your** account on the allow-list — see the next section. |
| — | `supabase/seed-history.sql` | *Optional.* Synthetic maintenance history for the five demonstration buses so the Costs and History pages have something to show. |

`app_settings` holds the fleet timezone (`America/Denver`), the dashboard
refresh/rotate intervals and the alert thresholds; edit those rows rather than
the code.

## Creating the admin account

The dashboards are public, but nothing can be written without an account that
is *both* signed in *and* listed in `public.admin_users`.

1. **Create the user.** Supabase Dashboard → *Authentication* → *Users* →
   *Add user*. Enter your e-mail and a strong password (or send yourself a
   magic link).
2. **Grant admin.** Open `supabase/grant-admin.sql`, replace
   `you@example.com` with that e-mail, and run it. The final `select` lists
   every current admin so you can confirm it took.
3. **Close the door.** *Authentication* → *Providers* → *Email* → turn
   **Allow new users to sign up** *off*. (Even if you skip this, a stranger
   who signs up gets a "not authorised" screen — the allow-list is what
   matters — but there is no reason to let them in at all.)
4. Open `admin.html`, sign in with the password or an e-mailed link.

The Admin page signs you out after 30 minutes of inactivity. To revoke access
later: `delete from public.admin_users where email = '…';`.

### Before the Admin page existed (the manual way)

Records can always be maintained directly in Supabase → *Table Editor*:
insert a row in `buses`, add its first reading to `mileage_log`, and add one
`bus_maintenance_schedules` row per applicable template with the
`next_due_date` / `next_due_mileage` you work out by hand. It works, but the
wizard does the same thing with validation, in a single transaction, and with
the due dates calculated for you.

## Adding a bus

*Admin → Add a bus* walks through four steps:

1. **Vehicle** — bus number (required, must be unique; the check is
   case- and whitespace-insensitive), nickname, year/make/model, VIN
   (17 characters, no I/O/Q), plate, status (`ACTIVE`, `OUT_OF_SERVICE`,
   `RETIRED`, `SOLD`), date acquired, notes, and the four compliance dates
   (DOT inspection, insurance, registration, plate).
2. **Odometer** — the starting reading (0 for a new vehicle), optional engine
   hours and the reading date. This becomes the first `mileage_log` entry.
3. **Templates** — tick the maintenance templates that apply. Regulatory,
   critical and high-priority templates are pre-selected. Each row accepts an
   optional custom interval and a "last done" date/mileage so the first due
   date is not too early.
4. **Review** — shows the projected first due date and mileage for every
   selected template (`last done + interval`, or `today/odometer + interval`
   when the work has never been recorded) and creates everything.

The final step is a single RPC, `create_bus_with_schedules`, so the bus, its
first odometer reading and all its schedules either all land or none do. The
database re-validates everything the browser checked (uniqueness, negative or
decreasing mileage, future dates, last-done mileage above the odometer), so a
modified client cannot slip bad data past it.

Afterwards the same page handles the day-to-day work: **Update mileage** (a
lower reading than the current one is rejected), **Log maintenance** (rolls
the matching schedule forward one interval from the service date/mileage),
**Report a defect**, **Open defects** (acknowledge → in progress → resolve /
defer), **Assign templates** to an existing bus, and **Edit bus details**.
Every bus detail page links straight into these forms for that bus.

## How urgency is calculated

`js/urgency.js` is the single source of truth; the SQL views and the tests
mirror it.

| Status | Rule |
| --- | --- |
| **overdue** | past `next_due_date`, or the odometer is over `next_due_mileage` (or engine hours over `next_due_engine_hours`). |
| **due-soon** | due today or within 7 days, **or** less than 25 % of the interval remains on any trigger (so a 10,000-mile brake interval turns amber with 2,500 miles left). |
| **upcoming** | within 30 days, or less than 75 % of the interval remains. |
| **ok** | everything else that has a trigger. |
| **unscheduled** | the schedule has no date, mileage or hours trigger — it will never warn. The Admin hub lists buses in this state. |

The Today page's "Due this week" bucket is strictly `daysRemaining ≤ 7`; items
that are due-soon only because of mileage appear under "Approaching by
mileage" instead.

A bus takes the worst status of its active schedules. Dashboards use active
schedules of **ACTIVE** buses; the Compliance page also includes
out-of-service buses so regulatory deadlines do not disappear while a bus is
in the shop. All dates are interpreted in the fleet timezone from
`app_settings`.

## Project layout

```
index.html, today.html, 30day/60day/90day.html,
compliance.html, costs.html, history.html, bus.html, admin.html
css/styles.css              one stylesheet, self-hosted fonts (fonts/)
js/config.js                Supabase project, nav pages, enums, defaults
js/api.js                   every Supabase call (reads, auth, admin RPCs)
js/urgency.js               due-date maths, projections, client validation
js/ui.js                    shared header/nav/clock, formatting, auto-refresh
js/charts.js                Chart.js theme + lifecycle
js/pages/<page>.js          one module per page
vendor/                     pinned chart.js + supabase-js (see VERSIONS)
supabase/                   schema, admin migration, seeds, grant script
tests/unit                  urgency rules           (node --test)
tests/pages                 every page in jsdom against fixtures
tests/sql                   schema + RLS + RPCs in embedded Postgres
scripts/serve.mjs           dependency-free dev server
scripts/check.mjs           static consistency checks
```

## Tests

```sh
npm run check         # syntax, imports, page references, vendor hashes
npm test              # urgency/validation unit tests
npm install --no-save jsdom embedded-postgres@18.4.0-beta.17 pg
npm run test:pages    # renders every page in jsdom against fixture data
npm run test:sql      # spins up a throw-away Postgres, applies supabase/*.sql,
                      # checks RLS (anon/non-admin/admin) and every RPC
npm run test:all
```

GitHub Actions runs all of them on every push and pull request
(`.github/workflows/ci.yml`).

## Kiosk mode and navigation

* Add `?kiosk` to any dashboard URL to rotate through the views every
  `dashboard_auto_rotate_seconds` (default 30). The manifest sets the start
  URL to kiosk mode for "Add to Home Screen" on a tablet.
* `←` / `→` and horizontal swipes step between dashboards (ignored inside form
  controls and the scrolling nav, and when the gesture is mostly vertical).
* Data refreshes every `dashboard_auto_refresh_seconds` and immediately when
  the tab regains focus. A failed refresh keeps the last good screen and
  marks the header **Offline/Stale**; only a first-load failure shows an
  error state.

## Security model

* `anon` (the dashboards): `select` on every table; no writes; cannot read
  `admin_users` or call the admin RPCs.
* `authenticated` but not in `admin_users`: exactly the same as `anon` — the
  Admin page shows a "not authorised" screen.
* Admins: `insert`/`update` everywhere, `delete` only on schedules, defects
  and mileage readings (no deleting buses or maintenance history). Business
  rules live in triggers and RPCs so they apply no matter which client makes
  the call.
* Pages ship a CSP (`script-src 'self'`, `connect-src` limited to the Supabase
  project) and no inline scripts; all rendered data is HTML-escaped.

## Updating vendored libraries

`vendor/VERSIONS` records the package version and SHA-256 of each bundle.
To upgrade, download the new file from the npm tarball
(`dist/chart.umd.min.js` or `dist/umd/supabase.js`), replace it, update the
hash, and run `npm run test:all`. `npm run check` fails if a hash drifts.
