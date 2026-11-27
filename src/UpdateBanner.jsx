import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

/* global __BUILD_ID__ */
const MINE = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : null;

// A phone can keep CardDesk open for days. When a newer version is on the site, say so and offer a
// reload, so new features (and fixes) actually reach the open tab.
export default function UpdateBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!MINE || import.meta.env.DEV) return undefined;
    let live = true;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const { build } = await r.json();
        if (live && build && build !== MINE) setStale(true);
      } catch { /* offline: try again later */ }
    };
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('focus', vis);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', vis); };
  }, []);
  if (!stale) return null;
  return (
    <div role="status" style={{ position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 250, maxWidth: 520, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'center',
      padding: '10px 14px', borderRadius: 14, background: 'var(--paper)', border: '1.5px solid var(--leaf)', boxShadow: '0 6px 20px rgba(0,0,0,0.18)', fontSize: '0.85rem' }}>
      <span style={{ flex: 1 }}>CardDesk has been updated. Reload to get the newest version.</span>
      <button className="btn-primary" onClick={() => window.location.reload()} style={{ padding: '8px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><RefreshCw size={13} /> Reload</button>
    </div>
  );
}
