import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Loader, Check, X, Link2 } from 'lucide-react';
import { supabase } from './lib/supabase.js';
import { summarizePnl } from '../netlify/lib/pnl.js';

const RANGES = [
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: '365', label: '12 months', days: 365 },
  { key: 'all', label: 'All time', days: null },
];
const N = (v) => (v == null ? null : Number(v));
const fmt = (n) => (n == null || isNaN(n) ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Number(n)).toFixed(2)}`);
const FEE_BADGE = {
  actual: { text: 'ACTUAL', color: 'var(--good)', tip: 'Fees from your eBay payouts' },
  order: { text: 'ORDER', color: 'var(--warn)', tip: 'Fee eBay showed on the order; payout not posted yet' },
  estimated: { text: 'EST', color: 'var(--bad)', tip: 'Estimated from your fee settings' },
};
const MATCH_LABEL = { auto: 'Auto-matched', confirmed: 'Confirmed', suggested: 'Suggested', unmatched: 'No match', ignored: 'Not tracked' };

export default function EbaySalesTab() {
  const [range, setRange] = useState('90');
  const [lines, setLines] = useState([]);
  const [overheadTxns, setOverheadTxns] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [pick, setPick] = useState({}); // line_item_id -> inventory id chosen in the dropdown
  const [reopened, setReopened] = useState(() => new Set()); // 'Not tracked' sales the user wants to match again

  const since = useMemo(() => {
    const r = RANGES.find((x) => x.key === range);
    return r.days ? new Date(Date.now() - r.days * 864e5).toISOString() : null;
  }, [range]);

  async function load() {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    let q = supabase.from('ebay_order_lines').select('*, ebay_orders(cancel_state, payment_status, buyer_username)').order('sold_at', { ascending: false }).limit(2000);
    let t = supabase.from('ebay_transactions').select('transaction_id, transaction_type, fee_type, amount, order_id, transaction_date').is('order_id', null).eq('transaction_type', 'NON_SALE_CHARGE');
    if (since) { q = q.gte('sold_at', since); t = t.gte('transaction_date', since); }
    const [l, tx, inv, acct] = await Promise.all([
      q, t,
      supabase.from('inventory').select('id, card_name, set_name, condition, cost_basis, status').eq('status', 'In Stock').order('card_name'),
      // ebay_accounts holds tokens and is server-only (no RLS policy), so use the newest synced order instead.
      supabase.from('ebay_orders').select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (l.error) setMsg({ type: 'error', text: l.error.message });
    setLines(l.data || []);
    setOverheadTxns((tx.data || []).map((x) => ({ ...x, amount: N(x.amount) })));
    setInventory(inv.data || []);
    setLastSync(acct.data?.updated_at || null);
    setLoading(false);
  }
  useEffect(() => { load(); }, [since]);

  async function call(path, body) {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function sync(days) {
    setSyncing(true); setMsg(null);
    try {
      const r = await call('/api/ebay-sync-orders', days ? { days } : {});
      setMsg({ type: 'ok', text: `Synced ${r.orders} orders and ${r.transactions} payouts/fees. ${r.autoMarkedSold} card(s) marked sold, ${r.suggested} match(es) to review.${r.restocked ? ` ${r.restocked} card(s) back in stock after a cancelled order.` : ''}` });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    setSyncing(false);
  }

  async function act(line, action, inventory_id) {
    try { await call('/api/ebay-order-match', { line_item_id: line.line_item_id, action, inventory_id }); await load(); }
    catch (e) { setMsg({ type: 'error', text: e.message }); }
  }

  const rows = useMemo(() => lines.map((l) => ({
    ...l,
    gross: N(l.gross) || 0, fees: N(l.fees) || 0, shipping_label: N(l.shipping_label) || 0, ad_fees: N(l.ad_fees) || 0,
    refunds: N(l.refunds) || 0, other: N(l.other) || 0, net_payout: N(l.net_payout) || 0,
    cost_basis: ['auto', 'confirmed'].includes(l.match_status) ? N(l.cost_basis) : null,
    profit: ['auto', 'confirmed'].includes(l.match_status) ? N(l.profit) : null,
    cancelled: l.ebay_orders?.cancel_state === 'CANCELED',
  })), [lines]);
  const s = useMemo(() => summarizePnl(rows, overheadTxns), [rows, overheadTxns]);
  const toReview = rows.filter((r) => !r.cancelled && (['suggested', 'unmatched'].includes(r.match_status)
    || (r.match_status === 'ignored' && reopened.has(r.line_item_id))));

  if (!supabase) {
    return <div className="bg-card ink-dim" style={{ padding: 32 }}>Supabase isn't configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to use eBay sales sync.</div>;
  }

  const Stat = ({ label, value, sub, tone }) => (
    <div className="stat-box">
      <div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }} className={tone == null ? '' : tone >= 0 ? 'accent-green' : 'accent-red'}>{value}</div>
      {sub && <div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {RANGES.map((r) => (
            <button key={r.key} className="btn-ghost" onClick={() => setRange(r.key)}
              style={{ padding: '8px 12px', fontSize: '0.75rem', borderColor: range === r.key ? 'var(--active)' : undefined, color: range === r.key ? 'var(--active)' : undefined }}>{r.label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="ink-faint" style={{ fontSize: '0.7rem' }}>{lastSync ? `Last sync ${new Date(lastSync).toLocaleString()}` : 'Never synced'}</span>
          <button className="btn-primary" disabled={syncing} onClick={() => sync()} style={{ padding: '10px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {syncing ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Sync eBay sales
          </button>
          {!lastSync && <button className="btn-ghost" disabled={syncing} onClick={() => sync(365)} style={{ padding: '10px 12px', fontSize: '0.75rem' }}>Pull last 12 months</button>}
        </div>
      </div>

      {msg && <div style={{ padding: '10px 14px', marginBottom: 16, border: `1px solid ${msg.type === 'error' ? 'var(--bad)' : 'var(--good)'}`, color: msg.type === 'error' ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem' }}>{msg.text}</div>}

      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
        <Stat label="GROSS SALES" value={fmt(s.gross)} sub={`${s.orders} orders · item + shipping, no tax`} />
        <Stat label="EBAY FEES" value={fmt(-s.fees)} sub={s.estimated_fees ? `${s.estimated_fees} sale(s) not final yet` : 'all from payouts'} />
        <Stat label="NET PAYOUT" value={fmt(s.net_payout)} sub={`labels ${fmt(s.shipping_label)} · ads ${fmt(s.ad_fees)} · refunds ${fmt(s.refunds)}`} />
        <Stat label="PROFIT" value={fmt(s.profit_after_overhead)} tone={s.profit_after_overhead}
          sub={`${fmt(s.profit)} on sales, ${fmt(s.overhead)} store costs${s.missing_cost ? ` · ${s.missing_cost} sale(s) missing cost` : ''}${rows.some((r) => r.cost_estimated && r.cost_basis != null) ? ` · ${rows.filter((r) => r.cost_estimated && r.cost_basis != null).length} use estimated cost` : ''}`} />
      </div>

      {toReview.length > 0 && (
        <div className="bg-card" style={{ padding: 0, marginBottom: 16, borderColor: 'var(--warn)' }}>
          <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--line)' }}>
            <h2 className="display-font" style={{ fontSize: '1.2rem', margin: 0 }}>MATCH TO INVENTORY · {toReview.length}</h2>
            <div className="ink-dim" style={{ fontSize: '0.75rem' }}>These sales couldn't be matched by eBay item ID or SKU. Pick the card you sold so profit uses its cost.</div>
          </div>
          {toReview.map((r) => {
            const chosen = pick[r.line_item_id] ?? r.inventory_id ?? '';
            return (
              <div key={r.line_item_id} className="grid-row" style={{ gridTemplateColumns: '2fr 90px 2fr auto', alignItems: 'center' }}>
                <div><div style={{ fontWeight: 500 }}>{r.title}</div><div className="ink-faint" style={{ fontSize: '0.7rem' }}>{r.sold_at?.slice(0, 10)} · order {r.order_id}</div></div>
                <div style={{ textAlign: 'right' }}>{fmt(r.gross)}</div>
                <select className="bg-input" value={chosen} onChange={(e) => setPick({ ...pick, [r.line_item_id]: e.target.value })}>
                  <option value="">Choose a card…</option>
                  {r.match_status === 'suggested' && r.inventory_id && !inventory.some((i) => i.id === r.inventory_id) && <option value={r.inventory_id}>Suggested card</option>}
                  {inventory.map((i) => <option key={i.id} value={i.id}>{i.card_name}{i.set_name ? ` · ${i.set_name}` : ''}{i.condition ? ` · ${i.condition}` : ''} ({fmt(N(i.cost_basis))}){r.inventory_id === i.id ? ' ★ suggested' : ''}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-ghost" disabled={!chosen} onClick={() => act(r, 'confirm', chosen)} style={{ padding: '6px 10px', fontSize: '0.7rem', display: 'inline-flex', gap: 4, alignItems: 'center' }}><Check size={12} /> Mark sold</button>
                  <button className="btn-ghost" onClick={() => act(r, 'ignore')} title="This sale isn't in my inventory" style={{ padding: '6px 10px', fontSize: '0.7rem' }}><X size={12} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-card" style={{ padding: 0 }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)' }}><h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0 }}>EBAY SALES · {rows.length}</h2></div>
        {loading ? <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint"><Loader size={16} className="spin" /></div>
          : rows.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">No eBay sales in this range yet. Click Sync eBay sales.</div> : (
          <div className="scrollable">
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 90px 80px 80px 80px 90px 80px 90px 110px', gap: 8, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: 'var(--ink-dim)', textTransform: 'uppercase', borderBottom: '1px solid var(--line-soft)' }}>
              <div>Sale</div><div style={{ textAlign: 'right' }}>Gross</div><div style={{ textAlign: 'right' }}>Fees</div><div style={{ textAlign: 'right' }}>Label</div><div style={{ textAlign: 'right' }}>Ads/Ref.</div><div style={{ textAlign: 'right' }}>Net</div><div style={{ textAlign: 'right' }}>Cost</div><div style={{ textAlign: 'right' }}>Profit</div><div>Inventory</div>
            </div>
            {rows.map((r) => {
              const b = FEE_BADGE[r.fee_source] || FEE_BADGE.estimated;
              return (
                <div key={r.line_item_id} className="grid-row" style={{ gridTemplateColumns: '2fr 90px 80px 80px 80px 90px 80px 90px 110px', opacity: r.cancelled ? 0.5 : 1 }}>
                  <div><div style={{ fontWeight: 500 }}>{r.title}{r.quantity > 1 ? ` ×${r.quantity}` : ''}</div>
                    <div className="ink-faint" style={{ fontSize: '0.7rem' }}>{r.sold_at?.slice(0, 10)} · {r.ebay_orders?.buyer_username || ''}{r.cancelled ? ' · CANCELLED' : ''}{r.refunds < 0 ? ' · REFUNDED' : ''}</div></div>
                  <div style={{ textAlign: 'right' }}>{fmt(r.gross)}</div>
                  <div style={{ textAlign: 'right' }} title={b.tip}>{fmt(-r.fees)}<div style={{ fontSize: '0.6rem', color: b.color }}>{b.text}</div></div>
                  <div style={{ textAlign: 'right' }}>{fmt(r.shipping_label)}</div>
                  <div style={{ textAlign: 'right' }}>{fmt(r.ad_fees + r.refunds + r.other)}</div>
                  <div style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.net_payout)}</div>
                  <div style={{ textAlign: 'right' }}>{fmt(r.cost_basis)}{r.cost_estimated && r.cost_basis != null && <div style={{ fontSize: '0.6rem', color: 'var(--warn)' }} title="Estimated cost">est.</div>}</div>
                  <div style={{ textAlign: 'right', fontWeight: 600 }} className={r.profit == null ? 'ink-faint' : r.profit >= 0 ? 'accent-green' : 'accent-red'}>{fmt(r.profit)}</div>
                  <div style={{ fontSize: '0.7rem' }}>
                    <div className="ink-dim">{MATCH_LABEL[r.match_status]}</div>
                    {r.match_status === 'ignored' && !r.cancelled && !reopened.has(r.line_item_id) && <button className="btn-ghost" onClick={() => setReopened(new Set(reopened).add(r.line_item_id))} title="Pick the card this sale was, so profit uses its cost" style={{ padding: '2px 6px', fontSize: '0.65rem', marginTop: 2 }}>Match</button>}
                    {['auto', 'confirmed'].includes(r.match_status) && <button className="btn-ghost" onClick={() => act(r, 'unlink')} title="Wrong card: undo and put it back in stock" style={{ padding: '2px 6px', fontSize: '0.65rem', marginTop: 2, display: 'inline-flex', gap: 3, alignItems: 'center' }}><Link2 size={10} /> Unlink</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
