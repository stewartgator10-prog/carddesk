import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Loader, Wand2, Check, AlertTriangle, ExternalLink, Link2, X, History } from 'lucide-react';
import {
  compsForListing, compStats, costForListing, floorPrice, netAfterFees,
  applyRule, checkPrice, roundPrice, money, detectCondition, RULES,
} from './pricingLogic.js';
import { fetchSellerListings, pushPriceChanges } from './sellerApi.js';

const LINKS_KEY = 'cdp:priceLinks';     // itemId -> { compKey, costBasis }
const HISTORY_KEY = 'cdp:priceHistory'; // newest first, capped

function useStored(key, initial) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; } catch { return initial; }
  });
  const save = next => {
    setV(prev => {
      const val = typeof next === 'function' ? next(prev) : next;
      try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ }
      return val;
    });
  };
  return [v, save];
}

const daysSince = d => (d ? Math.max(0, Math.round((Date.now() - new Date(d)) / 86400000)) : null);

export default function RepricerTab({ comps, inventory, settings, onGoToComps, onGoToListings }) {
  const [state, setState] = useState({ loading: true, error: null, demo: false, listings: [] });
  const [links, setLinks] = useStored(LINKS_KEY, {});
  const [history, setHistory] = useStored(HISTORY_KEY, []);
  const [drafts, setDrafts] = useState({});        // itemId -> string price
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [rule, setRule] = useState('matchComps');
  const [amount, setAmount] = useState('0');
  const [rounding, setRounding] = useState('cents');
  const [enforceFloor, setEnforceFloor] = useState(true);
  const [editingLink, setEditingLink] = useState(null);
  const [review, setReview] = useState(null);       // array of changes awaiting confirmation
  const [pushing, setPushing] = useState(false);
  const [lastResults, setLastResults] = useState({}); // itemId -> result
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchSellerListings();
      setState({ loading: false, error: null, demo: data.demo, listings: data.listings || [] });
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: err.message }));
    }
  }
  useEffect(() => { load(); }, []);

  // Everything the table needs per listing, recomputed when comps/inventory/settings change.
  const rows = useMemo(() => state.listings.map(l => {
    const link = links[l.itemId] || {};
    const listing = { ...l, compKey: link.compKey || '', costBasis: link.costBasis ?? null, condition: detectCondition(l.title, 'NM') };
    const matched = compsForListing(listing, comps);
    const stats = compStats(matched);
    const cost = costForListing(listing, inventory);
    const floor = floorPrice(cost, settings, settings.defaultShipping);
    const editable = !l.listingType || l.listingType === 'FixedPriceItem';
    return { listing, stats, cost, floor, editable };
  }), [state.listings, links, comps, inventory, settings]);

  const visible = rows.filter(r => !filter || String(r.listing.title || '').toLowerCase().includes(filter.toLowerCase()));
  const ctxFor = r => ({ stats: r.stats, floor: r.floor, enforceFloor, rounding });

  const pending = rows.map(r => {
    const raw = drafts[r.listing.itemId];
    if (raw === undefined || raw === '') return null;
    const check = checkPrice(r.listing, parseFloat(raw), ctxFor(r));
    if (check.blocked || Math.abs(check.price - r.listing.price) < 0.005) return null;
    return { row: r, ...check };
  }).filter(Boolean);

  function setDraft(itemId, value) { setDrafts(d => ({ ...d, [itemId]: value })); }

  function suggest(r) {
    if (!r.stats) return;
    setDraft(r.listing.itemId, roundPrice(r.stats.median, rounding).toFixed(2));
  }

  function applyBulk() {
    const next = { ...drafts };
    let skipped = 0;
    for (const r of rows) {
      if (!selected.has(r.listing.itemId) || !r.editable) continue;
      const p = applyRule(r.listing, rule, amount, ctxFor(r));
      if (p == null) { skipped++; continue; }
      next[r.listing.itemId] = p.toFixed(2);
    }
    setDrafts(next);
    if (skipped) alertOnce(`${skipped} selected listing${skipped > 1 ? 's have' : ' has'} no comps, so ${skipped > 1 ? 'they were' : 'it was'} left unchanged.`);
  }

  const [notice, setNotice] = useState(null);
  function alertOnce(msg) { setNotice(msg); setTimeout(() => setNotice(null), 6000); }

  function toggleAll(on) {
    setSelected(on ? new Set(visible.filter(r => r.editable).map(r => r.listing.itemId)) : new Set());
  }

  function openReview() {
    setReview(pending.map(p => ({
      itemId: p.row.listing.itemId, sku: p.row.listing.sku || null, title: p.row.listing.title,
      oldPrice: p.row.listing.price, newPrice: p.price, warnings: p.warnings,
      reason: p.row.stats ? `comp median ${money(p.row.stats.median)} (${p.row.stats.count})` : 'manual',
    })));
  }

  async function confirmPush() {
    setPushing(true);
    try {
      const res = await pushPriceChanges(review.map(({ itemId, sku, oldPrice, newPrice, reason }) => ({ itemId, sku, oldPrice, newPrice, reason })));
      const byId = Object.fromEntries(res.results.map(r => [r.itemId, r]));
      setLastResults(byId);
      const okIds = new Set(res.results.filter(r => r.ok).map(r => r.itemId));
      // Update local prices for what succeeded and clear those drafts; keep failed drafts for a retry.
      setState(s => ({ ...s, listings: s.listings.map(l => okIds.has(l.itemId) ? { ...l, price: byId[l.itemId].price } : l) }));
      setDrafts(d => Object.fromEntries(Object.entries(d).filter(([id]) => !okIds.has(id))));
      const at = new Date().toISOString();
      setHistory(h => [
        ...review.map(c => ({ at, itemId: c.itemId, title: c.title, oldPrice: c.oldPrice, newPrice: c.newPrice, ok: byId[c.itemId]?.ok, error: byId[c.itemId]?.error || null, demo: res.demo })),
        ...h,
      ].slice(0, 300));
      const failed = res.results.length - okIds.size;
      const offerFixes = res.results.filter(r => r.ok && r.warnings?.some(w => /Best Offer/.test(w))).length;
      alertOnce(`${res.demo ? 'Demo: ' : ''}${okIds.size} price${okIds.size === 1 ? '' : 's'} updated${failed ? `, ${failed} failed (drafts kept)` : ''}.`
        + (offerFixes ? ` ${offerFixes} listing${offerFixes === 1 ? '' : 's'} also had Best Offer auto-decline/accept lowered by the same %.` : ''));
      setReview(null);
      setSelected(new Set());
    } catch (err) {
      alertOnce(`Push failed: ${err.message}`);
    } finally {
      setPushing(false);
    }
  }

  const selectedCount = [...selected].length;
  const cols = '28px minmax(220px, 2fr) 80px 150px 90px 110px 80px 90px';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {state.demo && (
        <div className="bg-card" style={{ padding: '12px 16px', borderColor: '#fbbf24', display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: '0.8rem' }}>
          <AlertTriangle size={16} className="accent-amber" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong className="accent-amber">DEMO MODE.</strong> Your eBay seller account isn't connected yet, so these are sample listings and
            nothing is sent to eBay. Connect eBay on the <button className="btn-icon" style={{ padding: 0, textDecoration: 'underline', color: 'inherit', fontSize: 'inherit', fontFamily: 'inherit' }} onClick={onGoToListings}>eBay Listings</button> tab
            and sync, then your real active listings load here and pushes go straight to eBay.
          </div>
        </div>
      )}

      {/* Toolbar */}
      <section className="bg-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 220px' }}><label>Filter listings</label><input className="bg-input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="charizard, PSA 10…" /></div>
          <div style={{ width: 150 }}><label>Rounding</label>
            <select className="bg-input" value={rounding} onChange={e => setRounding(e.target.value)}>
              <option value="cents">Exact cents</option><option value="charm">End in .99</option>
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem', color: '#e8e8ed', marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={enforceFloor} onChange={e => setEnforceFloor(e.target.checked)} style={{ width: 'auto' }} />
            Never price below profit floor
          </label>
          <button className="btn-ghost" onClick={load} disabled={state.loading} style={{ padding: '10px 14px', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}>
            {state.loading ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Reload
          </button>
          <button className="btn-ghost" onClick={() => setShowHistory(s => !s)} style={{ padding: '10px 14px', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}>
            <History size={14} /> History ({history.length})
          </button>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', borderTop: '1px solid #1f1f2a', paddingTop: 12 }}>
          <div className="ink-dim" style={{ fontSize: '0.75rem', marginBottom: 10 }}>BULK · {selectedCount} selected</div>
          <div style={{ width: 190 }}><label>Rule</label>
            <select className="bg-input" value={rule} onChange={e => { setRule(e.target.value); setAmount(e.target.value === 'matchComps' ? '0' : ''); }}>
              {Object.entries(RULES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
            </select>
          </div>
          <div style={{ width: 150 }}><label>{RULES[rule].unit}</label><input className="bg-input" type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder={rule === 'percent' ? '-10' : ''} /></div>
          <button className="btn-primary" onClick={applyBulk} disabled={!selectedCount} style={{ padding: '10px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Wand2 size={14} /> FILL NEW PRICES
          </button>
          <div className="ink-faint" style={{ fontSize: '0.7rem', marginBottom: 10, flex: '1 1 200px' }}>
            Fills the New Price column only. Nothing changes on eBay until you review and push.
          </div>
        </div>
        {notice && <div className="accent-amber" style={{ fontSize: '0.8rem' }}>{notice}</div>}
      </section>

      {showHistory && <HistoryPanel history={history} onClear={() => setHistory([])} />}

      {/* Table */}
      <section className="bg-card" style={{ padding: 0 }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0 }}>ACTIVE LISTINGS · {state.listings.length}</h2>
          <button className="btn-primary" disabled={!pending.length} onClick={openReview} style={{ padding: '10px 18px' }}>
            REVIEW {pending.length} CHANGE{pending.length === 1 ? '' : 'S'} →
          </button>
        </div>
        {state.error && <div className="accent-red" style={{ padding: 24 }}>Couldn't load listings: {state.error}</div>}
        {!state.error && !state.loading && state.listings.length === 0 && <div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}>No active listings found.</div>}
        {state.listings.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 900 }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '12px 16px', fontSize: '0.7rem', letterSpacing: '0.1em', color: '#8a8a96', textTransform: 'uppercase', borderBottom: '1px solid #1f1f2a', alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={selectedCount > 0 && selectedCount === visible.filter(r => r.editable).length} onChange={e => toggleAll(e.target.checked)} />
                <div>Listing</div><div style={{ textAlign: 'right' }}>Current</div><div>Sold comps</div>
                <div style={{ textAlign: 'right' }}>Floor</div><div>New price</div><div style={{ textAlign: 'right' }}>Change</div><div style={{ textAlign: 'right' }}>Net</div>
              </div>
              <div className="scrollable">
                {visible.map(r => (
                  <ListingRow key={r.listing.itemId} r={r} cols={cols}
                    selected={selected.has(r.listing.itemId)}
                    onSelect={on => setSelected(s => { const n = new Set(s); on ? n.add(r.listing.itemId) : n.delete(r.listing.itemId); return n; })}
                    draft={drafts[r.listing.itemId] ?? ''}
                    onDraft={v => setDraft(r.listing.itemId, v)}
                    onSuggest={() => suggest(r)}
                    check={drafts[r.listing.itemId] ? checkPrice(r.listing, parseFloat(drafts[r.listing.itemId]), ctxFor(r)) : null}
                    settings={settings}
                    result={lastResults[r.listing.itemId]}
                    onEditLink={() => setEditingLink(r.listing)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="ink-faint" style={{ padding: '12px 24px', fontSize: '0.7rem', borderTop: '1px solid #1f1f2a' }}>
          Comps come from your <button className="btn-icon" style={{ padding: 0, textDecoration: 'underline', color: 'inherit', fontSize: 'inherit' }} onClick={onGoToComps}>Sold Comps</button> log
          (last 90 days, same card and grade). Floor = cost + min profit + shipping after eBay fees. Net = what you keep after fees and shipping, before cost.
        </div>
      </section>

      {editingLink && (
        <LinkEditor listing={editingLink} value={links[editingLink.itemId] || {}}
          onSave={v => { setLinks(l => ({ ...l, [editingLink.itemId]: v })); setEditingLink(null); }}
          onClose={() => setEditingLink(null)} />
      )}

      {review && (
        <ReviewModal changes={review} demo={state.demo} pushing={pushing}
          onConfirm={confirmPush} onClose={() => !pushing && setReview(null)} />
      )}
    </div>
  );
}

function ListingRow({ r, cols, selected, onSelect, draft, onDraft, onSuggest, check, settings, result, onEditLink }) {
  const { listing, stats, floor, cost, editable } = r;
  const newPrice = check && !check.blocked ? check.price : null;
  const delta = newPrice != null ? newPrice - listing.price : null;
  const shownPrice = newPrice ?? listing.price;
  const net = netAfterFees(shownPrice, settings, settings.defaultShipping);
  const age = daysSince(listing.startTime);
  const vsComp = stats ? (listing.price - stats.median) / stats.median : null;

  return (
    <div className="grid-row" style={{ gridTemplateColumns: cols, gap: 8, opacity: editable ? 1 : 0.5 }}>
      <input type="checkbox" style={{ width: 'auto' }} disabled={!editable} checked={selected} onChange={e => onSelect(e.target.checked)} />
      <div style={{ minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={listing.title}>{listing.title}</div>
        <div className="ink-faint" style={{ fontSize: '0.7rem', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
          <span>{listing.condition}</span>
          {listing.quantity > 1 && <span>qty {listing.quantity}</span>}
          {listing.watchers != null && <span>{listing.watchers} watching</span>}
          {age != null && <span>{age}d listed</span>}
          {!editable && <span className="accent-amber">auction, can't reprice</span>}
          <button className="btn-icon" style={{ padding: 0, fontSize: '0.7rem', display: 'inline-flex', gap: 3, alignItems: 'center' }} onClick={onEditLink} title="Set comp search name and cost">
            <Link2 size={11} /> {listing.compKey ? `comps: "${listing.compKey}"` : 'link comps'}
          </button>
          {listing.url && <a href={listing.url} target="_blank" rel="noreferrer" className="ink-faint"><ExternalLink size={11} /></a>}
        </div>
      </div>
      <div style={{ textAlign: 'right', fontWeight: 600 }}>{money(listing.price)}</div>
      <div style={{ fontSize: '0.75rem' }}>
        {stats ? (
          <>
            <div>
              <strong>{money(stats.median)}</strong> <span className="ink-faint">· {stats.count} sold</span>
              {vsComp != null && Math.abs(vsComp) >= 0.1 && (
                <span className={vsComp > 0 ? 'accent-red' : 'accent-green'} style={{ marginLeft: 6 }}>
                  {vsComp > 0 ? '▲' : '▼'}{Math.abs(Math.round(vsComp * 100))}%
                </span>
              )}
            </div>
            <div className="ink-faint">{money(stats.low)}–{money(stats.high)}{!stats.exactCondition && ' · mixed cond.'}</div>
          </>
        ) : <span className="ink-faint">no comps</span>}
      </div>
      <div style={{ textAlign: 'right', fontSize: '0.75rem' }} title={cost != null ? `Cost ${money(cost)}` : 'No cost found. Link to set one.'}>
        {floor != null ? money(floor) : <span className="ink-faint">—</span>}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input className="bg-input" type="number" step="0.01" min="0.99" disabled={!editable} value={draft}
          onChange={e => onDraft(e.target.value)} placeholder={listing.price.toFixed(2)} style={{ padding: '6px 8px' }} />
        {editable && stats && <button className="btn-icon" title={`Use comp median ${money(stats.median)}`} onClick={onSuggest}><Wand2 size={14} /></button>}
      </div>
      <div style={{ textAlign: 'right', fontSize: '0.8rem' }}>
        {delta != null && Math.abs(delta) >= 0.005
          ? <span className={delta > 0 ? 'accent-green' : 'accent-red'}>{delta > 0 ? '+' : ''}{delta.toFixed(2)}</span>
          : result ? (result.ok ? <Check size={14} className="accent-green" /> : <span className="accent-red" title={result.error}>failed</span>) : <span className="ink-faint">—</span>}
        {check?.warnings?.length > 0 && <div className="accent-amber" style={{ fontSize: '0.65rem' }} title={check.warnings.join('\n')}>⚠ {check.warnings[0]}</div>}
      </div>
      <div style={{ textAlign: 'right', fontSize: '0.8rem' }} className={cost != null && net - cost < 0 ? 'accent-red' : ''}>{money(net)}</div>
    </div>
  );
}

function LinkEditor({ listing, value, onSave, onClose }) {
  const [compKey, setCompKey] = useState(value.compKey || '');
  const [costBasis, setCostBasis] = useState(value.costBasis ?? '');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }} onClick={onClose}>
      <div className="bg-card-raised" style={{ padding: 24, maxWidth: 480, width: '100%' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h3 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>LINK COMPS & COST</h3>
          <button className="btn-icon" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="ink-dim" style={{ fontSize: '0.75rem' }}>{listing.title}</p>
        <div style={{ display: 'grid', gap: 12 }}>
          <div><label>Comp search name</label><input className="bg-input" value={compKey} onChange={e => setCompKey(e.target.value)} placeholder="e.g. Charizard VMAX Darkness Ablaze" />
            <div className="ink-faint" style={{ fontSize: '0.7rem', marginTop: 4 }}>Matched against card names in Sold Comps. Leave blank to match on the listing title.</div></div>
          <div><label>Cost basis ($)</label><input className="bg-input" type="number" step="0.01" value={costBasis} onChange={e => setCostBasis(e.target.value)} placeholder="from inventory if blank" /></div>
          <button className="btn-primary" style={{ padding: 10 }} onClick={() => onSave({ compKey: compKey.trim(), costBasis: costBasis === '' ? null : parseFloat(costBasis) })}>SAVE</button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({ changes, demo, pushing, onConfirm, onClose }) {
  const up = changes.filter(c => c.newPrice > c.oldPrice).length;
  const totalDelta = changes.reduce((a, c) => a + (c.newPrice - c.oldPrice), 0);
  const flagged = changes.filter(c => c.warnings.length).length;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }} onClick={onClose}>
      <div className="bg-card-raised" style={{ padding: 24, maxWidth: 720, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="display-font" style={{ margin: 0, fontSize: '1.4rem' }}>REVIEW {changes.length} PRICE CHANGE{changes.length === 1 ? '' : 'S'}</h3>
          <button className="btn-icon" onClick={onClose} disabled={pushing}><X size={16} /></button>
        </div>
        <div className="ink-dim" style={{ fontSize: '0.8rem', margin: '8px 0 12px' }}>
          {up} up · {changes.length - up} down · net list value {totalDelta >= 0 ? '+' : ''}{money(totalDelta)}
          {flagged > 0 && <span className="accent-amber"> · {flagged} flagged</span>}
        </div>
        {!demo && changes.length - up > 0 && (
          <div className="ink-faint" style={{ fontSize: '0.7rem', marginBottom: 10 }}>
            If a listing's Best Offer auto-decline or auto-accept amount blocks a lower price, CardDesk lowers it by the same % so your offer rules stay the same.
          </div>
        )}
        <div className="scrollable" style={{ flex: 1, border: '1px solid #2a2a36' }}>
          {changes.map(c => (
            <div key={c.itemId} className="grid-row" style={{ gridTemplateColumns: '1fr 80px 20px 80px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
                {c.warnings.length > 0 && <div className="accent-amber" style={{ fontSize: '0.7rem' }}>⚠ {c.warnings.join(' · ')}</div>}
              </div>
              <div style={{ textAlign: 'right' }} className="ink-dim">{money(c.oldPrice)}</div>
              <div className="ink-faint">→</div>
              <div style={{ textAlign: 'right', fontWeight: 600 }} className={c.newPrice > c.oldPrice ? 'accent-green' : 'accent-red'}>{money(c.newPrice)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={onClose} disabled={pushing} style={{ padding: '10px 16px' }}>Back</button>
          <button className="btn-primary" onClick={onConfirm} disabled={pushing} style={{ padding: '10px 18px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {pushing && <Loader size={14} className="spin" />}
            {demo ? 'SIMULATE (DEMO)' : `PUSH ${changes.length} TO EBAY`}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({ history, onClear }) {
  return (
    <section className="bg-card" style={{ padding: 0 }}>
      <div style={{ padding: '12px 24px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="display-font" style={{ margin: 0, fontSize: '1.1rem' }}>PRICE CHANGE HISTORY</h3>
        {history.length > 0 && <button className="btn-ghost" onClick={onClear} style={{ padding: '6px 10px', fontSize: '0.75rem' }}>Clear</button>}
      </div>
      {history.length === 0 ? <div className="ink-faint" style={{ padding: 24, textAlign: 'center', fontSize: '0.8rem' }}>No price changes yet.</div> : (
        <div className="scrollable" style={{ maxHeight: 260 }}>
          {history.map((h, i) => (
            <div key={i} className="grid-row" style={{ gridTemplateColumns: '140px 1fr 70px 70px 70px', fontSize: '0.75rem' }}>
              <div className="ink-faint">{new Date(h.at).toLocaleString()}</div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title}</div>
              <div style={{ textAlign: 'right' }} className="ink-dim">{money(h.oldPrice)}</div>
              <div style={{ textAlign: 'right' }}>{money(h.newPrice)}</div>
              <div style={{ textAlign: 'right' }} className={h.ok ? 'accent-green' : 'accent-red'} title={h.error || ''}>{h.ok ? (h.demo ? 'demo' : 'done') : 'failed'}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
