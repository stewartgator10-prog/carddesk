import React, { useEffect, useRef, useState } from 'react';
import { Camera, Loader, X, Star, ChevronLeft, ChevronRight, Crop, Wand2, Undo2, Trash2 } from 'lucide-react';
import { supabase } from './lib/supabase.js';

// A listing's photos: all of them in eBay order (main first). Tap one to choose what to do with it.
export function PhotoStrip({ it, paths, urls, max, busy, locked, onAdd, onOrder, onAuto, onAutoAll, onEdit, onUndo }) {
  const [sel, setSel] = useState(null);
  const input = useRef(null);
  const edits = it.photo_edits || {};
  useEffect(() => { if (sel && !paths.includes(sel)) setSel(null); }, [paths, sel]);
  const i = sel ? paths.indexOf(sel) : -1;
  const move = (to) => { const o = [...paths]; o.splice(i, 1); o.splice(to, 0, sel); onOrder(o); if (to === 0) setSel(null); };
  const small = { padding: '4px 8px', fontSize: '0.7rem', display: 'inline-flex', gap: 4, alignItems: 'center' };
  const pageOnly = !!it.photo_crop;
  const unedited = paths.filter((p, n) => !edits[p] && !(pageOnly && n === 0));

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: '0.7rem' }}>
      <div role="group" aria-label="Listing photos" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={input} type="file" accept="image/*" multiple aria-label="Add photos to this listing" style={{ display: 'none' }} onChange={(e) => { if (e.target.files.length) onAdd(e.target.files); e.target.value = ''; }} />
        {paths.map((p, n) => (
          <button key={p} type="button" onClick={() => setSel(sel === p ? null : p)} aria-pressed={sel === p}
            aria-label={`${n === 0 ? 'Main photo' : `Photo ${n + 1}`}${edits[p] ? ', straightened' : ''}`}
            style={{ position: 'relative', width: 44, height: 60, padding: 0, background: 'var(--well)', borderRadius: 6, flex: 'none', cursor: 'pointer', overflow: 'hidden',
              border: sel === p ? '2px solid var(--active)' : '1px solid var(--line)' }}>
            {urls[p] ? <img src={urls[p]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <Loader size={11} className="spin ink-faint" />}
            {n === 0 && <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: '0.5rem', fontWeight: 800, letterSpacing: '0.08em', background: 'var(--leaf)', color: '#fff' }}>MAIN</span>}
            {edits[p] && <span title="Straightened" style={{ position: 'absolute', top: 2, right: 2, width: 14, height: 14, borderRadius: '50%', background: 'var(--paper)', display: 'grid', placeItems: 'center' }}><Crop size={9} /></span>}
          </button>
        ))}
        {!locked && paths.length < max && (
          <button className="btn-ghost" onClick={() => input.current?.click()} style={small}><Camera size={12} /> Add photos</button>
        )}
        {!locked && !busy && onAutoAll && unedited.length > 0 && (
          <button className="btn-ghost" onClick={() => onAutoAll(unedited)} style={small} title="The AI straightens and crops each photo that isn't edited yet (about a cent each)">
            <Wand2 size={12} /> Auto-fix {unedited.length === 1 ? 'photo' : `all ${unedited.length}`}
          </button>
        )}
        {busy && <span className="ink-faint"><Loader size={11} className="spin" /> {busy}</span>}
        {!busy && !sel && <span className="ink-faint">{paths.length > 1 ? `${paths.length} photos, main first. Tap one to edit or move it.` : 'Tap the photo to straighten it. Add the back, corners, close-ups.'}</span>}
      </div>
      {sel && !locked && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', padding: 6, border: '1px dashed var(--line-strong)', borderRadius: 8 }}>
          <span className="ink-dim" style={{ marginRight: 2 }}>{i === 0 ? 'Main photo:' : `Photo ${i + 1}:`}</span>
          {!(pageOnly && i === 0) && <>
            <button className="btn-ghost" style={small} onClick={() => onEdit(sel)}><Crop size={12} /> Straighten &amp; crop</button>
            <button className="btn-ghost" style={small} disabled={!!busy} onClick={() => onAuto(sel)} title="The AI finds the card's corners (about a cent)"><Wand2 size={12} /> Auto-fix</button>
          </>}
          {edits[sel] && <button className="btn-ghost" style={small} onClick={() => onUndo(sel)}><Undo2 size={12} /> Undo edit</button>}
          {i > 0 && !pageOnly && <button className="btn-ghost" style={small} onClick={() => move(0)}><Star size={12} /> Make main</button>}
          {i > 0 && !(pageOnly && i === 1) && <button className="btn-icon" aria-label="Move left" title="Move left" onClick={() => move(i - 1)}><ChevronLeft size={14} /></button>}
          {i > 0 && i < paths.length - 1 && <button className="btn-icon" aria-label="Move right" title="Move right" onClick={() => move(i + 1)}><ChevronRight size={14} /></button>}
          {paths.length > 1 && !(pageOnly && i === 0) && <button className="btn-ghost" style={{ ...small, color: 'var(--bad)' }} onClick={() => onOrder(paths.filter((p) => p !== sel))}><Trash2 size={12} /> Remove</button>}
          <button className="btn-icon" aria-label="Close photo actions" onClick={() => setSel(null)}><X size={13} /></button>
        </div>
      )}
    </div>
  );
}

const DEFAULT = { tl: { x: 0.15, y: 0.1 }, tr: { x: 0.85, y: 0.1 }, br: { x: 0.85, y: 0.9 }, bl: { x: 0.15, y: 0.9 } };
const NAMES = { tl: 'top-left', tr: 'top-right', br: 'bottom-right', bl: 'bottom-left' };
const clamp = (v) => Math.max(0, Math.min(1, v));

