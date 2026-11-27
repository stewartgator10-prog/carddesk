// Tiny in-memory stand-in for the parts of supabase-js the functions use.
export function fakeDb(tables, keys, { files = {} } = {}) {
  const t = (name) => (tables[name] ||= []);
  return {
    tables,
    files,
    storage: {
      from: () => ({
        download: async (path) => (files[path]
          ? { data: new Blob([files[path]], { type: 'image/jpeg' }), error: null }
          : { data: null, error: { message: 'Object not found' } }),
        upload: async (path, body, opts = {}) => {
          if (files[path] && !opts.upsert) return { data: null, error: { message: 'The resource already exists' } };
          files[path] = Buffer.from(body); return { data: { path }, error: null };
        },
        remove: async (paths) => { paths.forEach((p) => delete files[p]); return { data: paths, error: null }; },
      }),
    },
    from(name) {
      const filters = []; let op = 'select', payload = null, single = false, conflict = null, returning = false;
      const b = {
        select() { if (op !== 'select') returning = true; return b; },
        eq(c, v) { filters.push((r) => r[c] === v); return b; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
        is(c, v) { filters.push((r) => r[c] === v); return b; },
        not(c, op, v) { filters.push((r) => (op === 'is' && v === null ? r[c] != null : r[c] !== v)); return b; },
        gte(c, v) { filters.push((r) => r[c] >= v); return b; },
        ilike(c, pat) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i'); filters.push((r) => re.test(r[c] ?? '')); return b; },
        insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
        delete() { op = 'delete'; return b; },
        order() { return b; }, limit() { return b; },
        maybeSingle() { single = true; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        upsert(rows, o) { op = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; conflict = o.onConflict.split(','); return b; },
        then(res, rej) {
          try {
            const rows = t(name);
            if (op === 'select') {
              const out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
              return Promise.resolve({ data: single ? out[0] || null : out, error: null }).then(res, rej);
            }
            if (op === 'update') {
              const hit = rows.filter((r) => filters.every((f) => f(r)));
              hit.forEach((r) => Object.assign(r, payload));
              return Promise.resolve({ data: returning ? hit.map((r) => ({ ...r })) : null, error: null }).then(res, rej);
            }
            if (op === 'delete') {
              const keep = rows.filter((r) => !filters.every((f) => f(r)));
              rows.splice(0, rows.length, ...keep);
              return Promise.resolve({ data: null, error: null }).then(res, rej);
            }
            if (op === 'insert') {
              rows.push(...payload.map((p) => ({ ...p })));
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
