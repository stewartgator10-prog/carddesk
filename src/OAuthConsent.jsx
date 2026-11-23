import React, { useEffect, useState } from 'react';
import { supabase } from './lib/supabase.js';

// /oauth/consent: shown when an AI app (e.g. the Claude app) asks to connect to CardDesk.
// Supabase Auth runs the OAuth 2.1 flow; this page only shows who is asking and records the answer.
const shell = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'linear-gradient(180deg, #0a0a0f 0%, #12121a 100%)', color: '#e8e8ed', fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace' };
const card = { background: '#1c1c28', border: '1px solid #2a2a36', padding: 24, width: '100%', maxWidth: 440 };
const btn = (primary) => ({ flex: 1, padding: 12, border: primary ? 'none' : '1px solid #2a2a36', background: primary ? '#ff4d4d' : 'transparent', color: primary ? '#fff' : '#e8e8ed', cursor: 'pointer', fontFamily: '"Bebas Neue", sans-serif', letterSpacing: '0.08em', fontSize: '1rem' });

const ABILITIES = [
  'See your Snap to List queue, sales, profit and AI fees',
  'Edit cards in the queue: names, conditions, prices, costs; approve or discard them',
  'Run eBay\'s free listing check on approved cards',
  'Publish checked cards to eBay, only after you say yes in the chat',
];

export default function OAuthConsent({ session }) {
  const authorizationId = new URLSearchParams(window.location.search).get('authorization_id');
  const [details, setDetails] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authorizationId) { setError('This link is missing its authorization id. Start the connection again from the Claude app.'); return; }
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: e }) => {
      if (e || !data) { setError(e?.message || 'This connection request is invalid or expired. Start again from the Claude app.'); return; }
      if (!('authorization_id' in data) && data.redirect_url) { window.location.href = data.redirect_url; return; } // already approved before
      setDetails(data);
    });
  }, [authorizationId]);

  async function decide(approve) {
    setBusy(true); setError(null);
    const { error: e } = approve
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId);
    // On success Supabase sends the browser back to the app that asked.
    if (e) { setError(e.message); setBusy(false); }
  }

  let redirectHost = '';
  try { redirectHost = details?.redirect_uri ? new URL(details.redirect_uri).host : ''; } catch { /* ignore */ }

  return (
    <div style={shell}>
      <div style={card}>
        <h1 style={{ margin: 0, color: '#ff4d4d', fontFamily: '"Bebas Neue", sans-serif', letterSpacing: '0.04em', fontSize: '2rem' }}>CARDDESK</h1>
        {error ? <p style={{ color: '#ff6b6b', fontSize: '0.85rem' }}>{error}</p> : !details ? <p style={{ color: '#8a8a96' }}>Loading…</p> : (
          <>
            <h2 style={{ fontSize: '1.1rem', margin: '12px 0 4px' }}>Connect {details.client?.name || 'an app'} to your CardDesk?</h2>
            <div style={{ color: '#8a8a96', fontSize: '0.75rem', marginBottom: 12 }}>
              Signed in as {session.user.email}{redirectHost ? ` · will return to ${redirectHost}` : ''}
            </div>
            <div style={{ fontSize: '0.8rem', marginBottom: 6 }}>It will be able to:</div>
            <ul style={{ fontSize: '0.8rem', lineHeight: 1.6, paddingLeft: 18, marginTop: 0 }}>
              {ABILITIES.map((a) => <li key={a}>{a}</li>)}
            </ul>
            <div style={{ color: '#8a8a96', fontSize: '0.7rem', marginBottom: 16 }}>
              It acts as you and can't see other people's data. You can disconnect it any time in Snap to List, Settings.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btn(false)} disabled={busy} onClick={() => decide(false)}>DENY</button>
              <button style={{ ...btn(true), opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => decide(true)}>{busy ? 'WORKING…' : 'ALLOW'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
