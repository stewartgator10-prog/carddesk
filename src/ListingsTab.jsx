import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, ExternalLink, Link2, Loader, Unlink, Store } from 'lucide-react';
import { supabase } from './lib/supabase.js';

const fmt = (n, cur = 'USD') =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n);
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

async function api(method, body) {
  if (!supabase) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) { const e = new Error('Sign in to CardDesk first.'); e.code = 'NO_SESSION'; throw e; }
  const path = method === 'CONNECT' ? '/api/ebay-connect'
    : method === 'FINISH' ? '/api/ebay-connect-finish' : '/api/ebay-listings';
  const res = await fetch(path, {
    method: method === 'CONNECT' || method === 'FINISH' ? 'POST' : method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(out.error || `Request failed (${res.status})`); e.code = out.code; throw e; }
  return out;
}

export default function ListingsTab() {
  const [account, setAccount] = useState(null);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // 'sync' | 'connect' | 'disconnect'
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [q, setQ] = useState('');
  const [showEnded, setShowEnded] = useState(false);
  const [pasteUrl, setPasteUrl] = useState('');

  const apply = (d) => { setAccount(d.account); setListings(d.listings || []); };

  useEffect(() => {
    // Result of the eBay consent redirect (?tab=listings&ebay=connected|declined|error)
    const p = new URLSearchParams(window.location.search);
    const result = p.get('ebay');
    if (result === 'connected') setNotice('eBay connected. Pulling your listings…');
    if (result === 'declined') setError('eBay connection was cancelled.');
    if (result === 'error') setError(`eBay connection failed: ${p.get('reason') || 'unknown error'}`);
    if (result) window.history.replaceState({}, '', window.location.pathname);

    (async () => {
      try {
        const d = await api('GET');
        apply(d);
        if (result === 'connected' && d.account) await sync();
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sync() {
    setBusy('sync'); setError(null);
    try {
      const d = await api('POST');
      apply(d);
      setNotice(`Synced ${d.sync.active} active listing${d.sync.active === 1 ? '' : 's'}${d.sync.ended ? `, ${d.sync.ended} ended` : ''}.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function connect() {
    setBusy('connect'); setError(null);
    try { const { url } = await api('CONNECT'); window.location.href = url; }
    catch (e) { setError(e.message); setBusy(null); }
  }

  async function finishFromPaste() {
    setBusy('finish'); setError(null);
    try {
      await api('FINISH', { url: pasteUrl });
      setPasteUrl('');
      apply(await api('GET'));
      setNotice('eBay connected. Pulling your listings…');
      await sync();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect eBay? This removes the saved sign-in and the listing snapshot from CardDesk. Nothing changes on eBay.')) return;
    setBusy('disconnect'); setError(null);
    try { apply(await api('DELETE')); setNotice('eBay disconnected.'); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return listings.filter((l) =>
      (showEnded || l.status === 'Active') &&
      (!term || (l.title || '').toLowerCase().includes(term) || (l.sku || '').toLowerCase().includes(term) || l.item_id.includes(term)));
  }, [listings, q, showEnded]);

  const stats = useMemo(() => {
    const active = listings.filter((l) => l.status === 'Active');
    const value = active.reduce((s, l) => s + (Number(l.price) || 0) * (l.quantity_available ?? 1), 0);
    const units = active.reduce((s, l) => s + (l.quantity_available ?? 1), 0);
    const watchers = active.reduce((s, l) => s + (l.watch_count || 0), 0);
    return { count: active.length, value, units, watchers };
  }, [listings]);

  const cols = '56px 2fr 110px 90px 70px 70px 110px 40px';

  if (loading) return <div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}><Loader size={18} className="spin" /> Loading…</div>;

  return (
    <div>
      {notice && <div className="bg-card" style={{ padding: '12px 16px', marginBottom: 16, borderColor: 'var(--good)' }}><span className="accent-green">{notice}</span></div>}
      {error && <div className="bg-card" style={{ padding: '12px 16px', marginBottom: 16, borderColor: 'var(--accent)' }}><span className="accent-red">{error}</span></div>}

      {!account ? (
        <section className="bg-card" style={{ padding: 32, textAlign: 'center' }}>
          <Store size={32} style={{ color: 'var(--accent)' }} />
          <h2 className="display-font" style={{ fontSize: '1.5rem', margin: '12px 0 4px' }}>CONNECT YOUR EBAY STORE</h2>
          <p className="ink-dim" style={{ fontSize: '0.85rem', maxWidth: 520, margin: '0 auto 20px' }}>
            Sign in with eBay to pull your active listings into CardDesk. CardDesk only reads your listings for now; nothing on eBay changes.
          </p>
          <button className="btn-primary" onClick={connect} disabled={!!busy} style={{ padding: '12px 24px', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {busy === 'connect' ? <Loader size={16} className="spin" /> : <Link2 size={16} />} Connect eBay
          </button>
          <div style={{ maxWidth: 560, margin: '28px auto 0', textAlign: 'left', borderTop: '1px solid var(--line)', paddingTop: 20 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 4 }}>Stuck on eBay's "Thank You" page?</div>
            <p className="ink-dim" style={{ fontSize: '0.8rem', marginTop: 0 }}>
              If eBay says "Authorization successfully completed" and doesn't bring you back, copy that page's full address from the browser bar and paste it here within 5 minutes.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="bg-input" placeholder="https://auth2.ebay.com/oauth2/ThirdPartyAuthSucessFailure?..." value={pasteUrl} onChange={(e) => setPasteUrl(e.target.value)} style={{ flex: 1 }} />
              <button className="btn-ghost" onClick={finishFromPaste} disabled={!!busy || !pasteUrl.trim()} style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>
                {busy === 'finish' ? <Loader size={14} className="spin" /> : 'Finish connecting'}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
            <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>ACTIVE LISTINGS</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }}>{stats.count}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>{stats.units} units available</div></div>
            <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>LISTED VALUE</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }}>{fmt(stats.value)}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>price × qty available</div></div>
            <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>WATCHERS</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }}>{stats.watchers}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>across active listings</div></div>
            <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>EBAY ACCOUNT</div><div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: 8 }}>{account.ebay_username || 'Connected'}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>synced {ago(account.last_synced_at)}</div></div>
          </div>

          <div className="bg-card" style={{ padding: 0 }}>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0, flex: 1 }}>EBAY LISTINGS · {visible.length}</h2>
              <input className="bg-input" placeholder="Search title, SKU, item #" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
              <label className="ink-dim" style={{ fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended
              </label>
              <button className="btn-primary" onClick={sync} disabled={!!busy} style={{ padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
                {busy === 'sync' ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Sync now
              </button>
              <button className="btn-ghost" onClick={disconnect} disabled={!!busy} title="Disconnect eBay" style={{ padding: '8px 10px', display: 'inline-flex', alignItems: 'center' }}><Unlink size={14} /></button>
            </div>

            {visible.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">
                {listings.length === 0 ? 'No listings yet. Click Sync now to pull them from eBay.' : 'No listings match.'}
              </div>
            ) : (
              <div className="scrollable">
                <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: 'var(--ink-dim)', textTransform: 'uppercase', borderBottom: '1px solid var(--line-soft)' }}>
                  <div></div><div>Title · SKU</div><div style={{ textAlign: 'right' }}>Price</div><div>Format</div><div style={{ textAlign: 'right' }}>Avail.</div><div style={{ textAlign: 'right' }}>Watch</div><div>Listed</div><div></div>
                </div>
                {visible.map((l) => (
                  <div key={l.item_id} className="grid-row" style={{ gridTemplateColumns: cols, opacity: l.status === 'Active' ? 1 : 0.5 }}>
                    <div>{l.image_url ? <img src={l.image_url} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 2 }} /> : null}</div>
                    <div>
                      <div style={{ fontWeight: 500 }}>{l.title}</div>
                      <div className="ink-faint" style={{ fontSize: '0.7rem' }}>#{l.item_id}{l.sku ? ` · SKU ${l.sku}` : ''}{l.status !== 'Active' ? ' · ENDED' : ''}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(l.price, l.currency)}</div>
                    <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{l.listing_type === 'Chinese' ? 'Auction' : l.listing_type === 'FixedPriceItem' ? 'Buy It Now' : l.listing_type || '—'}</div>
                    <div style={{ textAlign: 'right' }}>{l.quantity_available ?? '—'}</div>
                    <div style={{ textAlign: 'right' }}>{l.watch_count ?? 0}</div>
                    <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{l.start_time ? new Date(l.start_time).toLocaleDateString() : '—'}</div>
                    <div><a className="btn-icon" href={l.view_url} target="_blank" rel="noreferrer" title="View on eBay"><ExternalLink size={14} /></a></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
