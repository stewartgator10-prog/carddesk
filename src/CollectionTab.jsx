import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Grid3x3, Loader, RefreshCw, Bell, X, Tag, Trash2, Pencil, Check } from 'lucide-react';
import { supabase, apiFetch } from './lib/supabase.js';
import { resizeForUpload } from './lib/image.js';
import CropImg from './lib/CropImg.jsx';
import { askConfirm } from './lib/dialog.jsx';
import { GAME_LABELS } from '../netlify/lib/snap-logic.js';

const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const num = (v) => (v === '' || v == null ? null : Number(v));
const SOURCE = { tcgplayer: 'TCGplayer', ebay_median: 'eBay listings', manual: 'your value' };
const FLAG = {
  low_confidence: 'AI unsure', no_price: 'No market price', not_a_card: 'Not a card', name_only_match: 'Set or number not confirmed',
  multiple_versions: 'Several versions: check which', ebay_median: 'Priced from eBay listings', grade_unread: 'Grade not read',
};

async function postJson(body) {
  const res = await apiFetch('/api/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Growth from what was paid, else from the value on the day it was scanned (same rule as the alerts).
function change(it) {
  const base = it.cost != null && Number(it.cost) > 0 ? Number(it.cost) : Number(it.value_at_add);
  if (!(base > 0) || it.market_price == null) return null;
  return ((Number(it.market_price) - base) / base) * 100;
}

function Sparkline({ points }) {
  if (!points || points.length < 2) return <span className="ink-faint" style={{ fontSize: '0.65rem' }}>history builds nightly</span>;
  const w = 90, h = 26, ys = points.map((p) => p.price), lo = Math.min(...ys), hi = Math.max(...ys);
  const y = (v) => (hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 6));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(i / (points.length - 1)) * w},${y(p.price).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Value from ${money(ys[0])} to ${money(ys[ys.length - 1])} over ${points.length} days`}>
      <path d={d} fill="none" stroke={up ? 'var(--leaf)' : 'var(--bad)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function CollectionTab({ userId, settings, setSettings, onGoToSnap, onAlertsChanged }) {
  const [items, setItems] = useState([]);
  const [history, setHistory] = useState({});
  const [urls, setUrls] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);          // { label, done, total }
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('held');
  const [q, setQ] = useState('');
  const singleInput = useRef(null);
  const pageInput = useRef(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('collection_items').select('*').neq('status', 'removed').order('created_at', { ascending: false });
    if (error) { setMsg({ type: 'error', text: error.message }); setLoading(false); return; }
    setItems(data || []);
    setLoading(false);
    const since = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
    const { data: prices } = await supabase.from('collection_prices').select('item_id, day, price').gte('day', since).order('day');
    const h = {};
    for (const p of prices || []) (h[p.item_id] ||= []).push({ day: p.day, price: Number(p.price) });
    setHistory(h);
    onAlertsChanged?.();
  }, [onAlertsChanged]);
  useEffect(() => { load(); }, [load]);

  // Signed links for the private photos (an hour).
  useEffect(() => {
    const need = [...new Set(items.map((i) => i.photo_path).filter(Boolean))].filter((p) => !urls[p]);
    if (!need.length) return;
    supabase.storage.from('snap-photos').createSignedUrls(need, 3600).then(({ data }) => {
      if (data) setUrls((u) => ({ ...u, ...Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl])) }));
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  async function scan(fileList, kind) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    setMsg(null);
    let added = 0; const problems = [];
    for (const [n, file] of files.entries()) {
      setBusy({ label: kind === 'page' ? 'Reading binder page' : 'Reading cards', done: n, total: files.length });
      try {
        const blob = await resizeForUpload(file);
        const path = `${userId}/collection/${crypto.randomUUID()}.jpg`;
        const up = await supabase.storage.from('snap-photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw new Error(up.error.message);
        setUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }));
        const r = await postJson({ action: 'scan', photoPath: path, kind });
        if (!r.ok) { problems.push(r.data.error || `Failed (${r.status})`); if (r.status === 429) break; continue; }
        added += r.data.cards_found || 0;
      } catch (e) { problems.push(e.message); }
    }
    setBusy(null);
    await load();
    setMsg(problems.length
      ? { type: 'error', text: `${added} card${added === 1 ? '' : 's'} added. ${problems.slice(0, 2).join(' | ')}` }
      : { type: 'ok', text: `${added} card${added === 1 ? '' : 's'} added and priced. Check anything marked below.` });
  }

  async function save(id, patch, { recheck = false } = {}) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const { error } = await supabase.from('collection_items').update(patch).eq('id', id);
    if (error) { setMsg({ type: 'error', text: `Couldn't save: ${error.message}` }); return; }
    if (recheck) { await postJson({ action: 'recheck' }); await load(); }
  }

  async function reprice(id) {
    setBusy({ label: 'Checking the price', done: 0, total: 1 });
    const r = await postJson({ action: 'reprice', id });
    setBusy(null);
    if (!r.ok) setMsg({ type: 'error', text: r.data.error || `Failed (${r.status})` });
    await load();
  }

  async function refreshAll() {
    setBusy({ label: 'Updating prices', done: 0, total: 1 });
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const r = await postJson({ action: 'refresh', force: i === 0 });
      if (!r.ok) { setMsg({ type: 'error', text: r.data.error || `Failed (${r.status})` }); break; }
      total += r.data.processed || 0;
      if (!r.data.remaining) break;
    }
    setBusy(null);
    await load();
    setMsg({ type: 'ok', text: `Prices updated for ${total} card${total === 1 ? '' : 's'}.` });
  }

  async function sendToSnap(it) {
    if (!(await askConfirm(`Send "${it.card_name}" to Snap to List?\n\nIt goes into the review queue identified and priced${it.cost != null ? `, with its cost of ${money(it.cost)}` : ''}. Nothing is listed on eBay until you check and publish it there.`,
      { title: 'Review for listing', confirmLabel: 'Send to Snap to List' }))) return;
    const r = await postJson({ action: 'list', id: it.id });
    if (!r.ok) { setMsg({ type: 'error', text: r.data.error || `Failed (${r.status})` }); return; }
    await load();
    setMsg({ type: 'ok', text: `"${it.card_name}" is in Snap to List.`, snap: true });
  }

  async function remove(it) {
    if (!(await askConfirm(`Remove "${it.card_name}" from your collection? Its price history goes with it.`, { title: 'Remove card', confirmLabel: 'Remove', danger: true }))) return;
    await save(it.id, { status: 'removed', alert_state: 'none' });
    setItems((xs) => xs.filter((x) => x.id !== it.id));
    onAlertsChanged?.();
  }

  const held = items.filter((i) => i.status === 'held');
  const alerts = held.filter((i) => i.alert_state === 'active');
  const totals = useMemo(() => {
    let value = 0, paid = 0, costed = 0, added = 0;
    for (const i of held) {
      const qn = Number(i.quantity) || 1;
      if (i.market_price != null) value += Number(i.market_price) * qn;
      if (i.value_at_add != null) added += Number(i.value_at_add) * qn;
      if (i.cost != null) { paid += Number(i.cost) * qn; costed += 1; }
    }
    return { value, paid, costed, added, cards: held.reduce((t, i) => t + (Number(i.quantity) || 1), 0) };
  }, [held]);
  const shown = items.filter((i) => (filter === 'alerts' ? i.status === 'held' && i.alert_state === 'active' : i.status === filter))
    .filter((i) => !q || `${i.card_name} ${i.catalog_set || i.set_name} ${i.collector_number}`.toLowerCase().includes(q.toLowerCase()));
  const s = settings || {};

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="bg-card" style={{ padding: 16, display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <div className="stat-box" style={{ padding: 14 }}><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.08em' }}>COLLECTION VALUE</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{money(totals.value)}</div>
            <div className="ink-faint" style={{ fontSize: '0.72rem' }}>{totals.cards} card{totals.cards === 1 ? '' : 's'}</div></div>
          <div className="stat-box" style={{ padding: 14 }}><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.08em' }}>SINCE ADDED</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800 }} className={totals.value >= totals.added ? 'accent-green' : 'accent-red'}>
              {totals.added > 0 ? `${totals.value >= totals.added ? '+' : ''}${(((totals.value - totals.added) / totals.added) * 100).toFixed(1)}%` : '—'}</div>
            <div className="ink-faint" style={{ fontSize: '0.72rem' }}>{money(totals.added)} when scanned</div></div>
          <div className="stat-box" style={{ padding: 14 }}><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.08em' }}>YOU PAID</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{totals.costed ? money(totals.paid) : '—'}</div>
            <div className="ink-faint" style={{ fontSize: '0.72rem' }}>{totals.costed} of {held.length} with a cost</div></div>
          <div className="stat-box" style={{ padding: 14 }}><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.08em' }}>READY TO REVIEW</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800 }} className={alerts.length ? 'accent-amber' : ''}>{alerts.length}</div>
            <div className="ink-faint" style={{ fontSize: '0.72rem' }}>hit a target or growth %</div></div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={singleInput} type="file" accept="image/*" multiple aria-label="Scan cards" style={{ display: 'none' }} onChange={(e) => { scan(e.target.files, 'single'); e.target.value = ''; }} />
          <input ref={pageInput} type="file" accept="image/*" multiple aria-label="Scan binder pages" style={{ display: 'none' }} onChange={(e) => { scan(e.target.files, 'page'); e.target.value = ''; }} />
          <button className="btn-primary" disabled={!!busy} onClick={() => singleInput.current?.click()} style={{ padding: '10px 16px', display: 'inline-flex', gap: 8, alignItems: 'center' }}><Camera size={16} /> Scan cards</button>
          <button className="btn-ghost" disabled={!!busy} onClick={() => pageInput.current?.click()} style={{ padding: '10px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Grid3x3 size={15} /> Scan binder page</button>
          <button className="btn-ghost" disabled={!!busy || !held.length} onClick={refreshAll} style={{ padding: '10px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><RefreshCw size={14} /> Update prices now</button>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', fontSize: '0.8rem' }}>
            <label htmlFor="alert-pct" style={{ margin: 0, textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem', color: 'var(--ink)' }}>Alert when a card gains</label>
            <input id="alert-pct" className="bg-input" type="number" min="0" step="5" style={{ width: 70, padding: '6px 8px' }} value={s.collectionAlertPct ?? 25}
              onChange={(e) => setSettings({ ...s, collectionAlertPct: e.target.value === '' ? 0 : Number(e.target.value) })}
              onBlur={async () => { await postJson({ action: 'recheck' }); load(); }} /> %
          </div>
        </div>
        <div className="ink-faint" style={{ fontSize: '0.72rem' }}>
          One card per photo for single cards and slabs (several photos at once is fine); a binder page reads up to 9. Prices: TCGplayer for English Pokémon, Magic, Yu-Gi-Oh!, One Piece and Lorcana; eBay listings for slabs (same grader and grade) and everything else. Prices update every night. Growth counts from what you paid, or from the value the day you scanned it.
        </div>
        {busy && <div className="ink-dim" style={{ fontSize: '0.85rem', display: 'flex', gap: 8, alignItems: 'center' }}><Loader size={14} className="spin" /> {busy.label}{busy.total > 1 ? ` (${busy.done + 1} of ${busy.total})` : ''}…</div>}
        {msg && (
          <div className={msg.type === 'error' ? 'accent-red' : 'accent-green'} style={{ fontSize: '0.85rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {msg.text}
            {msg.snap && onGoToSnap && <button className="btn-ghost" onClick={onGoToSnap} style={{ padding: '4px 10px', fontSize: '0.78rem' }}>Open Snap to List</button>}
            <button className="btn-icon" aria-label="Close message" onClick={() => setMsg(null)}><X size={13} /></button>
          </div>
        )}
      </section>

      {alerts.length > 0 && (
        <section className="bg-card" role="region" aria-label="Cards ready to review for listing" style={{ padding: 16, borderColor: 'var(--warn)' }}>
          <h2 className="display-font" style={{ margin: '0 0 8px', fontSize: '1.15rem', display: 'flex', gap: 8, alignItems: 'center' }}><Bell size={17} /> ready to review for listing</h2>
          <div style={{ display: 'grid', gap: 8 }}>
            {alerts.map((it) => (
              <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', gap: '6px 10px', alignItems: 'center' }}>
                <CropImg url={urls[it.photo_path] || it.catalog_image_url} box={it.photo_crop} alt={it.card_name} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{it.card_name} <span className="ink-faint" style={{ fontWeight: 400 }}>{it.catalog_number || it.collector_number}</span></div>
                  <div className="ink-dim" style={{ fontSize: '0.8rem' }}>{it.alert_reason}</div>
                </div>
                <div style={{ gridColumn: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn-primary" onClick={() => sendToSnap(it)} style={{ padding: '6px 12px', fontSize: '0.82rem', display: 'inline-flex', gap: 5, alignItems: 'center' }}><Tag size={13} /> Review for listing</button>
                  <button className="btn-ghost" onClick={() => save(it.id, { alert_state: 'dismissed' }).then(() => onAlertsChanged?.())} style={{ padding: '6px 10px', fontSize: '0.8rem' }}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="bg-card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          {[['held', `Holding (${held.length})`], ['alerts', `Ready to review (${alerts.length})`], ['listing', `Sent to listing (${items.filter((i) => i.status === 'listing').length})`]].map(([k, l]) => (
            <button key={k} className="btn-ghost" aria-pressed={filter === k} onClick={() => setFilter(k)}
              style={{ padding: '6px 10px', fontSize: '0.78rem', ...(filter === k ? { borderColor: 'var(--active)', color: 'var(--active)' } : {}) }}>{l}</button>
          ))}
          <input className="bg-input" placeholder="Search name, set, number" aria-label="Search collection" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240, marginLeft: 'auto', padding: '6px 10px' }} />
        </div>
        {loading ? <div className="ink-faint" style={{ padding: 32, textAlign: 'center' }}><Loader size={16} className="spin" /></div>
          : !shown.length ? <div className="ink-faint" style={{ padding: 32, textAlign: 'center', fontSize: '0.9rem' }}>{items.length ? 'Nothing here.' : 'No cards yet. Tap "Scan cards" or "Scan binder page" to add your collection.'}</div>
            : shown.map((it) => <ItemRow key={it.id} it={it} url={urls[it.photo_path] || it.catalog_image_url} history={history[it.id]} defaultPct={s.collectionAlertPct ?? 25}
              onSave={save} onReprice={() => reprice(it.id)} onList={() => sendToSnap(it)} onRemove={() => remove(it)} />)}
      </section>
    </div>
  );
}

function ItemRow({ it, url, history, defaultPct, onSave, onReprice, onList, onRemove }) {
  const [d, setD] = useState(it);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setD(it); }, [it]);
  const field = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const ch = change(it);
  const held = it.status === 'held';
  const inp = { padding: '5px 7px', fontSize: '0.8rem' };
  const detail = [GAME_LABELS[it.game] || it.game, it.catalog_set || it.set_name, it.catalog_number || it.collector_number, it.rarity,
    it.graded ? `${it.grader || ''} ${it.grade || ''}`.trim() || 'Graded' : it.condition].filter(Boolean).join(' · ');

  return (
    <div className="grid-row" style={{ gridTemplateColumns: '56px minmax(0, 1fr)', alignItems: 'start', gap: 12, padding: '12px 14px' }}>
      <CropImg url={url} box={it.photo_crop} alt={it.card_name} />
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{it.card_name}{it.quantity > 1 ? <span className="ink-dim"> ×{it.quantity}</span> : null}</div>
            <div className="ink-faint" style={{ fontSize: '0.74rem' }}>{detail}</div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Sparkline points={history} />
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 800 }}>{money(it.market_price)}</div>
              <div className="ink-faint" style={{ fontSize: '0.68rem' }}>{SOURCE[it.market_source] || 'no price'}{it.market_key ? ` · ${it.market_key}` : ''}</div>
            </div>
            <div style={{ minWidth: 54, textAlign: 'right', fontWeight: 700 }} className={ch == null ? 'ink-faint' : ch >= 0 ? 'accent-green' : 'accent-red'}>
              {ch == null ? '—' : `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%`}
            </div>
          </div>
        </div>
        {(it.flags || []).length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {it.flags.map((f) => <span key={f} className="fair" style={{ fontSize: '0.66rem', padding: '1px 7px', border: '1px solid' }}>{FLAG[f] || f}</span>)}
          </div>
        )}
        {it.alert_state === 'active' && held && <div className="accent-amber" style={{ fontSize: '0.78rem' }}>{it.alert_reason}</div>}
        {held ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            {[['Paid $', 'cost', 'what you paid'], ['Target $', 'target_price', 'alert at'], ['Target %', 'target_pct', `${defaultPct}% default`]].map(([label, k, ph]) => (
              <label key={k} style={{ margin: 0, fontSize: '0.66rem', display: 'grid', gap: 2 }}>{label}
                <input className="bg-input" type="number" step="0.01" min="0" style={{ ...inp, width: 96 }} placeholder={ph} aria-label={`${label} for ${it.card_name}`}
                  value={d[k] ?? ''} onChange={(e) => field(k, e.target.value)}
                  onBlur={() => { const v = num(d[k]); if (v !== (it[k] == null ? null : Number(it[k]))) onSave(it.id, { [k]: v, alert_state: 'none' }, { recheck: true }); }} />
              </label>
            ))}
            <label style={{ margin: 0, fontSize: '0.66rem', display: 'grid', gap: 2 }}>Qty
              <input className="bg-input" type="number" min="1" step="1" style={{ ...inp, width: 60 }} aria-label={`Quantity of ${it.card_name}`} value={d.quantity ?? 1}
                onChange={(e) => field('quantity', e.target.value)} onBlur={() => { const v = Math.max(1, Math.round(Number(d.quantity) || 1)); if (v !== it.quantity) onSave(it.id, { quantity: v }); }} />
            </label>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button className="btn-ghost" onClick={onList} style={{ padding: '6px 10px', fontSize: '0.78rem', display: 'inline-flex', gap: 5, alignItems: 'center' }}><Tag size={13} /> List it</button>
              <button className="btn-icon" title="Edit details" aria-label={`Edit details of ${it.card_name}`} onClick={() => setEditing((v) => !v)}><Pencil size={14} /></button>
              <button className="btn-icon" title="Remove from collection" aria-label={`Remove ${it.card_name}`} onClick={onRemove}><Trash2 size={14} /></button>
            </div>
          </div>
        ) : <div className="ink-dim" style={{ fontSize: '0.78rem' }}>In Snap to List for review and publishing.</div>}
        {editing && held && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6, alignItems: 'end' }}>
            <input className="bg-input" style={inp} aria-label="Card name" placeholder="Card name" value={d.card_name || ''} onChange={(e) => field('card_name', e.target.value)} />
            <input className="bg-input" style={inp} aria-label="Card number" placeholder="Number" value={d.collector_number || ''} onChange={(e) => field('collector_number', e.target.value)} />
            <input className="bg-input" style={inp} aria-label="Set" placeholder="Set" value={d.set_name || ''} onChange={(e) => field('set_name', e.target.value)} />
            <select className="bg-input" style={inp} aria-label="Game" value={d.game || 'pokemon'} onChange={(e) => field('game', e.target.value)}>
              {Object.entries(GAME_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input className="bg-input" style={inp} aria-label="Rarity" placeholder="Rarity" value={d.rarity || ''} onChange={(e) => field('rarity', e.target.value)} />
            <input className="bg-input" style={inp} aria-label="Your own value per card" placeholder="Set value yourself $" type="number" step="0.01" min="0"
              value={d._manual ?? ''} onChange={(e) => field('_manual', e.target.value)} />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'inline-flex', gap: 5, alignItems: 'center' }} onClick={async () => {
                const patch = { card_name: d.card_name, collector_number: d.collector_number, set_name: d.set_name, game: d.game, rarity: d.rarity || null };
                const manual = num(d._manual);
                if (manual != null) Object.assign(patch, { market_price: manual, market_source: 'manual', market_key: null, market_at: new Date().toISOString() });
                await onSave(it.id, patch, { recheck: manual != null });
                setEditing(false);
                if (manual == null) onReprice();
              }}><Check size={13} /> {num(d._manual) != null ? 'Save my value' : 'Save and re-price'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
