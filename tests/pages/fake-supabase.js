// A tiny in-memory stand-in for the supabase-js client covering exactly the
// query surface js/api.js uses (select/eq/in/order/range/single, rpc, auth).
// Embedded relations (`bus:buses(*)`, `item:maintenance_items(*)`) are
// resolved from the fixture tables so pages see the same shapes as PostgREST.

import * as fx from './fixtures.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createFakeSupabase({ session = null, admin = false, failTables = new Set(), rpcHandlers = {} } = {}) {
  const tables = {
    buses: fx.buses,
    maintenance_items: fx.items,
    bus_maintenance_schedules: fx.schedules,
    defect_reports: fx.defects,
    maintenance_logs: fx.maintenanceLogs,
    mileage_log: fx.mileageLogs,
    app_settings: fx.settings,
  };
  const calls = [];

  const embed = (table, row) => {
    const out = { ...row };
    if (['bus_maintenance_schedules', 'defect_reports', 'maintenance_logs'].includes(table)) {
      out.bus = tables.buses.find((b) => b.id === row.bus_id) || null;
    }
    if (['bus_maintenance_schedules', 'maintenance_logs'].includes(table)) {
      out.item = tables.maintenance_items.find((i) => i.id === row.maintenance_item_id) || null;
    }
    return out;
  };

  function query(table) {
    const state = { table, filters: [], orders: [], range: null, mode: 'many', mutation: null };
    const q = {
      select() { return q; },
      eq(col, val) { state.filters.push((r) => r[col] === val); return q; },
      neq(col, val) { state.filters.push((r) => r[col] !== val); return q; },
      in(col, vals) { state.filters.push((r) => vals.includes(r[col])); return q; },
      gte(col, val) { state.filters.push((r) => r[col] >= val); return q; },
      lte(col, val) { state.filters.push((r) => r[col] <= val); return q; },
      order(col, { ascending = true } = {}) { state.orders.push([col, ascending]); return q; },
      range(from, to) { state.range = [from, to]; return q; },
      limit(n) { state.range = [0, n - 1]; return q; },
      single() { state.mode = 'single'; return q; },
      maybeSingle() { state.mode = 'maybe'; return q; },
      insert(payload) { state.mutation = ['insert', payload]; return q; },
      update(patch) { state.mutation = ['update', patch]; return q; },
      upsert(payload) { state.mutation = ['upsert', payload]; return q; },
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); },
    };
    function execute() {
      calls.push({ table, mutation: state.mutation?.[0] || 'select' });
      if (failTables.has(table)) return { data: null, error: { message: `simulated failure reading ${table}`, code: 'PGRST000' } };
      if (state.mutation) {
        if (!admin) return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
        const [kind, payload] = state.mutation;
        const row = kind === 'update' ? { ...(tables[table].find((r) => state.filters.every((f) => f(r))) || {}), ...payload } : { id: `new-${table}`, ...payload };
        return { data: state.mode === 'many' ? [row] : row, error: null };
      }
      let rows = clone(tables[table] || []).filter((r) => state.filters.every((f) => f(r)));
      for (const [col, asc] of [...state.orders].reverse()) {
        rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
      rows = rows.map((r) => embed(table, r));
      if (state.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      if (state.mode === 'maybe') return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    return q;
  }

  const listeners = new Set();
  const client = {
    calls,
    from: query,
    rpc: async (name, args) => {
      calls.push({ rpc: name, args });
      if (name === 'is_admin') return { data: admin, error: null };
      if (!admin) return { data: null, error: { message: 'not authorised', code: 'P0001' } };
      if (rpcHandlers[name]) return rpcHandlers[name](args);
      return { data: null, error: { message: `no fake handler for rpc ${name}`, code: '42883' } };
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      signInWithPassword: async () => ({ data: { session }, error: session ? null : { message: 'Invalid login credentials' } }),
      signInWithOtp: async () => ({ data: {}, error: null }),
      signOut: async () => { session = null; listeners.forEach((cb) => cb('SIGNED_OUT', null)); return { error: null }; },
    },
    _emitAuth(nextSession) { session = nextSession; listeners.forEach((cb) => cb('SIGNED_IN', nextSession)); },
  };
  return { createClient: () => client, client };
}
