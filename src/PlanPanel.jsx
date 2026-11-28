import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader, Lock } from 'lucide-react';
import { apiFetch } from './lib/supabase.js';
import { PLANS, PLAN_ORDER, FEATURE_PLAN, FEATURE_LABELS, hasFeature, planRank } from '../netlify/lib/plans.js';

// Plan & billing (Tyche Cards only): the plan badge in the header, the upgrade window, and the
// card shown in place of a feature the plan doesn't include. The server enforces the limits;
// any blocked request (402) opens the upgrade window with its explanation.

export function usePlan(enabled) {
  const [info, setInfo] = useState(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    const res = await apiFetch('/api/billing').catch(() => null);
    if (res?.ok) setInfo(await res.json());
  }, [enabled]);
  useEffect(() => {
    load();
    const again = () => load();
    window.addEventListener('tyche:plan-changed', again);
    window.addEventListener('focus', again);
    return () => { window.removeEventListener('tyche:plan-changed', again); window.removeEventListener('focus', again); };
  }, [load]);
  return info?.enabled ? info : null;   // null = no plans on this site (founder site) or still loading
}

async function go(body) {
  const res = await apiFetch('/api/billing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || `Billing failed (${res.status})`);
  window.location.href = data.url;
}

export function startCheckout(plan, interval) { return go({ action: 'checkout', plan, interval }); }

export function PlanBadge({ plan, onOpen }) {
  if (!plan) return null;
  const p = PLANS[plan.plan] || PLANS.free;
  const pct = plan.limit ? Math.min(1, plan.used / plan.limit) : 0;
  return (
    <button className="btn-ghost" onClick={onOpen} title="Plan & billing" style={{ padding: '6px 12px', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <b>{p.name}</b>
      <span style={{ display: 'inline-grid', gap: 2, minWidth: 74 }}>
        <span style={{ fontSize: '0.68rem' }} className={pct >= 0.9 ? 'accent-amber' : 'ink-dim'}>{plan.used} of {plan.limit.toLocaleString('en-US')} cards</span>
        <span style={{ height: 4, borderRadius: 2, background: 'var(--well)' }}><span style={{ display: 'block', height: 4, borderRadius: 2, width: `${pct * 100}%`, background: pct >= 0.9 ? 'var(--warn)' : 'var(--leaf)' }} /></span>
      </span>
    </button>
  );
}

export function PlanPanel({ plan, reason, onClose }) {
  const [yearly, setYearly] = useState(plan?.subscription?.interval === 'year');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!plan) return null;
  const current = plan.plan;
  const sub = plan.subscription;
  async function act(label, body) { setBusy(label); setErr(null); try { await go(body); } catch (e) { setErr(e.message); setBusy(null); } }
  // On document.body, above the app's sticky section bar and anything else on the page.
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400, padding: 12 }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="plan-title" className="bg-card-raised" onClick={(e) => e.stopPropagation()}
        style={{ padding: 20, width: '100%', maxWidth: 940, maxHeight: '100%', overflow: 'auto', display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 id="plan-title" className="display-font" style={{ margin: 0, fontSize: '1.3rem', flex: 1 }}>Plan & billing</h2>
          <button className="btn-icon" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        {reason && <div role="status" style={{ padding: '10px 12px', border: '1px solid var(--warn)', background: 'var(--warn-wash)', fontSize: '0.85rem' }}>{reason}</div>}
        <div style={{ fontSize: '0.88rem' }}>
          You're on <b>{PLANS[current].name}</b>{sub?.comped ? ' (complimentary)' : ''}. {plan.used} of {plan.limit.toLocaleString('en-US')} cards used this month; your count resets on the 1st.
          {sub?.cancelAtPeriodEnd && sub.renews && <> Your plan ends on {new Date(sub.renews).toLocaleDateString()}.</>}
          {!sub?.cancelAtPeriodEnd && sub?.renews && !sub.comped && <> Renews {new Date(sub.renews).toLocaleDateString()}.</>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div role="group" aria-label="Billing period" style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 999, padding: 3 }}>
            {[['Monthly', false], ['Yearly, 2 months free', true]].map(([l, v]) => (
              <button key={l} aria-pressed={yearly === v} onClick={() => setYearly(v)} className={yearly === v ? 'btn-primary' : 'btn-icon'} style={{ padding: '6px 12px', borderRadius: 999, fontSize: '0.78rem' }}>{l}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {sub?.hasBilling && !sub.comped && <button className="btn-ghost" disabled={!!busy} onClick={() => act('portal', { action: 'portal' })} style={{ padding: '8px 12px', fontSize: '0.8rem' }}>{busy === 'portal' ? <Loader size={13} className="spin" /> : 'Manage billing, card or cancel'}</button>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id];
            const isCurrent = id === current;
            const lower = planRank(id) < planRank(current);
            return (
              <div key={id} style={{ border: isCurrent ? '2px solid var(--leaf)' : '1px solid var(--line)', borderRadius: 14, padding: 14, display: 'grid', gap: 8, alignContent: 'start', minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                  <b style={{ fontSize: '1.05rem' }}>{p.name}</b>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>${yearly ? p.year : p.month}</b><span className="ink-faint" style={{ fontSize: '0.75rem' }}>{id === 'free' ? '' : yearly ? ' / yr' : ' / mo'}</span></span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem', display: 'grid', gap: 3 }} className="ink-dim">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                {isCurrent ? <span className="accent-green" style={{ fontSize: '0.8rem', fontWeight: 700 }}>Your plan</span>
                  : sub?.comped ? null
                  : id === 'free' ? (sub?.hasBilling ? <button className="btn-ghost" disabled={!!busy} onClick={() => act('portal', { action: 'portal' })} style={{ padding: '8px', fontSize: '0.8rem' }}>Cancel in billing</button> : null)
                  : <button className={lower ? 'btn-ghost' : 'btn-primary'} disabled={!!busy} onClick={() => act(id, { action: 'checkout', plan: id, interval: yearly ? 'year' : 'month' })} style={{ padding: '9px', fontSize: '0.82rem' }}>
                      {busy === id ? <Loader size={13} className="spin" /> : lower ? `Switch to ${p.name}` : `Upgrade to ${p.name}`}
                    </button>}
              </div>
            );
          })}
        </div>
        {err && <div className="accent-red" style={{ fontSize: '0.8rem' }}>{err}</div>}
        <div className="ink-faint" style={{ fontSize: '0.72rem' }}>Payments are handled by Stripe. Upgrades start right away; cancelling keeps your plan until the end of the period you paid for.</div>
      </div>
    </div>,
    document.body,
  );
}

// Shown in place of a section the plan doesn't include.
export function Locked({ feature, onUpgrade }) {
  const need = PLANS[FEATURE_PLAN[feature]];
  return (
    <div className="bg-card" style={{ padding: 32, maxWidth: 560, margin: '24px auto', textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
      <Lock size={26} className="ink-faint" />
      <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>{FEATURE_LABELS[feature]} is part of {need.name}</h2>
      <p className="ink-dim" style={{ margin: 0, fontSize: '0.9rem' }}>{need.name} is ${need.month} a month and includes {need.features.slice(1).join(', ').toLowerCase()}.</p>
      <button className="btn-primary" onClick={onUpgrade} style={{ padding: '10px 18px' }}>See plans</button>
    </div>
  );
}

export const locked = (plan, feature) => !!plan && !!feature && !hasFeature(plan.plan, feature);
