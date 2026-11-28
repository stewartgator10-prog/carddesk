// netlify/lib/db-pages.js
// Supabase (PostgREST) returns at most 1,000 rows per request and cuts the rest off silently, so
// anything that reads "every row" pages through with .range(). Browser-safe.
export const PAGE_ROWS = 1000;

// makeQuery() builds a fresh query each time (a supabase-js builder can only run once).
export async function allRows(makeQuery, { pageSize = PAGE_ROWS, maxRows = 200_000 } = {}) {
  const out = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

// Splits a long id list so an `.in()` filter stays well inside URL limits.
export function chunks(xs, size = 200) {
  const out = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
