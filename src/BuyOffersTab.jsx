import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Grid3x3, Loader, X, Check, ChevronLeft, Eye, Plus } from 'lucide-react';
import { supabase, apiFetch } from './lib/supabase.js';
import { resizeForUpload } from './lib/image.js';
import CropImg from './lib/CropImg.jsx';
import { offerOf, marketOf, offerTotals, tiersFrom, OFFER_FLAG_LABELS } from '../netlify/lib/offer-logic.js';

const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const CONDS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const SOURCE = { tcgplayer: 'TCGplayer', ebay_median: 'eBay listings' };

async function postJson(path, body) {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export default function BuyOffersTab({ userId, settings, setSettings, onGoToSnap }) {
  const tiers = tiersFrom(settings);
  const [offers, setOffers] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [msg, setMsg] = useState(null);

  const loadOffers = useCallback(async () => {
    const { data, error } = await supabase.from('buy_offers').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) setMsg({ type: 'error', text: error.message }); else setOffers(data || []);
  }, []);
  useEffect(() => { loadOffers(); }, [loadOffers]);

  async function newOffer() {
    const id = crypto.randomUUID();
    const name = `Offer ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    const { error } = await supabase.from('buy_offers').insert({ id, user_id: userId, name });
    if (error) { setMsg({ type: 'error', text: error.message }); return; }
    await loadOffers();
    setOpenId(id);
  }

  if (openId) {
    return <OfferDetail key={openId} offer={offers.find((o) => o.id === openId)} userId={userId} tiers={tiers} settings={settings} setSettings={setSettings}
      onBack={() => { setOpenId(null); loadOffers(); }} onChanged={loadOffers} onGoToSnap={onGoToSnap} />;
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="bg-card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={newOffer} style={{ padding: '14px 22px', fontSize: '1.1rem', display: 'inline-flex', gap: 8, alignItems: 'center' }}><Plus size={18} /> NEW BUY OFFER</button>
        <div className="ink-dim" style={{ fontSize: '0.75rem', flex: '1 1 240px' }}>Photograph a binder page (up to 9 cards) or single cards, get each card's market value and a tiered offer, show the seller, and accept to record the purchase and queue the cards for listing.</div>
      </section>
      {msg && <div className="accent-red" style={{ fontSize: '0.8rem' }}>{msg.text}</div>}
      <section className="bg-card" style={{ padding: 0 }}>
        {offers.length === 0 ? <div className="ink-faint" style={{ padding: 40, textAlign: 'center' }}>No offers yet.</div> : offers.map((o) => (
          <button key={o.id} className="grid-row" onClick={() => setOpenId(o.id)} style={{ gridTemplateColumns: 'minmax(0,1fr) 90px 90px', width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--line-soft)', color: 'inherit', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}>
            <div>{o.name}<div className="ink-faint" style={{ fontSize: '0.65rem' }}>{new Date(o.created_at).toLocaleString()}</div></div>
            <div style={{ fontSize: '0.7rem', color: o.status === 'accepted' ? 'var(--good)' : o.status === 'declined' ? 'var(--ink-dim)' : 'var(--warn)' }}>{o.status.toUpperCase()}</div>
            <div style={{ textAlign: 'right', fontWeight: 600 }}>{o.final_offer != null ? money(o.final_offer) : ''}</div>
          </button>
        ))}
      </section>
    </div>
  );
}

function OfferDetail({ offer, userId, tiers, settings, setSettings, onBack, onChanged, onGoToSnap }) {
  const [items, setItems] = useState([]);
  const [urls, setUrls] = useState({});
  const [busy, setBusy] = useState(0);
  const [msg, setMsg] = useState(null);
  const [sheet, setSheet] = useState(false);
  const [showTiers, setShowTiers] = useState(false);
  const [finalOffer, setFinalOffer] = useState('');
  const [status, setStatus] = useState(offer?.status || 'draft');
  const pageInput = useRef(null);
  const singleInput = useRef(null);
  const queue = useRef(Promise.resolve());
  const locked = status !== 'draft';

  const load = useCallback(async () => {
    const { data } = await supabase.from('buy_offer_items').select('*').eq('offer_id', offer.id).order('position');
    setItems(data || []);
  }, [offer.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const need = [...new Set(items.map((i) => i.photo_path))].filter((p) => !urls[p]);
    if (!need.length) return;
    supabase.storage.from('snap-photos').createSignedUrls(need, 3600).then(({ data }) => {
      if (data) setUrls((u) => ({ ...u, ...Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl])) }));
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => offerTotals(items, tiers), [items, tiers]);

  function addPhotos(files, kind) {
    for (const file of [...files].filter((f) => f.type.startsWith('image/'))) {
      setBusy((n) => n + 1);
      // One photo at a time: each is one AI call; keeps the order of the binder pages.
      queue.current = queue.current.then(async () => {
        try {
          const blob = await resizeForUpload(file);
          const path = `${userId}/offers/${offer.id}/${crypto.randomUUID()}.jpg`;
          const up = await supabase.storage.from('snap-photos').upload(path, blob, { contentType: 'image/jpeg' });
          if (up.error) throw new Error(up.error.message);
          setUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }));
          const r = await postJson('/api/buy-offer', { action: 'identify', offerId: offer.id, photoPath: path, kind });
          if (!r.ok) throw new Error(r.data.error || `Failed (${r.status})`);
          setItems((xs) => [...xs, ...r.data.items]);
          if (!r.data.cards_found) setMsg({ type: 'error', text: 'No cards found in that photo.' });
        } catch (e) { setMsg({ type: 'error', text: e.message }); }
        finally { setBusy((n) => n - 1); }
      });
    }
  }

  async function patch(id, p) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
    const { error } = await supabase.from('buy_offer_items').update(p).eq('id', id);
    if (error) setMsg({ type: 'error', text: error.message });
  }

  async function accept() {
    const paid = finalOffer === '' ? totals.offer : Number(finalOffer);
    if (!window.confirm(`Record this deal?\n\nPaid: $${paid.toFixed(2)} for ${totals.cards} cards (market $${totals.market.toFixed(2)}).\n\nCreates a purchase split across the cards by market value and puts the cards in the Snap to List queue.`)) return;
    const r = await postJson('/api/buy-offer', { action: 'accept', offerId: offer.id, finalOffer: finalOffer === '' ? null : Number(finalOffer) });
    if (!r.ok) { setMsg({ type: 'error', text: r.data.error || `Failed (${r.status})` }); return; }
    setStatus('accepted'); setSheet(false); onChanged();
    setMsg({ type: 'ok', text: `Deal recorded: $${r.data.paid.toFixed(2)} for ${r.data.cards} cards. They're in the Snap to List queue with their cost.` });
  }
  async function decline() {
    const { error } = await supabase.from('buy_offers').update({ status: 'declined', total_market: totals.market, total_offer: totals.offer }).eq('id', offer.id);
    if (error) setMsg({ type: 'error', text: error.message }); else { setStatus('declined'); setSheet(false); onChanged(); }
  }

  const setTier = (k, v) => setSettings({ ...settings, [k]: v });

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={onBack} style={{ padding: '6px 10px', display: 'inline-flex', gap: 4, alignItems: 'center' }}><ChevronLeft size={14} /> Offers</button>
        <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem', flex: 1 }}>{offer.name}</h2>
        <span style={{ fontSize: '0.7rem', color: status === 'accepted' ? 'var(--good)' : status === 'declined' ? 'var(--ink-dim)' : 'var(--warn)' }}>{status.toUpperCase()}</span>
      </div>

      {!locked && (
        <section className="bg-card" style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={pageInput} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { addPhotos(e.target.files, 'page'); e.target.value = ''; }} />
          <input ref={singleInput} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }} onChange={(e) => { addPhotos(e.target.files, 'single'); e.target.value = ''; }} />
          <button className="btn-primary" onClick={() => pageInput.current?.click()} style={{ padding: '12px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Grid3x3 size={16} /> BINDER PAGE</button>
          <button className="btn-ghost" onClick={() => singleInput.current?.click()} style={{ padding: '12px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Camera size={16} /> Single card</button>
          <span className="ink-dim" style={{ fontSize: '0.7rem', flex: '1 1 200px' }}>
            {busy ? <span className="accent-amber"><Loader size={12} className="spin" /> Reading {busy} photo{busy === 1 ? '' : 's'}…</span> : 'Binder page: up to 9 cards, flat and glare-free. Use single cards for anything valuable or unclear.'}
          </span>
        </section>
      )}

      {msg && <div style={{ padding: '8px 12px', border: `1px solid ${msg.type === 'error' ? 'var(--bad)' : 'var(--good)'}`, color: msg.type === 'error' ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{msg.text}{msg.type === 'ok' && onGoToSnap && <> <button className="btn-icon" style={{ color: 'inherit', textDecoration: 'underline', fontSize: 'inherit' }} onClick={onGoToSnap}>Open Snap to List</button></>}</span>
        <button className="btn-icon" onClick={() => setMsg(null)}><X size={14} /></button></div>}

      <section className="bg-card" style={{ padding: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div><div className="ink-faint" style={{ fontSize: '0.65rem' }}>CARDS</div><div style={{ fontWeight: 700 }}>{totals.cards}{totals.unpriced ? <span className="accent-amber" style={{ fontSize: '0.7rem' }}> · {totals.unpriced} unpriced</span> : ''}</div></div>
        <div><div className="ink-faint" style={{ fontSize: '0.65rem' }}>MARKET</div><div style={{ fontWeight: 700 }}>{money(totals.market)}</div></div>
        <div><div className="ink-faint" style={{ fontSize: '0.65rem' }}>OFFER</div><div style={{ fontWeight: 700, fontSize: '1.3rem' }} className="accent-green">{money(totals.offer)}</div></div>
        <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{totals.pct_of_market != null ? `${totals.pct_of_market}% of market` : ''}</div>
        <span style={{ flex: 1 }} />
        {!locked && <button className="btn-ghost" onClick={() => setShowTiers((x) => !x)} style={{ padding: '6px 10px', fontSize: '0.7rem' }}>Offer rules</button>}
        {!locked && <button className="btn-primary" disabled={!items.length || busy > 0} onClick={() => setSheet(true)} style={{ padding: '10px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Eye size={14} /> SHOW SELLER</button>}
      </section>

      {showTiers && !locked && (
        <section className="bg-card" style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, fontSize: '0.75rem' }}>
          {[['offerBulkUnder', 'Bulk under $'], ['offerBulkFlat', 'Bulk offer $ each'], ['offerMidPct', 'Mid % of market'], ['offerHighFrom', 'High from $'], ['offerHighPct', 'High % of market']].map(([k, l]) => (
            <div key={k}><label htmlFor={`t-${k}`}>{l}</label><input id={`t-${k}`} className="bg-input" type="number" step="0.01" min="0" value={tiers[k]} onChange={(e) => setTier(k, e.target.value === '' ? 0 : Number(e.target.value))} /></div>
          ))}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', textTransform: 'none', letterSpacing: 0, color: 'var(--ink)' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!tiers.offerRoundTotal} onChange={(e) => setTier('offerRoundTotal', e.target.checked)} /> Round total down to $1</label>
        </section>
      )}

      {items.length === 0 ? <div className="bg-card ink-faint" style={{ padding: 40, textAlign: 'center' }}>{busy ? 'Reading…' : 'No cards yet. Photograph a binder page or single cards.'}</div> : (
        <section className="bg-card" style={{ padding: 0 }}>
          {items.map((it) => {
            const m = marketOf(it); const o = offerOf(it, tiers);
            return (
              <div key={it.id} className="grid-row" style={{ gridTemplateColumns: '22px 46px minmax(0,1fr) 78px 78px', gap: 6, padding: '8px 10px', opacity: it.included === false ? 0.4 : 1 }}>
                <input type="checkbox" aria-label="Include in offer" style={{ width: 'auto' }} disabled={locked} checked={it.included !== false} onChange={(e) => patch(it.id, { included: e.target.checked })} />
                <CropImg url={urls[it.photo_path]} box={it.source === 'page' ? it.box : null} alt={it.card_name} />
                <div style={{ minWidth: 0, fontSize: '0.78rem' }}>
                  <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{it.card_name}</div>
                  <div className="ink-faint" style={{ fontSize: '0.65rem', overflowWrap: 'anywhere' }}>{[it.catalog_set || it.set_name, it.catalog_number || it.collector_number, it.language !== 'English' ? it.language : null].filter(Boolean).join(' · ')}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2, alignItems: 'center' }}>
                    <select className="bg-input" aria-label="Condition" disabled={locked} value={it.condition || 'NM'} onChange={(e) => patch(it.id, { condition: e.target.value })} style={{ width: 62, padding: '2px 4px', fontSize: '0.7rem' }}>{CONDS.map((c) => <option key={c}>{c}</option>)}</select>
                    {(it.flags || []).filter((f) => f !== 'ebay_median').map((f) => <span key={f} style={{ fontSize: '0.6rem', padding: '1px 4px', border: '1px solid var(--warn)', color: 'var(--warn)' }}>{OFFER_FLAG_LABELS[f] || f}</span>)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <input className="bg-input" aria-label="Market value" type="number" step="0.01" min="0" disabled={locked} value={it.market_override ?? it.market_price ?? ''} placeholder="market"
                    onChange={(e) => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, market_override: e.target.value === '' ? null : e.target.value } : x)))}
                    onBlur={(e) => patch(it.id, { market_override: e.target.value === '' || Number(e.target.value) === Number(it.market_price) ? null : Number(e.target.value) })} style={{ padding: '4px 6px', fontSize: '0.75rem', textAlign: 'right' }} />
                  <div className="ink-faint" style={{ fontSize: '0.6rem' }}>{it.market_override != null ? 'yours' : SOURCE[it.market_source] || ''}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <input className="bg-input" aria-label="Offer" type="number" step="0.01" min="0" disabled={locked} value={it.offer_override ?? (o ?? '')} placeholder="offer"
                    onChange={(e) => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, offer_override: e.target.value === '' ? null : e.target.value } : x)))}
                    onBlur={(e) => patch(it.id, { offer_override: e.target.value === '' || Number(e.target.value) === offerOf({ ...it, offer_override: null }, tiers) ? null : Number(e.target.value) })} style={{ padding: '4px 6px', fontSize: '0.75rem', textAlign: 'right', color: 'var(--good)' }} />
                  <div className="ink-faint" style={{ fontSize: '0.6rem' }}>{m ? `${Math.round(((o || 0) / m) * 100)}%` : ''}</div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {sheet && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--sheet)', zIndex: 60, overflowY: 'auto', padding: 16 }}>
          <div className="bg-card" style={{ maxWidth: 640, margin: '0 auto', display: 'grid', gap: 12, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 className="display-font" style={{ margin: 0, fontSize: '1.6rem' }}>OUR OFFER</h2>
              <button className="btn-ghost" onClick={() => setSheet(false)} style={{ padding: '6px 10px' }}>Back</button>
            </div>
            {items.filter((i) => i.included !== false).map((it) => (
              <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '54px minmax(0,1fr) 72px 72px', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--line-soft)', paddingBottom: 8 }}>
                <CropImg url={urls[it.photo_path]} box={it.source === 'page' ? it.box : null} alt={it.card_name} />
                <div style={{ fontSize: '0.85rem', minWidth: 0 }}><div style={{ overflowWrap: 'anywhere' }}>{it.card_name}</div><div className="ink-faint" style={{ fontSize: '0.7rem' }}>{[it.catalog_set || it.set_name, it.catalog_number || it.collector_number, it.condition].filter(Boolean).join(' · ')}</div></div>
                <div style={{ textAlign: 'right', fontSize: '0.8rem' }}><div className="ink-faint" style={{ fontSize: '0.6rem' }}>MARKET</div>{money(marketOf(it))}</div>
                <div style={{ textAlign: 'right', fontSize: '0.9rem', fontWeight: 700 }} className="accent-green"><div className="ink-faint" style={{ fontSize: '0.6rem', fontWeight: 400 }}>OFFER</div>{money(offerOf(it, tiers))}</div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 0' }}>
              <div className="ink-dim">{totals.cards} cards · market {money(totals.market)}</div>
              <div style={{ fontSize: '2.4rem', fontWeight: 700 }} className="accent-green">{money(totals.offer)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'end' }}>
              <div><label htmlFor="final-offer">Agreed amount $ (if different)</label><input id="final-offer" className="bg-input" type="number" step="0.01" min="0" value={finalOffer} placeholder={totals.offer.toFixed(2)} onChange={(e) => setFinalOffer(e.target.value)} /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-ghost" onClick={decline} style={{ flex: 1, padding: 12 }}>Declined</button>
                <button className="btn-primary" onClick={accept} style={{ flex: 1, padding: 12, display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}><Check size={16} /> ACCEPTED</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
