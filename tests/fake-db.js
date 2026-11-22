// Tiny in-memory stand-in for the parts of supabase-js the functions use.
export function fakeDb(tables, keys) {
  const t = (name) => (tables[name] ||= []);
  return {
    tables,
    from(name) {
      const filters = []; let op = 'select', payload = null, single = false, conflict = null;
      const b = {
        select() { return b; },
        eq(c, v) { filters.push((r) => r[c] === v); return b; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
        is(c, v) { filters.push((r) => r[c] === v); return b; },
        gte(c, v) { filters.push((r) => r[c] >= v); return b; },
        order() { return b; }, limit() { return b; },
        maybeSingle() { single = true; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        upsert(rows, o) { op = 'upsert'; payload = rows; conflict = o.onConflict.split(','); return b; },
        then(res, rej) {
          try {
            const rows = t(name);
            if (op === 'select') {
              const out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
              return Promise.resolve({ data: single ? out[0] || null : out, error: null }).then(res, rej);
            }
            if (op === 'update') {
              rows.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, payload));
              return Promise.resolve({ data: null, error: null }).then(res, rej);
            }
            for (const p of payload) {
              const hit = rows.find((r) => conflict.every((k) => r[k] === p[k]));
              if (hit) Object.assign(hit, p); else rows.push({ match_status: 'unmatched', ...p });
            }
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          } catch (e) { return Promise.resolve({ data: null, error: e }).then(res, rej); }
        },
      };
      return b;
    },
  };
}