// Drag the four handles onto the card's corners (or use arrow keys). Apply straightens the card and
// crops it to card shape so it fills the photo; outside the rounded corners turns white. The card
// itself is never retouched, and the original photo is kept.
export function PhotoEditor({ it, path, onApply, onAuto, onClose }) {
  const edit = (it.photo_edits || {})[path];
  const source = edit?.original || path;
  const [url, setUrl] = useState(null);
  const [c, setC] = useState(() => edit?.corners || (path === it.photo_path && !edit && it.extraction?.card_corners) || DEFAULT);
  const [active, setActive] = useState('tl');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const box = useRef(null);
  const drag = useRef(null);

  useEffect(() => {
    let live = true;
    supabase.storage.from('snap-photos').createSignedUrl(source, 3600).then(({ data, error }) => {
      if (!live) return;
      if (error || !data?.signedUrl) setErr(`Couldn't open the photo: ${error?.message || 'missing'}`); else setUrl(data.signedUrl);
    });
    return () => { live = false; };
  }, [source]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [busy, onClose]);

  const at = (e) => { const r = box.current.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }; };
  const down = (k) => (e) => { e.preventDefault(); setActive(k); drag.current = k; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const moveTo = (e) => { if (drag.current) { const p = at(e); setC((x) => ({ ...x, [drag.current]: p })); } };
  const up = () => { drag.current = null; };
  const nudge = (k) => (e) => {
    const d = e.shiftKey ? 0.02 : 0.004;
    const m = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
    if (!m) return;
    e.preventDefault();
    setC((x) => ({ ...x, [k]: { x: clamp(x[k].x + m[0]), y: clamp(x[k].y + m[1]) } }));
  };
  async function run(label, fn) {
    setBusy(label); setErr(null);
    try { await fn(); onClose(); } catch (e) { setErr(e.message); setBusy(null); }
  }
  const pts = ['tl', 'tr', 'br', 'bl'].map((k) => `${c[k].x},${c[k].y}`).join(' ');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 12 }}
      onPointerMove={moveTo} onPointerUp={up} onPointerCancel={up}>
      <div role="dialog" aria-modal="true" aria-labelledby="pe-title" className="bg-card-raised" style={{ padding: 16, width: '100%', maxWidth: 560, maxHeight: '100%', overflow: 'auto', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 id="pe-title" className="display-font" style={{ margin: 0, fontSize: '1.15rem', flex: 1 }}>Straighten &amp; crop</h2>
          <button className="btn-icon" aria-label="Close" disabled={!!busy} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ink-dim" style={{ fontSize: '0.8rem', lineHeight: 1.45 }}>
          Drag the four dots onto the card's corners{it.extraction?.graded ? ' (the slab\'s outer corners)' : ''}. For a rounded corner, put the dot where the two edges would meet. The card is straightened to fill the photo and everything outside it turns white. The card itself isn't retouched, and your original photo is kept.
        </div>
        <div style={{ textAlign: 'center', background: 'var(--well)', borderRadius: 8, padding: 8 }}>
          {url ? (
            <div ref={box} style={{ position: 'relative', display: 'inline-block', touchAction: 'none', userSelect: 'none' }}>
              <img src={url} alt="Original photo" draggable={false} style={{ display: 'block', maxWidth: '100%', maxHeight: '58vh' }} />
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <path d={`M0,0H1V1H0Z M${pts.split(' ').join(' L')}Z`} fill="rgba(20,30,25,0.55)" fillRule="evenodd" />
                <polygon points={pts} fill="none" stroke="#fff" strokeWidth="0.004" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 2 }} />
              </svg>
              {Object.keys(NAMES).map((k) => (
                <button key={k} type="button" aria-label={`Card's ${NAMES[k]} corner`} onPointerDown={down(k)} onKeyDown={nudge(k)} onFocus={() => setActive(k)}
                  style={{ position: 'absolute', left: `${c[k].x * 100}%`, top: `${c[k].y * 100}%`, width: 28, height: 28, margin: '-14px 0 0 -14px', borderRadius: '50%', padding: 0, cursor: 'grab', touchAction: 'none',
                    border: '3px solid #fff', background: active === k ? 'var(--accent)' : 'var(--leaf)', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }} />
              ))}
            </div>
          ) : err ? null : <Loader size={18} className="spin ink-faint" />}
        </div>
        <div className="ink-faint" style={{ fontSize: '0.7rem' }}>Tip: tap a dot, then use the arrow keys to nudge it (hold Shift for bigger steps).</div>
        {err && <div className="accent-red" style={{ fontSize: '0.8rem' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn-ghost" disabled={!!busy || !url} onClick={() => run('Finding the card…', () => onAuto(path))} style={{ padding: '9px 14px', display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 'auto' }}
            title="The AI finds the card's corners (about a cent)">{busy === 'Finding the card…' ? <Loader size={13} className="spin" /> : <Wand2 size={13} />} Auto-fix with AI</button>
          <button className="btn-ghost" disabled={!!busy} onClick={onClose} style={{ padding: '9px 14px' }}>Cancel</button>
          <button className="btn-primary" disabled={!!busy || !url} onClick={() => run('Straightening…', () => onApply(path, c))} style={{ padding: '9px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {busy === 'Straightening…' ? <Loader size={13} className="spin" /> : <Crop size={13} />} Apply
          </button>
        </div>
      </div>
    </div>
  );
}
