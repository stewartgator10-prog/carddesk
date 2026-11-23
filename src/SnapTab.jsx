import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader, Check, X, RefreshCw, AlertTriangle, ExternalLink, FlaskConical, DollarSign, Settings as Cog, Image as ImageIcon } from 'lucide-react';
import { supabase, apiFetch } from './lib/supabase.js';
import { resizeForUpload } from './lib/image.js';
import { buildTitle, summarizeTrial, REVIEW_LABELS, SNAP_DEFAULTS } from '../netlify/lib/snap-logic.js';
import { MODEL_LABELS, MODEL_PRICES, monthStart } from '../netlify/lib/ai-usage.js';

const money = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(d)}`);
const fee = (n) => (n == null ? '—' : Number(n) < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const OPEN = ['uploaded', 'identifying', 'ready', 'needs_review', 'failed', 'approved'];
const FINISHES = [['normal', 'Normal'], ['holo', 'Holo'], ['reverse_holo', 'Reverse holo'], ['foil', 'Foil'], ['unknown', 'Unknown']];
const CONDS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const STATUS = {
  uploaded: ['QUEUED', '#8a8a96'], identifying: ['READING…', '#fbbf24'], ready: ['READY', '#4ade80'],
  needs_review: ['CHECK', '#fbbf24'], failed: ['FAILED', '#ff6b6b'], approved: ['APPROVED', '#60a5fa'],
};

async function postJson(path, body) {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Runs async jobs a few at a time.
function useQueue(concurrency = 2) {
  const q = useRef([]);
  const running = useRef(0);
  const pump = useCallback(() => {
    while (running.current < concurrency && q.current.length) {
      const job = q.current.shift();
      running.current += 1;
      job().finally(() => { running.current -= 1; pump(); });
    }
  }, [concurrency]);
  return useCallback((job) => { q.current.push(job); pump(); }, [pump]);
}

export default function SnapTab({ userId, settings, setSettings }) {
  const s = { ...SNAP_DEFAULTS, ...settings };
  const [panel, setPanel] = useState('queue');
  const [items, setItems] = useState([]);
  const [photoUrls, setPhotoUrls] = useState({});
  const [filter, setFilter] = useState('open');
  const [msg, setMsg] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [usage, setUsage] = useState({ month: [], allTime: 0 });
  const fileInput = useRef(null);
  const enqueue = useQueue(2);
  const budgetHit = useRef(false);

  const loadItems = useCallback(async () => {
    const { data, error } = await supabase.from('snap_items').select('*').in('status', OPEN).order('created_at', { ascending: false }).limit(300);
    if (error) { setMsg({ type: 'error', text: `Couldn't load the queue: ${error.message}` }); return; }
    setItems(data || []);
  }, []);

  const loadUsage = useCallback(async () => {
    const [m, all] = await Promise.all([
      supabase.from('api_usage').select('created_at, model, purpose, cost_usd, input_tokens, output_tokens, latency_ms, ok, error')
        .gte('created_at', monthStart()).order('created_at', { ascending: false }).limit(5000),
      supabase.from('api_usage').select('cost_usd').limit(100000),
    ]);
    setUsage({ month: m.data || [], allTime: (all.data || []).reduce((t, r) => t + Number(r.cost_usd || 0), 0) });
  }, []);

  useEffect(() => { loadItems(); loadUsage(); }, [loadItems, loadUsage]);

  // Signed links for this user's private photos (valid for an hour).
  useEffect(() => {
    const need = items.map((i) => i.photo_path).filter((p) => p && !photoUrls[p]);
    if (!need.length) return;
    supabase.storage.from('snap-photos').createSignedUrls(need, 3600).then(({ data }) => {
      if (data) setPhotoUrls((u) => ({ ...u, ...Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl])) }));
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchLocal = (id, patch) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const identify = useCallback((id) => {
    patchLocal(id, { status: 'identifying', error: null });
    enqueue(async () => {
      if (budgetHit.current) { patchLocal(id, { status: 'uploaded' }); return; }
      const r = await postJson('/api/snap-identify', { id }).catch((e) => ({ ok: false, data: { error: e.message } }));
      if (r.ok) {
        patchLocal(id, r.data.item);
      } else {
        if (r.status === 429) budgetHit.current = true;
        patchLocal(id, { status: r.status === 429 ? 'uploaded' : 'failed', error: r.data.error || `Failed (${r.status})` });
        setMsg({ type: 'error', text: r.data.error || `Identify failed (${r.status})` });
      }
      loadUsage();
    });
  }, [enqueue, loadUsage]);

  async function addPhotos(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    budgetHit.current = false;
    setMsg(null);
    const batch = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const blob = await resizeForUpload(file);
        const id = crypto.randomUUID();
        const path = `${userId}/${batch}/${id}.jpg`;
        const up = await supabase.storage.from('snap-photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw new Error(up.error.message);
        const row = { id, user_id: userId, batch_id: batch, photo_path: path, status: 'uploaded' };
        const ins = await supabase.from('snap_items').insert(row);
        if (ins.error) throw new Error(ins.error.message);
        setPhotoUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }));
        setItems((xs) => [{ ...row, created_at: new Date().toISOString(), review_reasons: [] }, ...xs]);
        identify(id);
      } catch (e) {
        setMsg({ type: 'error', text: `Upload failed for ${file.name}: ${e.message}` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function save(id, patch) {
    patchLocal(id, patch);
    const { error } = await supabase.from('snap_items').update(patch).eq('id', id);
    if (error) setMsg({ type: 'error', text: `Couldn't save: ${error.message}` });
  }

  async function approve(item) {
    if (!(Number(item.price) > 0) || !item.title) { setMsg({ type: 'error', text: 'Set a price and title before approving.' }); return; }
    // Save what's on screen with the approval, in case a field was still being edited.
    await save(item.id, { status: 'approved', price: Number(item.price), title: item.title });
  }

  async function approveAllReady() {
    const ready = items.filter((i) => i.status === 'ready' && Number(i.price) > 0 && i.title);
    if (!ready.length) return;
    const ids = ready.map((i) => i.id);
    setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, status: 'approved' } : x)));
    const { error } = await supabase.from('snap_items').update({ status: 'approved' }).in('id', ids);
    setMsg(error ? { type: 'error', text: error.message } : { type: 'ok', text: `Approved ${ids.length} card${ids.length === 1 ? '' : 's'}. They'll be published to eBay in phase 2.` });
  }

  async function discard(item) {
    setItems((xs) => xs.filter((x) => x.id !== item.id));
    const { error } = await supabase.from('snap_items').update({ status: 'discarded' }).eq('id', item.id);
    if (error) { setMsg({ type: 'error', text: error.message }); loadItems(); }
  }

  const counts = useMemo(() => Object.fromEntries(OPEN.map((st) => [st, items.filter((i) => i.status === st).length])), [items]);
  const visible = items.filter((i) => (filter === 'open' ? i.status !== 'approved' : i.status === filter));
  const monthSpend = usage.month.reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const budget = Number(s.aiMonthlyBudget) || 0;

  const tabBtn = (key, icon, label) => (
    <button className="btn-ghost" onClick={() => setPanel(key)} style={{ padding: '8px 12px', fontSize: '0.75rem', display: 'inline-flex', gap: 6, alignItems: 'center', borderColor: panel === key ? '#ff4d4d' : undefined, color: panel === key ? '#ff4d4d' : undefined }}>{icon}{label}</button>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="bg-card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }}
          onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
        <button className="btn-primary" onClick={() => fileInput.current?.click()} style={{ padding: '14px 22px', fontSize: '1.1rem', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {uploading ? <Loader size={18} className="spin" /> : <Camera size={18} />} SNAP CARDS
        </button>
        <div className="ink-dim" style={{ fontSize: '0.75rem', flex: '1 1 220px' }}>
          One card per photo, front side, flat and in focus. Pick several from the camera roll at once for a batch.
          {uploading > 0 && <span className="accent-amber"> Uploading {uploading}…</span>}
        </div>
        <div style={{ fontSize: '0.75rem', textAlign: 'right' }}>
          <div className="ink-faint">AI THIS MONTH</div>
          <div style={{ fontWeight: 700 }} className={budget && monthSpend >= budget * 0.8 ? 'accent-amber' : ''}>{fee(monthSpend)}{budget ? ` / ${money(budget)}` : ''}</div>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tabBtn('queue', <ImageIcon size={14} />, `Review queue (${items.filter((i) => i.status !== 'approved').length})`)}
        {tabBtn('fees', <DollarSign size={14} />, 'API fees')}
        {tabBtn('trial', <FlaskConical size={14} />, 'Model trial')}
        {tabBtn('settings', <Cog size={14} />, 'Settings')}
      </div>

      {msg && <div style={{ padding: '10px 14px', border: `1px solid ${msg.type === 'error' ? '#f87171' : '#4ade80'}`, color: msg.type === 'error' ? '#f87171' : '#4ade80', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{msg.text}</span><button className="btn-icon" onClick={() => setMsg(null)}><X size={14} /></button></div>}

      {panel === 'queue' && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {[['open', `To do (${items.filter((i) => i.status !== 'approved').length})`], ['needs_review', `Check (${counts.needs_review})`], ['ready', `Ready (${counts.ready})`], ['failed', `Failed (${counts.failed})`], ['approved', `Approved (${counts.approved})`]].map(([k, l]) => (
              <button key={k} className="btn-ghost" onClick={() => setFilter(k)} style={{ padding: '6px 10px', fontSize: '0.7rem', borderColor: filter === k ? '#ff4d4d' : undefined, color: filter === k ? '#ff4d4d' : undefined }}>{l}</button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn-ghost" onClick={loadItems} title="Reload" style={{ padding: '6px 10px' }}><RefreshCw size={14} /></button>
            <button className="btn-primary" disabled={!counts.ready} onClick={approveAllReady} style={{ padding: '8px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Check size={14} /> APPROVE ALL READY ({counts.ready})</button>
          </div>
          {visible.length === 0 ? (
            <div className="bg-card ink-faint" style={{ padding: 48, textAlign: 'center' }}>
              {items.length ? 'Nothing here.' : 'No cards yet. Tap SNAP CARDS to photograph a stack.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {visible.map((it) => <SnapCard key={it.id} it={it} photo={photoUrls[it.photo_path]} onSave={save} onApprove={approve} onDiscard={discard} onRetry={() => identify(it.id)} />)}
            </div>
          )}
          <div className="ink-faint" style={{ fontSize: '0.7rem' }}>
            Phase 1 stops at Approved. Publishing approved cards to eBay with their photos is phase 2.
          </div>
        </>
      )}

      {panel === 'fees' && <FeePanel usage={usage} budget={budget} onReload={loadUsage} />}
      {panel === 'trial' && <TrialPanel settings={s} setSettings={setSettings} onUsage={loadUsage} />}
      {panel === 'settings' && <SnapSettings s={s} settings={settings} setSettings={setSettings} />}
    </div>
  );
}

function SnapCard({ it, photo, onSave, onApprove, onDiscard, onRetry }) {
  const [d, setD] = useState(it);
  useEffect(() => { setD(it); }, [it]);
  const [label, color] = STATUS[it.status] || [it.status, '#8a8a96'];
  const busy = it.status === 'identifying' || it.status === 'uploaded';
  const field = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const commit = (patch) => onSave(it.id, patch);
  const rebuildTitle = () => { const t = buildTitle(d); field('title', t); commit({ title: t }); };
  const inp = { padding: '6px 8px', fontSize: '0.8rem' };

  return (
    <div className="bg-card" style={{ padding: 12, display: 'grid', gap: 8, borderColor: it.status === 'needs_review' || it.status === 'failed' ? color : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem' }}>
        <span style={{ color, fontWeight: 700, letterSpacing: '0.1em' }}>{busy && <Loader size={11} className="spin" />} {label}</span>
        <span className="ink-faint">{it.model ? (MODEL_LABELS[it.model] || it.model) : ''}{it.confidence != null ? ` · ${Math.round(it.confidence * 100)}% sure` : ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <div style={{ aspectRatio: '5 / 7', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {photo ? <img src={photo} alt="Your photo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <Loader size={14} className="spin ink-faint" />}
        </div>
        <div style={{ aspectRatio: '5 / 7', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
          {it.catalog_image_url
            ? <img src={it.catalog_image_url} alt="Catalog match" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span className="ink-faint" style={{ fontSize: '0.7rem', textAlign: 'center', padding: 8 }}>{busy ? '' : 'No catalog match'}</span>}
          {it.catalog_source && <span style={{ position: 'absolute', bottom: 2, right: 4, fontSize: '0.6rem' }} className="ink-faint">{it.catalog_source}</span>}
        </div>
      </div>

      {it.error && <div className="accent-red" style={{ fontSize: '0.75rem' }}>{it.error}</div>}
      {(it.review_reasons || []).length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {it.review_reasons.map((r) => <span key={r} style={{ fontSize: '0.65rem', padding: '2px 6px', border: '1px solid #fbbf24', color: '#fbbf24' }}>{REVIEW_LABELS[r] || r}</span>)}
        </div>
      )}
      {it.duplicate_item_id && <a className="ink-dim" style={{ fontSize: '0.7rem' }} href={`https://www.ebay.com/itm/${it.duplicate_item_id}`} target="_blank" rel="noreferrer">Your listing #{it.duplicate_item_id} <ExternalLink size={10} /></a>}
      {it.misprint_flag && (
        <div style={{ fontSize: '0.75rem', padding: 6, border: '1px dashed #fbbf24' }}>
          <div className="accent-amber"><AlertTriangle size={11} /> AI noticed: {it.misprint_notes || 'possible misprint'}</div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', textTransform: 'none', letterSpacing: 0, margin: '4px 0 0', color: '#e8e8ed' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!d.misprint_confirmed} onChange={(e) => { field('misprint_confirmed', e.target.checked); commit({ misprint_confirmed: e.target.checked }); }} />
            I checked it: it's a real misprint (adds it to the title)
          </label>
        </div>
      )}

      {!busy && it.status !== 'failed' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
          <input className="bg-input" style={inp} value={d.card_name || ''} placeholder="Card name" onChange={(e) => field('card_name', e.target.value)} onBlur={() => commit({ card_name: d.card_name })} />
          <input className="bg-input" style={inp} value={d.catalog_number || d.collector_number || ''} placeholder="Number" onChange={(e) => field('catalog_number', e.target.value)} onBlur={() => commit({ catalog_number: d.catalog_number })} />
          <input className="bg-input" style={{ ...inp, gridColumn: 'span 2' }} value={d.catalog_set || d.set_name || ''} placeholder="Set" onChange={(e) => field('catalog_set', e.target.value)} onBlur={() => commit({ catalog_set: d.catalog_set })} />
          <select className="bg-input" style={inp} value={d.finish || 'unknown'} onChange={(e) => { field('finish', e.target.value); commit({ finish: e.target.value }); }}>{FINISHES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="bg-input" style={inp} value={d.condition || 'NM'} onChange={(e) => { field('condition', e.target.value); commit({ condition: e.target.value }); }}>{CONDS.map((c) => <option key={c}>{c}</option>)}</select>
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 4 }}>
            <input className="bg-input" style={{ ...inp, flex: 1 }} value={d.title || ''} placeholder="eBay title" maxLength={80} onChange={(e) => field('title', e.target.value)} onBlur={() => commit({ title: d.title })} />
            <button className="btn-icon" title="Rebuild title from the fields" onClick={rebuildTitle}><RefreshCw size={13} /></button>
          </div>
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.75rem' }}>
            <span className="ink-faint">Price $</span>
            <input className="bg-input" style={{ ...inp, width: 90 }} type="number" step="0.01" min="0.99" value={d.price ?? ''} onChange={(e) => field('price', e.target.value)} onBlur={() => commit({ price: d.price === '' ? null : Number(d.price) })} />
            {it.suggested_price != null && Number(d.price) !== Number(it.suggested_price) && <button className="btn-ghost" style={{ padding: '3px 6px', fontSize: '0.65rem' }} onClick={() => { field('price', it.suggested_price); commit({ price: it.suggested_price }); }}>Use {money(it.suggested_price)}</button>}
            <span className="ink-faint" title={it.price_source || ''}>market {money(it.market_price)}</span>
            {it.catalog_url && <a className="ink-faint" href={it.catalog_url} target="_blank" rel="noreferrer"><ExternalLink size={11} /></a>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        {it.status !== 'approved' && <button className="btn-primary" disabled={busy || it.status === 'failed'} onClick={() => onApprove({ ...it, ...d })} style={{ padding: '6px 10px', flex: 1, display: 'inline-flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}><Check size={13} /> Approve</button>}
        {it.status === 'approved' && <button className="btn-ghost" onClick={() => onSave(it.id, { status: 'needs_review' })} style={{ padding: '6px 10px', flex: 1, fontSize: '0.75rem' }}>Undo approve</button>}
        <button className="btn-ghost" disabled={busy || it.status === 'approved'} onClick={onRetry} title="Read the photo again (costs another AI call)" style={{ padding: '6px 10px' }}><RefreshCw size={13} /></button>
        <button className="btn-ghost" onClick={() => onDiscard(it)} title="Discard" style={{ padding: '6px 10px' }}><X size={13} /></button>
      </div>
    </div>
  );
}

function FeePanel({ usage, budget, onReload }) {
  const rows = usage.month;
  const total = rows.reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todaySpend = rows.filter((r) => r.created_at.slice(0, 10) === today).reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      const g = m.get(k) || { calls: 0, cost: 0, inTok: 0, outTok: 0 };
      g.calls += 1; g.cost += Number(r.cost_usd || 0); g.inTok += r.input_tokens || 0; g.outTok += r.output_tokens || 0;
      m.set(k, g);
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
  };
  const ids = rows.filter((r) => r.purpose === 'snap_identify' && r.ok);
  const perCard = ids.length ? ids.reduce((t, r) => t + Number(r.cost_usd || 0), 0) / ids.length : null;
  const usedPct = budget ? Math.min(1, total / budget) : null;

  return (
    <section className="bg-card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>API FEES · THIS MONTH</h2>
        <button className="btn-ghost" onClick={onReload} style={{ padding: '6px 10px' }}><RefreshCw size={14} /></button>
      </div>
      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: 16 }}>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>THIS MONTH</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(total)}</div><div className="ink-dim" style={{ fontSize: '0.7rem' }}>{budget ? `of ${money(budget)} budget` : 'no budget limit'}</div>
          {usedPct != null && <div style={{ height: 4, background: '#2a2a36', marginTop: 6 }}><div style={{ height: 4, width: `${usedPct * 100}%`, background: usedPct >= 0.8 ? '#fbbf24' : '#4ade80' }} /></div>}</div>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>TODAY</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(todaySpend)}</div></div>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>PER CARD IDENTIFIED</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(perCard)}</div><div className="ink-dim" style={{ fontSize: '0.7rem' }}>{ids.length} cards this month</div></div>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>ALL TIME</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(usage.allTime)}</div><div className="ink-dim" style={{ fontSize: '0.7rem' }}>{rows.length} calls this month</div></div>
      </div>
      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '0 16px 16px' }}>
        {[['model', 'By model'], ['purpose', 'By use']].map(([k, label]) => (
          <div key={k} style={{ border: '1px solid #2a2a36' }}>
            <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '8px 12px', letterSpacing: '0.1em' }}>{label.toUpperCase()}</div>
            {group(k).map(([name, g]) => (
              <div key={name} className="grid-row" style={{ gridTemplateColumns: '1fr 60px 80px', padding: '8px 12px' }}>
                <div>{k === 'model' ? (MODEL_LABELS[name] || name) : name === 'snap_identify' ? 'Snap to List' : name === 'model_trial' ? 'Model trial' : name}
                  <div className="ink-faint" style={{ fontSize: '0.65rem' }}>{(g.inTok / 1000).toFixed(1)}k in · {(g.outTok / 1000).toFixed(1)}k out tokens</div></div>
                <div className="ink-dim" style={{ textAlign: 'right' }}>{g.calls}</div>
                <div style={{ textAlign: 'right', fontWeight: 600 }}>{fee(g.cost)}</div>
              </div>
            ))}
            {!rows.length && <div className="ink-faint" style={{ padding: 12, fontSize: '0.8rem' }}>No AI calls yet this month.</div>}
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #2a2a36' }}>
        <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '10px 20px', letterSpacing: '0.1em' }}>RECENT CALLS</div>
        {rows.slice(0, 15).map((r, i) => (
          <div key={i} className="grid-row" style={{ gridTemplateColumns: '130px 1fr 70px 70px', fontSize: '0.75rem', padding: '6px 20px' }}>
            <div className="ink-faint">{new Date(r.created_at).toLocaleString()}</div>
            <div>{MODEL_LABELS[r.model] || r.model} · {r.purpose === 'snap_identify' ? 'snap' : 'trial'}{!r.ok && <span className="accent-red"> · failed</span>}</div>
            <div className="ink-dim" style={{ textAlign: 'right' }}>{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)}s` : ''}</div>
            <div style={{ textAlign: 'right' }}>{fee(r.cost_usd)}</div>
          </div>
        ))}
      </div>
      <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '12px 20px', borderTop: '1px solid #2a2a36' }}>
        Estimated from Anthropic's published per-token prices (Opus 5.5: ${MODEL_PRICES['claude-opus-5-5'].input}/${MODEL_PRICES['claude-opus-5-5'].output} per million input/output tokens; Haiku 5.5: ${MODEL_PRICES['claude-haiku-5-5'].input}/${MODEL_PRICES['claude-haiku-5-5'].output}). Your Anthropic Console invoice is the final number. Months are calendar months in UTC.
      </div>
    </section>
  );
}

function TrialPanel({ settings, setSettings, onUsage }) {
  const [rows, setRows] = useState([]);
  const [trialId, setTrialId] = useState(null);
  const [running, setRunning] = useState(null); // { done, total }
  const [err, setErr] = useState(null);
  const stop = useRef(false);

  const loadLatest = useCallback(async () => {
    const { data: last } = await supabase.from('model_trial_results').select('trial_id').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!last) return;
    const { data } = await supabase.from('model_trial_results').select('*').eq('trial_id', last.trial_id).order('item_id');
    setTrialId(last.trial_id); setRows(data || []);
  }, []);
  useEffect(() => { loadLatest(); }, [loadLatest]);

  async function run() {
    setErr(null);
    const res = await apiFetch('/api/snap-trial?n=30');
    const plan = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(plan.error || `Couldn't start (${res.status})`); return; }
    if (!plan.items?.length) { setErr('No Pokémon or Magic single listings with photos to test on. Sync your eBay listings first.'); return; }
    const est = plan.models.map((m) => `${MODEL_LABELS[m]} about ${fee(plan.estimate[m])}`).join(', ');
    if (!window.confirm(`Run ${plan.items.length} of your listing photos through both models?\n\nEstimated cost: ${est}.\n\nBilled to your Anthropic API key.`)) return;
    const id = `t${Date.now()}`;
    setTrialId(id); setRows([]); stop.current = false;
    const jobs = plan.items.flatMap((it) => plan.models.map((m) => ({ model: m, itemId: it.item_id })));
    let done = 0;
    setRunning({ done, total: jobs.length });
    const worker = async () => {
      while (jobs.length && !stop.current) {
        const j = jobs.shift();
        const r = await postJson('/api/snap-trial', { trialId: id, ...j }).catch((e) => ({ ok: false, data: { error: e.message } }));
        if (r.ok) setRows((xs) => [...xs, r.data.result]);
        else if (r.status === 429 || r.status === 503) { stop.current = true; setErr(r.data.error); }
        done += 1; setRunning({ done, total: done + jobs.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setRunning(null); onUsage();
  }

  const summary = useMemo(() => summarizeTrial(rows), [rows]);
  const byItem = useMemo(() => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.item_id)) m.set(r.item_id, { title: r.expected_title, image: r.image_url, listed: r.listed_price, market: r.market_price }); m.get(r.item_id)[r.model] = r; }
    return [...m.values()];
  }, [rows]);
  const misses = byItem.filter((x) => Object.keys(MODEL_LABELS).some((k) => x[k] && (x[k].error || !x[k].correct)));
  const ratios = byItem.map((x) => Number(x.listed) / Number(x.market)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;

  return (
    <section className="bg-card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>MODEL TRIAL</h2>
          <div className="ink-dim" style={{ fontSize: '0.75rem' }}>Runs up to 30 of your own eBay listing photos through both models and checks each answer against your listing title.</div>
        </div>
        {running
          ? <button className="btn-ghost" onClick={() => { stop.current = true; }} style={{ padding: '8px 14px' }}><Loader size={14} className="spin" /> {running.done}/{running.total} · Stop</button>
          : <button className="btn-primary" onClick={run} style={{ padding: '10px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><FlaskConical size={14} /> RUN TRIAL</button>}
      </div>
      {err && <div className="accent-red" style={{ padding: '10px 20px', fontSize: '0.8rem' }}>{err}</div>}
      {!rows.length ? <div className="ink-faint" style={{ padding: 32, textAlign: 'center', fontSize: '0.85rem' }}>No trial results yet.</div> : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 760 }}>
              <div className="grid-row" style={{ gridTemplateColumns: '170px repeat(5, 1fr) 90px 90px 70px 120px', fontSize: '0.65rem', letterSpacing: '0.08em', color: '#8a8a96' }}>
                <div>MODEL</div><div>FULLY RIGHT</div><div>NAME</div><div>NUMBER</div><div>SET</div><div>CATALOG</div><div style={{ textAlign: 'right' }}>PER CARD</div><div style={{ textAlign: 'right' }}>TOTAL</div><div style={{ textAlign: 'right' }}>TIME</div><div></div>
              </div>
              {summary.map((m) => (
                <div key={m.model} className="grid-row" style={{ gridTemplateColumns: '170px repeat(5, 1fr) 90px 90px 70px 120px' }}>
                  <div style={{ fontWeight: 600 }}>{MODEL_LABELS[m.model] || m.model}<div className="ink-faint" style={{ fontSize: '0.65rem' }}>{m.cards} cards{m.errors ? ` · ${m.errors} errors` : ''}</div></div>
                  <div style={{ fontWeight: 700 }} className={m.correct >= 0.9 ? 'accent-green' : 'accent-amber'}>{pct(m.correct)}</div>
                  <div>{pct(m.name)}</div><div>{pct(m.number)}</div><div>{pct(m.set)}</div><div>{pct(m.catalog)}</div>
                  <div style={{ textAlign: 'right' }}>{fee(m.costPerCard)}</div>
                  <div style={{ textAlign: 'right' }}>{fee(m.totalCost)}</div>
                  <div style={{ textAlign: 'right' }} className="ink-dim">{m.medianLatencyMs ? `${(m.medianLatencyMs / 1000).toFixed(1)}s` : '—'}</div>
                  <div style={{ textAlign: 'right' }}>{settings.snapModel === m.model
                    ? <span className="accent-green" style={{ fontSize: '0.7rem' }}>In use</span>
                    : <button className="btn-ghost" onClick={() => setSettings({ ...settings, snapModel: m.model })} style={{ padding: '4px 8px', fontSize: '0.7rem' }}>Use this model</button>}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="ink-dim" style={{ fontSize: '0.75rem', padding: '10px 20px', borderTop: '1px solid #1f1f2a' }}>
            Trial {trialId}. "Fully right" = card name and number both match your title (number only counts where the title has one).
            {medianRatio != null && <> Your listed prices are a median <strong>{medianRatio.toFixed(1)}×</strong> the catalog market price on these cards.</>}
          </div>
          {misses.length > 0 && (
            <div style={{ borderTop: '1px solid #2a2a36' }}>
              <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '10px 20px', letterSpacing: '0.1em' }}>CARDS A MODEL GOT WRONG ({misses.length})</div>
              {misses.map((x, i) => (
                <div key={i} className="grid-row" style={{ gridTemplateColumns: '48px 1.4fr 1fr 1fr', fontSize: '0.75rem', padding: '8px 20px' }}>
                  <img src={x.image} alt="" style={{ width: 44, height: 60, objectFit: 'contain', background: '#0a0a0f' }} />
                  <div>{x.title}</div>
                  {Object.keys(MODEL_LABELS).map((k) => {
                    const r = x[k];
                    if (!r) return <div key={k} />;
                    const e = r.extraction || {};
                    return <div key={k} className={r.correct ? 'ink-dim' : 'accent-red'}><span className="ink-faint">{MODEL_LABELS[k].replace('Claude ', '')}: </span>{r.error || `${e.card_name || '?'} ${e.collector_number || ''}`}</div>;
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SnapSettings({ s, settings, setSettings }) {
  const set = (k, v) => setSettings({ ...settings, [k]: v });
  return (
    <section className="bg-card" style={{ padding: 20, display: 'grid', gap: 12, maxWidth: 620 }}>
      <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>SNAP SETTINGS</h2>
      <div><label>AI model</label>
        <select className="bg-input" value={s.snapModel} onChange={(e) => set('snapModel', e.target.value)}>
          {Object.entries(MODEL_LABELS).map(([k, l]) => <option key={k} value={k}>{l} (${MODEL_PRICES[k].input} / ${MODEL_PRICES[k].output} per M tokens)</option>)}
        </select>
        <div className="ink-faint" style={{ fontSize: '0.7rem', marginTop: 4 }}>Run the model trial to compare accuracy and cost on your own cards.</div></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div><label>Markup over market %</label><input className="bg-input" type="number" step="1" value={s.snapMarkupPct} onChange={(e) => set('snapMarkupPct', e.target.value === '' ? 0 : Number(e.target.value))} /></div>
        <div><label>Minimum price $</label><input className="bg-input" type="number" step="0.01" value={s.snapMinPrice} onChange={(e) => set('snapMinPrice', e.target.value === '' ? 0 : Number(e.target.value))} /></div>
        <div><label>Price ending</label>
          <select className="bg-input" value={s.snapEnding} onChange={(e) => set('snapEnding', e.target.value)}>
            {[['0.89', '.89'], ['0.98', '.98'], ['0.99', '.99'], ['0.49', '.49'], ['cents', 'Exact cents']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
      </div>
      <div><label>Monthly AI budget $ (0 = no limit)</label><input className="bg-input" type="number" step="1" value={s.aiMonthlyBudget} onChange={(e) => set('aiMonthlyBudget', e.target.value === '' ? 0 : Number(e.target.value))} />
        <div className="ink-faint" style={{ fontSize: '0.7rem', marginTop: 4 }}>New AI calls stop when this month's estimated spend reaches the budget. Nothing already done is affected.</div></div>
      <div className="ink-faint" style={{ fontSize: '0.7rem' }}>Example: market $0.27 → {s.snapMinPrice ? `$${Number(s.snapMinPrice).toFixed(2)}` : ''} (minimum). Market $4.74 → rounded up to the {s.snapEnding === 'cents' ? 'cent' : `next ${s.snapEnding.slice(1)}`} after markup.</div>
    </section>
  );
}
