// Supabase-backed collections for CardDesk.
// The UI keeps working with plain arrays of objects (same shape as the old
// localStorage data). Each setter diffs the new array against the old one and
// writes only the rows that changed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase.js';

// ---------- value helpers ----------
const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? '' : String(v));
const dateOrNull = (v) => (v ? String(v).slice(0, 10) : null);

export const newId = () => crypto.randomUUID();

// ---------- mappers: app object <-> table row ----------
export const MAPPERS = {
  inventory: {
    toRow: (i) => ({
      id: i.id,
      card_name: i.cardName || '',
      game: i.game || null,
      set_name: i.set || null,
      condition: i.condition || null,
      purchase_price: num(i.purchasePrice),
      shipping_in: num(i.shippingIn) ?? 0,
      cost_basis: num(i.costBasis),
      current_fmv: num(i.currentFmv),
      liquidity: i.liquidity || null,
      status: i.status === 'Sold' ? 'Sold' : 'In Stock',
      acquired_at: dateOrNull(i.acquired),
      sold_at: dateOrNull(i.sold),
      sale_price: num(i.salePrice),
      sale_channel: i.saleChannel || null,
      shipping_out: num(i.shippingOut),
      ebay_item_id: i.ebayItemId || null,
      sku: i.sku || null,
    }),
    fromRow: (r) => ({
      id: r.id,
      cardName: r.card_name,
      game: r.game || '',
      set: r.set_name || '',
      condition: r.condition || '',
      purchasePrice: str(r.purchase_price),
      shippingIn: str(r.shipping_in),
      costBasis: str(r.cost_basis),
      currentFmv: str(r.current_fmv),
      liquidity: r.liquidity || '',
      status: r.status,
      acquired: r.acquired_at || '',
      sold: r.sold_at || null,
      salePrice: str(r.sale_price),
      saleChannel: r.sale_channel || '',
      shippingOut: str(r.shipping_out),
      ebayItemId: r.ebay_item_id || '',
      sku: r.sku || '',
    }),
    order: { column: 'created_at', ascending: false },
  },
  watchlist: {
    toRow: (w) => ({
      id: w.id,
      card_name: w.cardName || '',
      game: w.game || null,
      set_name: w.set || null,
      condition: w.condition || null,
      target_fmv: num(w.targetFmv),
      max_buy: num(w.maxBuy),
      liquidity: w.liquidity || null,
      added_at: w.added || new Date().toISOString(),
    }),
    fromRow: (r) => ({
      id: r.id,
      cardName: r.card_name,
      game: r.game || '',
      set: r.set_name || '',
      condition: r.condition || '',
      targetFmv: str(r.target_fmv),
      maxBuy: str(r.max_buy),
      liquidity: r.liquidity || '',
      added: r.added_at,
    }),
    order: { column: 'added_at', ascending: false },
  },
  comps: {
    toRow: (c) => ({
      id: c.id,
      card_name: c.cardName || '',
      game: c.game || null,
      set_name: c.set || null,
      condition: c.condition || null,
      sale_price: num(c.salePrice) ?? 0,
      source: c.source || null,
      sold_on: dateOrNull(c.date),
    }),
    fromRow: (r) => ({
      id: r.id,
      cardName: r.card_name,
      game: r.game || '',
      set: r.set_name || '',
      condition: r.condition || '',
      salePrice: str(r.sale_price),
      source: r.source || '',
      date: r.sold_on || '',
    }),
    order: { column: 'created_at', ascending: false },
  },
};

