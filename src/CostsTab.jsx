import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader, Download, Receipt, X, Trash2, Calculator } from 'lucide-react';
import { supabase, apiFetch } from './lib/supabase.js';
import { splitCost } from '../netlify/lib/cost-split.js';
import { askConfirm } from './lib/dialog.jsx';

const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const SOURCE = { entered: ['typed', 'var(--ink-dim)'], purchase: ['purchase', 'var(--info)'], estimated: ['est.', 'var(--warn)'] };

async function costsApi(body) {
  const res = body
    ? await apiFetch('/api/costs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    : await apiFetch('/api/costs');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function Progress({ label, done, total, estimated }) {
  const pct = total ? done / total : 0;
  return (
    <div className="stat-box">
      <div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{done} <span className="ink-dim" style={{ fontSize: '0.9rem' }}>of {total}</span></div>
      <div style={{ height: 4, background: 'var(--line)', marginTop: 6 }}><div style={{ height: 4, width: `${pct * 100}%`, background: pct === 1 ? 'var(--good)' : 'var(--warn)' }} /></div>
      <div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 4 }}>have a cost{estimated ? ` · ${estimated} estimated` : ''}</div>
    </div>
  );
}

// Cost input that saves on Enter or when leaving the box, and Enter moves to the next row.
function CostInput({ value, onSave, rowKey }) {
  const [v, setV] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV(value ?? ''); }, [value]);
  async function commit() {
    if (String(v) === String(value ?? '') || v === '') return;
    setBusy(true);
    try { await onSave(Number(v)); } finally { setBusy(false); }
  }
  return (
    <input className="bg-input cost-input" data-row={rowKey} type="number" step="0.01" min="0" inputMode="decimal" value={v}
      placeholder="cost" style={{ padding: '6px 8px', width: '100%', minWidth: 0, opacity: busy ? 0.5 : 1 }}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const all = [...document.querySelectorAll('.cost-input')];
        const next = all[all.indexOf(e.currentTarget) + 1];
        (next || e.currentTarget).focus();
        if (!next) commit();
      }} />
  );
}

