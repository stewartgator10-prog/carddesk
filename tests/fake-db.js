import crypto from 'node:crypto';
// Tiny in-memory stand-in for the parts of supabase-js the functions use.
const AUTO_ID = ['marketplace_listings', 'marketplace_accounts'];   // tables whose id the database fills in
export function fakeDb(tables, keys, { files = {}, signedUrls = false, maxRows = 1000, unique = {}, failOn = null } = {}) {
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
        createSignedUrl: !signedUrls ? undefined : async (path, secs) => ({ data: { signedUrl: `https://storage.example/sign/${path}?expires=${secs}` }, error: null }),
      }),
    },
    from(name) {
      const filters = []; let op = 'select', payload = null, single = false, conflict = null, returning = false, ignoreDup = false, range = null;
      const b = {
        select() { if (op !== 'select') returning = true; return b; },
        eq(c, v) { filters.push((r) => r[c] === v); return b; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
        is(c, v) { filters.push((r) => (r[c] ?? null) === v); return b; },
        not(c, op, v) { filters.push((r) => (op === 'is' && v === null ? r[c] != null : r[c] !== v)); return b; },
        gte(c, v) { filters.push((r) => r[c] >= v); return b; },
        lt(c, v) { filters.push((r) => r[c] < v); return b; },
        neq(c, v) { filters.push((r) => r[c] !== v); return b; },
        ilike(c, pat) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i'); filters.push((r) => re.test(r[c] ?? '')); return b; },
        insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
        delete() { op = 'delete'; return b; },
        order() { return b; }, limit() { return b; },
        range(from, to) { range = [from, to]; return b; },
        maybeSingle() { single = true; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        upsert(rows, o) { op = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; conflict = o.onConflict.split(','); ignoreDup = !!o.ignoreDuplicates; return b; },
        then(res, rej) {
          try {
            const rows = t(name);
            const injected = failOn?.({ table: name, op, payload });
            if (injected) return Promise.resolve({ data: null, error: { message: injected } }).then(res, rej);
            // Unique indexes (optionally partial): unique[name] = [{ cols, where? }].
            const clash = (all) => (unique[name] || []).some(({ cols, where = () => true }) => {
              const seen = new Set();
              return all.filter(where).some((r) => { const k = JSON.stringify(cols.map((c) => r[c] ?? null)); if (cols.some((c) => r[c] == null)) return false; if (seen.has(k)) return true; seen.add(k); return false; });
            });
            const dup = { message: 'duplicate key value violates unique constraint', code: '23505' };
            if (op === 'select') {
              let out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
              // Like PostgREST: a plain select stops at maxRows (1,000 on Supabase) without saying so.
              out = range ? out.slice(range[0], range[1] + 1) : out.slice(0, maxRows);
              return Promise.resolve({ data: single ? out[0] || null : out, error: null }).then(res, rej);
            }
            if (op === 'update') {
              const hit = rows.filter((r) => filters.every((f) => f(r)));
              const before = hit.map((r) => ({ ...r }));
              hit.forEach((r) => Object.assign(r, payload));
              if (clash(rows)) { hit.forEach((r, i) => { for (const k of Object.keys(r)) delete r[k]; Object.assign(r, before[i]); }); return Promise.resolve({ data: null, error: dup }).then(res, rej); }
              return Promise.resolve({ data: returning ? hit.map((r) => ({ ...r })) : null, error: null }).then(res, rej);
            }
            if (op === 'delete') {
              const keep = rows.filter((r) => !filters.every((f) => f(r)));
              rows.splice(0, rows.length, ...keep);
              return Promise.resolve({ data: null, error: null }).then(res, rej);
            }
            if (op === 'insert') {
              const add = payload.map((p) => ({ ...(AUTO_ID.includes(name) && p.id == null ? { id: crypto.randomUUID() } : {}), ...p }));
              if (clash([...rows, ...add])) return Promise.resolve({ data: null, error: dup }).then(res, rej);
              rows.push(...add);
              return Promise.resolve({ data: null, error: null }).then(res, rej);
            }
            const written = [];
            for (const p of payload) {
              const hit = rows.find((r) => conflict.every((k) => r[k] === p[k]));
              if (hit) { if (!ignoreDup) { Object.assign(hit, p); written.push(hit); } } else {
                const row = name === 'ebay_order_lines' ? { match_status: 'unmatched', ...p } : { ...(AUTO_ID.includes(name) && p.id == null ? { id: crypto.randomUUID() } : {}), ...p };
                rows.push(row); written.push(row);
              }
            }
            return Promise.resolve({ data: returning ? written.map((r) => ({ ...r })) : null, error: null }).then(res, rej);
          } catch (e) { return Promise.resolve({ data: null, error: e }).then(res, rej); }
        },
      };
      return b;
    },
  };
}