const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- list collections ----------
export function useCollection(table, userId, onError) {
  const mapper = MAPPERS[table];
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const reload = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(mapper.order.column, { ascending: mapper.order.ascending });
    if (error) { onError?.(`Couldn't load ${table}: ${error.message}`); return; }
    setItems(data.map(mapper.fromRow));
    setLoaded(true);
  }, [table, userId]);

  useEffect(() => { setLoaded(false); setItems([]); reload(); }, [reload]);

  const save = useCallback(async (next) => {
    const prev = itemsRef.current;
    setItems(next); // optimistic

    const prevById = new Map(prev.map((i) => [i.id, i]));
    const nextIds = new Set(next.map((i) => i.id));
    const upserts = [];
    for (const item of next) {
      const before = prevById.get(item.id);
      if (!before || !sameRow(mapper.toRow(before), mapper.toRow(item))) {
        upserts.push({ ...mapper.toRow(item), user_id: userId });
      }
    }
    const deletes = prev.filter((i) => !nextIds.has(i.id)).map((i) => i.id);

    const errors = [];
    if (upserts.length) {
      const { error } = await supabase.from(table).upsert(upserts);
      if (error) errors.push(error.message);
    }
    if (deletes.length) {
      const { error } = await supabase.from(table).delete().in('id', deletes);
      if (error) errors.push(error.message);
    }
    if (errors.length) {
      onError?.(`Couldn't save ${table}: ${errors.join('; ')}`);
      reload(); // put the screen back in line with the database
    }
  }, [table, userId, reload]);

  return { items, setItems: save, loaded, reload };
}

// ---------- settings (single jsonb row per user) ----------
export function useSettings(userId, defaults, onError) {
  const [settings, setSettingsState] = useState(defaults);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('settings').select('data').eq('user_id', userId).maybeSingle();
      if (cancelled) return;
      if (error) onError?.(`Couldn't load settings: ${error.message}`);
      setSettingsState({ ...defaults, ...(data?.data || {}) });
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const save = useCallback((next) => {
    setSettingsState(next);
    // Settings inputs fire on every keystroke, so wait for a pause before writing.
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const { error } = await supabase.from('settings').upsert({ user_id: userId, data: next });
      if (error) onError?.(`Couldn't save settings: ${error.message}`);
    }, 600);
  }, [userId]);

  return { settings, setSettings: save, loaded };
}

// ---------- import of the old JSON backup / localStorage data ----------
// Old items have numeric ids (Date.now()). We keep that number as legacy_id so
// importing the same backup twice doesn't create duplicates.
export async function importBackup(data, userId) {
  const counts = {};
  for (const table of ['inventory', 'watchlist', 'comps']) {
    const list = Array.isArray(data?.[table]) ? data[table] : [];
    if (!list.length) { counts[table] = { found: 0, added: 0 }; continue; }
    const rows = list.map((item) => {
      const legacy = typeof item.id === 'number' ? item.id : (/^\d+$/.test(String(item.id ?? '')) ? Number(item.id) : null);
      return {
        ...MAPPERS[table].toRow({ ...item, id: newId() }),
        user_id: userId,
        legacy_id: legacy,
      };
    });
    const { data: inserted, error } = await supabase
      .from(table)
      .upsert(rows, { onConflict: 'user_id,legacy_id', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`${table}: ${error.message}`);
    counts[table] = { found: list.length, added: inserted?.length ?? 0 };
  }
  if (data?.settings && typeof data.settings === 'object') {
    const { error } = await supabase.from('settings').upsert({ user_id: userId, data: data.settings });
    if (error) throw new Error(`settings: ${error.message}`);
    counts.settings = true;
  }
  return counts;
}

// Data left over from the localStorage version of CardDesk, if this browser has any.
const LEGACY_KEYS = { watchlist: 'cdp:watchlist', comps: 'cdp:comps', inventory: 'cdp:inventory', settings: 'cdp:settings' };
const LEGACY_DONE_KEY = 'cdp:migratedToSupabase';

export function readLegacyLocalData() {
  try {
    if (localStorage.getItem(LEGACY_DONE_KEY)) return null;
    const out = {};
    let total = 0;
    for (const [k, key] of Object.entries(LEGACY_KEYS)) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      out[k] = JSON.parse(raw);
      if (Array.isArray(out[k])) total += out[k].length;
    }
    return total > 0 ? { data: out, total } : null;
  } catch { return null; }
}

export function markLegacyLocalDataHandled() {
  try { localStorage.setItem(LEGACY_DONE_KEY, new Date().toISOString()); } catch { /* ignore */ }
}
