/**
 * A tiny in-memory stand-in for the Supabase query builder, just rich enough for the order / email services.
 * Tests only: it lets the real service code run without touching the live database.
 */
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export const createFakeDb = (seed = {}, { uniques = {} } = {}) => {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ id: uuid(), ...r }));
  const table = (name) => (tables[name] ||= []);

  const query = (name) => {
    const state = { op: 'select', filters: [], patch: null, rows: null, limit: null, head: false, count: false, single: false, maybe: false };
    const matches = (row) => state.filters.every((f) => f(row));
    const api = {
      select(_cols, opts = {}) {
        state.selecting = true;
        if (opts.count) state.count = true;
        if (opts.head) state.head = true;
        return api;
      },
      insert(rows) { state.op = 'insert'; state.rows = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, opts = {}) { state.op = 'upsert'; state.rows = Array.isArray(rows) ? rows : [rows]; state.conflict = opts.onConflict || 'key'; return api; },
      update(patch) { state.op = 'update'; state.patch = patch; return api; },
      delete() { state.op = 'delete'; return api; },
      eq(c, v) { state.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { state.filters.push((r) => r[c] !== v); return api; },
      in(c, vs) { state.filters.push((r) => vs.includes(r[c])); return api; },
      is(c, v) { state.filters.push((r) => (r[c] ?? null) === v); return api; },
      not(c, op, v) { if (op === 'is') state.filters.push((r) => (r[c] ?? null) !== v); return api; },
      ilike(c, v) { const re = new RegExp(`^${String(v).replace(/\\([\\%_])/g, '$1').replace(/[.*+?^${}()|[\]]/g, '\\$&')}$`, 'i'); state.filters.push((r) => re.test(String(r[c] ?? ''))); return api; },
      gte(c, v) { state.filters.push((r) => r[c] !== undefined && r[c] !== null && String(r[c]) >= String(v)); return api; },
      lt(c, v) { state.filters.push((r) => r[c] !== undefined && r[c] !== null && String(r[c]) < String(v)); return api; },
      // simple "col.is.null,col.neq.X" lists are applied; anything with and(...) / not(...) stays a no-op as before
      or(expr) {
        const terms = String(expr || '').split(',');
        if (terms.length && terms.every((t) => /^[a-z_]+\.(is|eq|neq)\.[^.(),]+$/i.test(t))) {
          const fns = terms.map((t) => {
            const [c, op, v] = t.split('.');
            return (r) => (op === 'is' ? (r[c] ?? null) === (v === 'null' ? null : v) : op === 'neq' ? r[c] !== v : r[c] === v);
          });
          state.filters.push((r) => fns.some((f) => f(r)));
        }
        return api;
      },
      order() { return api; },
      range() { return api; },
      filter(c, op, v) { state.filters.push((r) => (op === 'is' ? (r[c] ?? null) === v : r[c] === v)); return api; },
      limit(n) { state.limit = n; return api; },
      single() { state.single = true; return api; },
      maybeSingle() { state.maybe = true; return api; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };

    const run = () => {
      const rows = table(name);
      let out;
      if (state.op === 'insert') {
        const added = [];
        for (const r of state.rows) {
          const row = { id: uuid(), created_at: new Date().toISOString(), ...r };
          const u = uniques[name];
          if (u && u.when(row) && rows.some((o) => u.when(o) && u.key(o) === u.key(row))) return { data: null, error: { code: '23505', message: `duplicate key on ${name}` } };
          added.push(row);
        }
        rows.push(...added);
        out = added;
      } else if (state.op === 'upsert') {
        out = [];
        for (const r of state.rows) {
          const found = rows.find((o) => o[state.conflict] === r[state.conflict]);
          if (found) { Object.assign(found, r); out.push({ ...found }); } else { const row = { id: uuid(), created_at: new Date().toISOString(), ...r }; rows.push(row); out.push({ ...row }); }
        }
      } else if (state.op === 'update') {
        out = rows.filter(matches);
        out.forEach((r) => Object.assign(r, state.patch));
        out = out.map((r) => ({ ...r }));
      } else if (state.op === 'delete') {
        const gone = rows.filter(matches);
        tables[name] = rows.filter((r) => !gone.includes(r));
        out = gone;
      } else {
        out = rows.filter(matches).map((r) => ({ ...r }));
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      if (state.head) return { data: null, error: null, count: out.length };
      if (state.single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: 'PGRST116', message: `expected one row, got ${out.length}` } };
      if (state.maybe) return { data: out[0] ?? null, error: null };
      return { data: out, error: null, ...(state.count ? { count: out.length } : {}) };
    };
    return api;
  };

  return { from: query, rpc: async () => ({ data: null, error: null }), tables, table };
};
