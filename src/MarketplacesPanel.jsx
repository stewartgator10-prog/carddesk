import React, { useCallback, useEffect, useState } from 'react';
import { Loader, Unlink, RefreshCw, Copy, ExternalLink, Store } from 'lucide-react';
import { apiFetch } from './lib/supabase.js';
import { askChoice, askConfirm } from './lib/dialog.jsx';
import { hasFeature } from '../netlify/lib/plans.js';
import { TOKEN_PAGE, TOKEN_PREFIX, WHATNOT_SCOPES } from '../netlify/lib/marketplaces/whatnot-info.js';

// Marketplaces other than eBay (Whatnot first). Shown under the eBay panel in Listings & Prices.
// The token is sent once to the server, sealed there and never sent back.

export const ago = (iso) => {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

async function call(method, body) {
  const res = await apiFetch('/api/marketplaces', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.code = data.code; throw e; }
  return data;
}

export async function checkSales() {
  const res = await apiFetch('/api/marketplace-sales', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Sale check failed (${res.status})`);
  return data;
}

// One line per marketplace at the top of the view, so Whatnot is in sight without scrolling past
// the eBay listings. It shows what the panel below last loaded (sent as a window event).
const PANEL_EVENT = 'tyche:marketplaces';
export function MarketplaceStrip({ ebay = null }) {
  const [wn, setWn] = useState(null);
  useEffect(() => {
    const on = (e) => setWn(e.detail || null);
    window.addEventListener(PANEL_EVENT, on);
    return () => window.removeEventListener(PANEL_EVENT, on);
  }, []);
  const jump = () => document.getElementById('whatnot-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const status = !wn ? 'Loading…' : !wn.connected ? 'Not connected' : wn.status === 'reconnect' ? 'Needs a new token' : `@${wn.username} · ${wn.activeCount} listed`;
  return (
    <nav aria-label="Your marketplaces" className="bg-card" style={{ padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: '0.8rem' }}>
      <span className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>MARKETPLACES</span>
      <span style={{ whiteSpace: 'nowrap' }}><b>eBay</b> · {ebay || 'Not connected'}</span>
      <span style={{ whiteSpace: 'nowrap', color: wn?.status === 'reconnect' ? 'var(--warn)' : undefined }}><b>Whatnot</b> · {status}</span>
      <button type="button" className="btn-ghost" onClick={jump} style={{ padding: '4px 10px', fontSize: '0.75rem', marginLeft: 'auto' }}>
        {wn && !wn.connected ? 'Connect Whatnot' : wn?.status === 'reconnect' ? 'Paste a new token' : 'Whatnot settings'}</button>
    </nav>
  );
}

export function salesSummary(r) {
  const parts = [r.newSales ? `${r.newSales} new sale${r.newSales === 1 ? '' : 's'}` : 'No new sales'];
  if (r.ended) parts.push(`${r.ended} listing${r.ended === 1 ? '' : 's'} taken down elsewhere`);
  return `${parts.join(', ')}.${r.problems?.length ? ` ${r.problems[0]}` : ''}`;
}

export default function MarketplacesPanel({ plan = null }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);
  const [token, setToken] = useState('');
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try { setList((await call('GET')).marketplaces || []); } catch (e) { setError(e.message); setList([]); }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, [load]);

  const wn = list?.find((m) => m.marketplace === 'whatnot') || { connected: false, activeCount: 0 };
  useEffect(() => { if (list != null) window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: wn })); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsPro = !!plan && !hasFeature(plan.plan, 'cross_list');

  async function connect() {
    const t = token.trim();
    setError(null); setNotice(null);
    if (!t.startsWith(TOKEN_PREFIX)) { setError(`That doesn't look like a Whatnot token. It starts with ${TOKEN_PREFIX}.`); return; }
    setBusy('connect');
    try {
      const { marketplace } = await call('POST', { action: 'connect', marketplace: 'whatnot', token: t });
      setToken('');
      setList((xs) => (xs || []).map((m) => (m.marketplace === 'whatnot' ? marketplace : m)));
      setNotice(`Whatnot connected as @${marketplace.username}. Approved and eBay cards now have "List on Whatnot" in Snap to List.`);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function checkNow() {
    setBusy('check'); setError(null); setNotice(null);
    try { const r = await checkSales(); setNotice(salesSummary(r)); await load(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function disconnect() {
    let endListings = false;
    if (wn.activeCount > 0) {
      const n = wn.activeCount;
      const pick = await askChoice(`You have ${n} card${n === 1 ? '' : 's'} up on Whatnot. If you disconnect, we stop watching ${n === 1 ? 'it' : 'them'} for sales, so a card could sell twice.`,
        [{ value: 'leave', label: 'Disconnect and leave them up' }, { value: 'end', label: 'End them on Whatnot, then disconnect' }], { title: 'Disconnect Whatnot' });
      if (!pick) return;
      endListings = pick === 'end';
    } else if (!(await askConfirm('Disconnect Whatnot? The saved token is deleted from Tyche Cards. Nothing changes in your Whatnot shop.', { title: 'Disconnect Whatnot', confirmLabel: 'Disconnect Whatnot', danger: true }))) return;
    setBusy('disconnect'); setError(null); setNotice(null);
    try {
      const r = await call('DELETE', { marketplace: 'whatnot', endListings });
      setList(r.marketplaces || []);
      setNotice(`Whatnot disconnected${r.ended ? `, ${r.ended} listing${r.ended === 1 ? '' : 's'} ended` : ''}.${r.problems?.length ? ` Not ended: ${r.problems.length}; take ${r.problems.length === 1 ? 'it' : 'them'} down in Whatnot.` : ''} Also delete the token on Whatnot's token page.`);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function saveProfile(id) {
    setBusy('settings'); setError(null);
    try { const { marketplace } = await call('POST', { action: 'settings', marketplace: 'whatnot', shippingProfileId: id || null }); setList((xs) => xs.map((m) => (m.marketplace === 'whatnot' ? marketplace : m))); setNotice('Shipping profile saved for new Whatnot listings.'); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const copyScopes = () => {
    const text = WHATNOT_SCOPES.join(' ');
    navigator.clipboard?.writeText(text).then(() => setNotice('Copied the permissions to tick.'), () => setNotice(`Tick: ${text}`));
  };

  const pasteForm = (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input className="bg-input" type="password" autoComplete="off" aria-label="Whatnot token" placeholder={`${TOKEN_PREFIX}…`} value={token}
        onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') connect(); }} style={{ flex: '1 1 200px', minWidth: 0 }} />
      <button className="btn-primary" onClick={connect} disabled={!!busy || !token.trim()} style={{ padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {busy === 'connect' ? <Loader size={14} className="spin" /> : null} Connect Whatnot
      </button>
    </div>
  );

  return (
    <section id="whatnot-panel" className="bg-card" aria-label="Whatnot" style={{ padding: 16, marginTop: 16, display: 'grid', gap: 10, scrollMarginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Store size={18} style={{ color: 'var(--accent)' }} />
        <h2 className="display-font" style={{ fontSize: '1.2rem', margin: 0 }}>WHATNOT</h2>
        <span className="ink-dim" style={{ fontSize: '0.8rem', flex: 1, minWidth: 140 }}>
          {list == null ? 'Loading…' : wn.connected
            ? <>Connected as <b>@{wn.username}</b> · last checked for sales {ago(wn.salesCheckedAt)} · {wn.activeCount} card{wn.activeCount === 1 ? '' : 's'} listed</>
            : 'Not connected'}
        </span>
        {wn.connected && <>
          <button className="btn-ghost" onClick={checkNow} disabled={!!busy} style={{ padding: '6px 10px', fontSize: '0.75rem', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {busy === 'check' ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />} Check for sales now</button>
          <button className="btn-ghost" onClick={disconnect} disabled={!!busy} title="Disconnect Whatnot" aria-label="Disconnect Whatnot" style={{ padding: '6px 10px', display: 'inline-flex', alignItems: 'center' }}><Unlink size={14} /></button>
        </>}
      </div>

      {notice && <div className="accent-green" role="status" style={{ fontSize: '0.8rem' }}>{notice}{/token page/.test(notice) && <> <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">Open it <ExternalLink size={10} /></a></>}</div>}
      {error && <div className="accent-red" role="alert" style={{ fontSize: '0.8rem' }}>{error}</div>}
      {list != null && wn.categoryReady === false && !needsPro && (
        <div className="accent-amber" role="status" style={{ fontSize: '0.8rem' }}>
          Listing on Whatnot isn't switched on yet: we're confirming Whatnot's card categories. You can connect now; List on Whatnot shows up on your cards as soon as it's on.
        </div>
      )}

      {list != null && !wn.connected && needsPro && (
        <div style={{ fontSize: '0.85rem' }}>
          <span className="ink-dim">List your cards in your Whatnot shop and we'll take them down everywhere else when they sell. </span>
          Whatnot listing is part of the Pro plan.{' '}
          <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            onClick={() => window.dispatchEvent(new CustomEvent('tyche:upgrade', { detail: { error: 'Listing on more marketplaces is part of the Pro plan.', feature: 'cross_list', need: 'pro' } }))}>See plans</button>
        </div>
      )}

      {list != null && !wn.connected && !needsPro && (
        <div style={{ display: 'grid', gap: 8, fontSize: '0.85rem' }}>
          <div className="ink-dim">List your cards in your Whatnot shop and we'll take them down everywhere else when they sell.</div>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li><a href={TOKEN_PAGE} target="_blank" rel="noreferrer">Open Whatnot's token page <ExternalLink size={11} /></a></li>
            <li>Create a token and tick: <code style={{ fontSize: '0.75rem', wordBreak: 'break-word' }}>{WHATNOT_SCOPES.join(', ')}</code>{' '}
              <button className="btn-icon" onClick={copyScopes} title="Copy the list" aria-label="Copy the list of permissions"><Copy size={12} /></button></li>
            <li>Choose 90 days or No expiry.</li>
            <li>Paste it here.</li>
          </ol>
          {pasteForm}
        </div>
      )}

      {wn.connected && wn.status === 'reconnect' && (
        <div style={{ display: 'grid', gap: 8, padding: 10, border: '1px solid var(--warn)' }}>
          <div className="accent-amber" style={{ fontSize: '0.85rem' }}>Whatnot stopped accepting your token, so we can't see Whatnot sales. Paste a new one.</div>
          {pasteForm}
        </div>
      )}

      {wn.connected && (wn.settings?.shippingProfiles || []).length > 1 && (
        <label className="ink-dim" style={{ fontSize: '0.75rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', textTransform: 'none', letterSpacing: 0 }}>
          Shipping profile for new Whatnot listings
          <select className="bg-input" style={{ padding: '4px 8px', fontSize: '0.8rem', width: 'auto', maxWidth: '100%' }} value={wn.settings.shippingProfileId || ''} disabled={!!busy}
            onChange={(e) => saveProfile(e.target.value)}>
            {wn.settings.shippingProfiles.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
          </select>
        </label>
      )}
    </section>
  );
}
