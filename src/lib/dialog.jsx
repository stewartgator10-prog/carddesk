import React, { useEffect, useRef, useState } from 'react';

// In-page confirmation and question dialogs, used instead of the browser's own pop-ups
// (window.confirm / window.prompt). Those pop-ups sit outside the page, so browser agents such as
// Muse or Grok can't read or click them, and a click on "publish" just stalls. These dialogs are
// ordinary page content: a person or an agent reads the question and clicks a named button.
//
//   if (!(await askConfirm('Publish 3 listings?', { confirmLabel: 'Publish 3 to eBay' }))) return;
//   const total = await askValue('Total you paid ($):', { inputMode: 'decimal' });   // null when cancelled

let show = null;
const queue = [];

function open(req) {
  return new Promise((resolve) => {
    const item = { ...req, resolve };
    if (show) show(item); else queue.push(item);
  });
}

export const askConfirm = (message, { title = 'Please confirm', confirmLabel = 'Yes, continue', cancelLabel = 'Cancel', danger = false } = {}) =>
  open({ kind: 'confirm', message, title, confirmLabel, cancelLabel, danger });

export const askValue = (message, { title = 'One more detail', confirmLabel = 'OK', cancelLabel = 'Cancel', placeholder = '', inputMode = 'text', initial = '' } = {}) =>
  open({ kind: 'value', message, title, confirmLabel, cancelLabel, placeholder, inputMode, initial });

// Several named choices; resolves to the chosen value, or null when cancelled.
export const askChoice = (message, choices, { title = 'Choose', cancelLabel = 'Cancel' } = {}) =>
  open({ kind: 'choice', message, title, choices, cancelLabel });

// Mount once, near the top of the app.
export function DialogHost() {
  const [req, setReq] = useState(null);
  const [value, setValue] = useState('');
  const confirmRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    show = (item) => { setValue(item.initial || ''); setReq(item); };
    if (queue.length) show(queue.shift());
    return () => { show = null; };
  }, []);

  useEffect(() => {
    if (!req) return undefined;
    (req.kind === 'value' ? inputRef : confirmRef).current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  function close(answer) {
    const r = req;
    setReq(null);
    r?.resolve(answer);
    if (queue.length) setTimeout(() => show?.(queue.shift()), 0);
  }
  if (!req) return null;

  const yes = () => close(req.kind === 'value' ? value : true);
  const no = () => close(req.kind === 'confirm' ? false : null);
  const lines = String(req.message).split('\n');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) no(); }}>
      <div role={req.kind === 'confirm' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="cd-dialog-title" aria-describedby="cd-dialog-message"
        data-dialog={req.kind} className="bg-card-raised" style={{ padding: 22, width: '100%', maxWidth: 440 }}>
        <h2 id="cd-dialog-title" className="display-font" style={{ margin: '0 0 10px', fontSize: '1.25rem' }}>{req.title}</h2>
        <div id="cd-dialog-message" style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
          {lines.map((l, i) => (l.trim() ? <p key={i} style={{ margin: '0 0 6px' }}>{l}</p> : null))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (req.kind !== 'choice') yes(); }} style={{ marginTop: 14 }}>
          {req.kind === 'value' && (
            <input ref={inputRef} className="bg-input" aria-label={req.message} value={value} placeholder={req.placeholder} inputMode={req.inputMode}
              onChange={(e) => setValue(e.target.value)} style={{ marginBottom: 14 }} />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="btn-ghost" onClick={no} style={{ padding: '10px 16px' }}>{req.cancelLabel}</button>
            {req.kind === 'choice' && req.choices.map((c, i) => (
              <button key={c.value} type="button" ref={i === 0 ? confirmRef : undefined} className={i === req.choices.length - 1 ? 'btn-primary' : 'btn-ghost'}
                onClick={() => close(c.value)} style={{ padding: '10px 16px' }}>{c.label}</button>
            ))}
            {req.kind !== 'choice' && <button type="submit" ref={confirmRef} className="btn-primary"
              style={{ padding: '10px 18px', ...(req.danger ? { background: 'var(--accent)', boxShadow: '0 3px 0 #a33a29' } : {}) }}>{req.confirmLabel}</button>}
          </div>
        </form>
      </div>
    </div>
  );
}