export default function CostsTab({ settings }) {
  const [panel, setPanel] = useState('stock');
  const [summary, setSummary] = useState(null);
  const [stock, setStock] = useState([]);
  const [listingInfo, setListingInfo] = useState({});
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('missing');
  const [q, setQ] = useState('');
  const [pct, setPct] = useState('25');
  const [purchaseOpen, setPurchaseOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, inv, lst, lines] = await Promise.all([
        costsApi(),
        supabase.from('inventory').select('id, card_name, status, cost_basis, cost_source, current_fmv, ebay_item_id, purchase_id, created_at').eq('status', 'In Stock').order('card_name').limit(5000),
        supabase.from('ebay_listings').select('item_id, image_url, price, view_url').eq('status', 'Active').limit(5000),
        supabase.from('ebay_order_lines').select('line_item_id, order_id, title, sold_at, gross, net_payout, cost_basis, cost_estimated, profit, match_status, ebay_orders(cancel_state)').order('sold_at', { ascending: false }).limit(2000),
      ]);
      setSummary(s);
      setStock(inv.data || []);
      setListingInfo(Object.fromEntries((lst.data || []).map((l) => [String(l.item_id), l])));
      setSales((lines.data || []).filter((l) => l.ebay_orders?.cancel_state !== 'CANCELED' && l.match_status !== 'ignored'));
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(label, body, ok) {
    setBusy(label); setMsg(null);
    try {
      const r = await costsApi(body);
      setSummary(r.summary);
      if (ok) setMsg({ type: 'ok', text: ok(r.result) });
      await load();
      return r;
    } catch (e) { setMsg({ type: 'error', text: e.message }); return null; }
    finally { setBusy(null); }
  }

  const fee = (p) => p * (1 - (settings.ebayFeePct || 0) / 100) - (settings.ebayFeeFlat || 0) - (settings.defaultShipping || 0);
  const visibleStock = useMemo(() => stock.filter((r) => {
    if (filter === 'missing' && r.cost_basis != null) return false;
    if (filter === 'estimated' && r.cost_source !== 'estimated') return false;
    return !q || (r.card_name || '').toLowerCase().includes(q.toLowerCase());
  }), [stock, filter, q]);
  const listingCards = stock.filter((r) => r.ebay_item_id).length;
  const activeListings = Object.keys(listingInfo).length;
  const allVisibleSelected = visibleStock.length > 0 && visibleStock.every((r) => selected.has(r.id));

  if (loading) return <div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}><Loader size={18} className="spin" /></div>;

  const pill = (k, label) => (
    <button className="btn-ghost" onClick={() => setPanel(k)} style={{ padding: '8px 12px', fontSize: '0.75rem', borderColor: panel === k ? 'var(--active)' : undefined, color: panel === k ? 'var(--active)' : undefined }}>{label}</button>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <Progress label="CARDS IN STOCK" done={summary?.inStock?.withCost ?? 0} total={summary?.inStock?.cards ?? 0} estimated={summary?.inStock?.estimated} />
        <Progress label="PAST EBAY SALES" done={summary?.sales?.withCost ?? 0} total={summary?.sales?.lines ?? 0} estimated={summary?.sales?.estimated} />
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>PURCHASES RECORDED</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{summary?.purchases?.length ?? 0}</div>
          <div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 4 }}>{money((summary?.purchases || []).reduce((t, p) => t + Number(p.total_paid), 0))} spent</div></div>
      </div>

      {msg && <div style={{ padding: '10px 14px', border: `1px solid ${msg.type === 'error' ? 'var(--bad)' : 'var(--good)'}`, color: msg.type === 'error' ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between' }}>
        <span>{msg.text}</span><button className="btn-icon" onClick={() => setMsg(null)}><X size={14} /></button></div>}

      {activeListings > 0 && listingCards < activeListings && (
        <section className="bg-card" style={{ padding: 16, borderColor: 'var(--warn)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px', fontSize: '0.85rem' }}>
            <strong>{activeListings} eBay listings</strong> aren't in inventory yet. Import them so each sale can show real profit and the Repricer can use your costs.
          </div>
          <button className="btn-primary" disabled={!!busy} onClick={() => run('import', { action: 'import_listings' }, (r) => `Added ${r.created} cards from ${r.listings} listings. Now give them costs below.`)}
            style={{ padding: '10px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {busy === 'import' ? <Loader size={14} className="spin" /> : <Download size={14} />} IMPORT MY LISTINGS
          </button>
        </section>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {pill('stock', `Cards in stock (${stock.length})`)}
        {pill('sales', `Past sales (${sales.length})`)}
        {pill('purchases', `Purchases (${summary?.purchases?.length ?? 0})`)}
      </div>

      {panel === 'stock' && (
        <section className="bg-card" style={{ padding: 0 }}>
          <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
            <input className="bg-input" placeholder="Search cards" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 160px', padding: '8px 10px' }} />
            <select className="bg-input" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 150, padding: '8px 10px' }}>
              <option value="missing">Missing cost</option><option value="estimated">Estimated</option><option value="all">All</option>
            </select>
            <button className="btn-primary" disabled={!selected.size || !!busy} onClick={() => setPurchaseOpen(true)} style={{ padding: '8px 12px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Receipt size={14} /> PURCHASE FOR {selected.size} SELECTED
            </button>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: '0.75rem' }}>
              <span className="ink-faint">Estimate {selected.size ? 'selected' : 'all missing'} at</span>
              <input className="bg-input" type="number" value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 56, padding: '6px' }} /><span className="ink-faint">% of price</span>
              <button className="btn-ghost" disabled={!!busy} onClick={() => run('estimate', { action: 'estimate', pct: Number(pct), inventoryIds: selected.size ? [...selected] : undefined },
                (r) => `Estimated ${r.estimated} costs at ${pct}% of price. They're marked "est." until you replace them.`).then(() => setSelected(new Set()))}
                style={{ padding: '6px 10px', display: 'inline-flex', gap: 4, alignItems: 'center' }}><Calculator size={13} /> Fill</button>
            </span>
          </div>
          {visibleStock.length === 0 ? (
            <div className="ink-faint" style={{ padding: 40, textAlign: 'center', fontSize: '0.85rem' }}>
              {stock.length ? (filter === 'missing' ? 'Every card in stock has a cost.' : 'No cards match.') : 'No cards in stock yet. Import your eBay listings above, or add cards from the Deal Analyzer or Snap to List.'}
            </div>
          ) : (
            <div className="scrollable">
              <div className="grid-row" style={{ gridTemplateColumns: '22px 36px minmax(0, 1fr) 54px 80px 54px', gap: 6, padding: '8px 10px', fontSize: '0.65rem', letterSpacing: '0.08em', color: 'var(--ink-dim)' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={allVisibleSelected} onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...visibleStock.map((r) => r.id)]) : new Set())} />
                <div></div><div>CARD</div><div style={{ textAlign: 'right' }}>PRICE</div><div>COST (Enter = next)</div><div style={{ textAlign: 'right' }}>PROFIT</div>
              </div>
              {visibleStock.map((r) => {
                const l = listingInfo[String(r.ebay_item_id)];
                const price = Number(l?.price ?? r.current_fmv);
                const profit = r.cost_basis != null && Number.isFinite(price) ? fee(price) - Number(r.cost_basis) : null;
                const [srcLabel, srcColor] = SOURCE[r.cost_source] || [];
                return (
                  <div key={r.id} className="grid-row" style={{ gridTemplateColumns: '22px 36px minmax(0, 1fr) 54px 80px 54px', gap: 6, padding: '8px 10px' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={selected.has(r.id)} onChange={(e) => { const n = new Set(selected); e.target.checked ? n.add(r.id) : n.delete(r.id); setSelected(n); }} />
                    <div>{l?.image_url ? <img src={l.image_url} alt="" style={{ width: 40, height: 40, objectFit: 'cover' }} /> : null}</div>
                    <div style={{ minWidth: 0 }}><div style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere', fontSize: '0.8rem' }} title={r.card_name}>{r.card_name}</div>
                      {srcLabel && <span style={{ fontSize: '0.6rem', color: srcColor }}>{srcLabel}</span>}</div>
                    <div style={{ textAlign: 'right', fontSize: '0.8rem' }}>{money(price)}</div>
                    <CostInput rowKey={r.id} value={r.cost_basis} onSave={(cost) => run(null, { action: 'set_costs', items: [{ inventoryId: r.id, cost }] })} />
                    <div style={{ textAlign: 'right', fontSize: '0.8rem' }} className={profit == null ? 'ink-faint' : profit >= 0 ? 'accent-green' : 'accent-red'}>{profit == null ? '—' : money(profit)}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '10px 14px', borderTop: '1px solid var(--line-soft)' }}>
            Profit = list price after your eBay fee settings and default shipping, minus cost. A purchase splits what you paid (cards + shipping + tax) across its cards by market value.
          </div>
        </section>
      )}

      {panel === 'sales' && (
        <section className="bg-card" style={{ padding: 0 }}>
          <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--line)', fontSize: '0.75rem' }}>
            <span className="ink-dim" style={{ flex: '1 1 240px' }}>Enter what you paid for each card you sold. Each one becomes a sold inventory record linked to the sale.</span>
            <span className="ink-faint">Estimate the rest at</span>
            <input className="bg-input" type="number" value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 56, padding: '6px' }} /><span className="ink-faint">% of sale</span>
            <button className="btn-ghost" disabled={!!busy || !sales.some((s) => s.cost_basis == null)} onClick={() => run('estsales', { action: 'estimate_sales', pct: Number(pct) }, (r) => `Estimated ${r.estimated} past sales at ${pct}% of the sale price.`)}
              style={{ padding: '6px 10px', display: 'inline-flex', gap: 4, alignItems: 'center' }}>{busy === 'estsales' ? <Loader size={13} className="spin" /> : <Calculator size={13} />} Fill</button>
          </div>
          {sales.length === 0 ? <div className="ink-faint" style={{ padding: 40, textAlign: 'center' }}>No eBay sales synced yet. Sync them on the eBay Sales tab.</div> : (
            <div className="scrollable">
              <div className="grid-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 54px 54px 80px 54px', gap: 6, padding: '8px 10px', fontSize: '0.65rem', letterSpacing: '0.08em', color: 'var(--ink-dim)' }}>
                <div>SALE</div><div style={{ textAlign: 'right' }}>SOLD</div><div style={{ textAlign: 'right' }}>NET</div><div>COST</div><div style={{ textAlign: 'right' }}>PROFIT</div>
              </div>
              {sales.map((s) => (
                <div key={s.line_item_id} className="grid-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 54px 54px 80px 54px', gap: 6, padding: '8px 10px' }}>
                  <div style={{ minWidth: 0, fontSize: '0.8rem' }}><div style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }} title={s.title}>{s.title}</div>
                    <span className="ink-faint" style={{ fontSize: '0.65rem' }}>{s.sold_at?.slice(0, 10)}</span>
                    {s.cost_estimated && <span style={{ fontSize: '0.6rem', color: 'var(--warn)' }}> · est.</span>}</div>
                  <div style={{ textAlign: 'right', fontSize: '0.8rem' }}>{money(s.gross)}</div>
                  <div style={{ textAlign: 'right', fontSize: '0.8rem' }}>{money(s.net_payout)}</div>
                  <CostInput rowKey={s.line_item_id} value={s.cost_basis} onSave={(cost) => run(null, { action: 'sale_cost', lineItemId: s.line_item_id, cost })} />
                  <div style={{ textAlign: 'right', fontSize: '0.8rem' }} className={s.profit == null ? 'ink-faint' : Number(s.profit) >= 0 ? 'accent-green' : 'accent-red'}>{money(s.profit)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {panel === 'purchases' && (
        <section className="bg-card" style={{ padding: 0 }}>
          {(summary?.purchases || []).length === 0
            ? <div className="ink-faint" style={{ padding: 40, textAlign: 'center', fontSize: '0.85rem' }}>No purchases yet. On "Cards in stock", tick the cards from one order and press "purchase for selected".</div>
            : (summary?.purchases || []).map((p) => {
              const n = stock.filter((r) => r.purchase_id === p.id).length;
              return (
                <div key={p.id} className="grid-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 70px 32px', gap: 8 }}>
                  <div style={{ fontSize: '0.8rem', minWidth: 0, overflowWrap: 'anywhere' }}>{p.source || 'Purchase'}{p.notes ? <span className="ink-faint"> · {p.notes}</span> : null}
                    <div className="ink-faint" style={{ fontSize: '0.65rem' }}>{p.purchased_at} · split {p.split_method === 'even' ? 'evenly' : 'by market value'} · {n} card{n === 1 ? '' : 's'} in stock</div></div>
                  <div style={{ textAlign: 'right', fontWeight: 600 }}>{money(p.total_paid)}</div>
                  <button className="btn-icon" title="Delete purchase (its cards lose their cost)" onClick={async () => (await askConfirm('Delete this purchase? Its cards go back to having no cost.', { title: 'Delete purchase', confirmLabel: 'Delete purchase', danger: true })) && run('del', { action: 'delete_purchase', id: p.id }, (r) => `Purchase deleted; ${r.cleared} card costs cleared.`)}><Trash2 size={14} /></button>
                </div>
              );
            })}
        </section>
      )}

      {purchaseOpen && (
        <PurchaseModal cards={stock.filter((r) => selected.has(r.id)).map((r) => ({ ...r, price: Number(listingInfo[String(r.ebay_item_id)]?.price ?? r.current_fmv) }))}
          onClose={() => setPurchaseOpen(false)}
          onSave={async (purchase) => {
            const r = await run('purchase', { action: 'save_purchase', purchase, inventoryIds: [...selected] }, (x) => `Saved a ${money(purchase.total_paid)} purchase across ${x.cards} cards.`);
            if (r) { setPurchaseOpen(false); setSelected(new Set()); }
          }} busy={busy === 'purchase'} />
      )}
    </div>
  );
}

function PurchaseModal({ cards, onClose, onSave, busy }) {
  const [total, setTotal] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState('');
  const [method, setMethod] = useState('market');
  const preview = useMemo(() => (Number(total) >= 0 && total !== ''
    ? splitCost(Number(total), cards.map((c) => ({ id: c.id, weight: c.price })), method) : null), [total, cards, method]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="bg-card-raised" style={{ padding: 20, width: '100%', maxWidth: 520, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><h3 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>PURCHASE · {cards.length} CARDS</h3><button className="btn-icon" onClick={onClose}><X size={16} /></button></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div><label htmlFor="pur-total">Total paid $ (incl. shipping, tax)</label><input id="pur-total" className="bg-input" type="number" step="0.01" min="0" inputMode="decimal" autoFocus value={total} onChange={(e) => setTotal(e.target.value)} /></div>
          <div><label htmlFor="pur-date">Date</label><input id="pur-date" className="bg-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label htmlFor="pur-source">Bought from</label><input id="pur-source" className="bg-input" value={source} placeholder="e.g. eBay: seller123" onChange={(e) => setSource(e.target.value)} /></div>
          <div><label htmlFor="pur-split">Split</label><select id="pur-split" className="bg-input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="market">By market value</option><option value="even">Evenly</option></select></div>
        </div>
        <div className="scrollable" style={{ maxHeight: 260, border: '1px solid var(--line)' }}>
          {cards.map((c) => (
            <div key={c.id} className="grid-row" style={{ gridTemplateColumns: '1fr 70px 70px', fontSize: '0.75rem', padding: '6px 10px' }}>
              <div style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>{c.card_name}</div>
              <div className="ink-faint" style={{ textAlign: 'right' }}>{money(c.price)}</div>
              <div style={{ textAlign: 'right', fontWeight: 600 }}>{preview ? money(preview.get(c.id)) : '—'}</div>
            </div>
          ))}
        </div>
        <div className="ink-faint" style={{ fontSize: '0.7rem' }}>Right column: each card's share of what you paid. Cards already in another purchase move to this one.</div>
        <button className="btn-primary" disabled={busy || total === '' || !(Number(total) >= 0)} onClick={() => onSave({ total_paid: Number(total), purchased_at: date, source: source.trim() || null, split_method: method })} style={{ padding: 12 }}>
          {busy ? <Loader size={14} className="spin" /> : 'SAVE PURCHASE'}
        </button>
      </div>
    </div>
  );
}
