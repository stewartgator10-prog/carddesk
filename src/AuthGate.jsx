import React, { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from './lib/supabase.js';
import { Hedge, Clouds } from './Scenery.jsx';
import { IS_TYCHE, Wordmark } from './brand.jsx';

const card = { padding: 28, width: '100%', maxWidth: 380 };
const input = { width: '100%', padding: '10px 12px', fontSize: '0.9rem', boxSizing: 'border-box' };
const labelStyle = { margin: '14px 0 6px' };
const primary = { width: '100%', marginTop: 20, padding: '12px', fontSize: '1rem' };
const link = { background: 'none', border: 'none', color: 'var(--ink-dim)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem', padding: 0, textDecoration: 'underline' };

// The sign-in screens share one calm scene: sky, drifting clouds and the hedge along the bottom.
function Scene({ children }) {
  return <div className="center-screen"><Clouds />{children}<Hedge sign={false} /></div>;
}

// Shows a sign-in screen until there is a Supabase session, then renders children(session).
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [recovering, setRecovering] = useState(false); // arrived from a password-reset email

  useEffect(() => {
    if (!supabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) {
    return (
      <Scene><div className="bg-card auth-card" style={card}>
        <h2 className="display-font" style={{ marginTop: 0 }}>Supabase not configured</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Netlify (or a local <code>.env</code>) and rebuild.</p>
      </div></Scene>
    );
  }
  if (session === undefined) return <Scene><span className="quiet">Loading…</span></Scene>;
  if (!session) return <SignIn />;
  if (recovering) return <NewPassword onDone={() => setRecovering(false)} />;
  return children(session);
}

function SignIn() {
  // Tyche Cards homepage buttons arrive with ?signup=1 to open on "create account".
  const [mode, setMode] = useState(() => (new URLSearchParams(window.location.search).get('signup') ? 'signup' : 'signin')); // 'signin' | 'signup' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}${IS_TYCHE ? '/app' : ''}` } });
        if (error) throw error;
        if (!data.session) setMsg({ ok: true, text: 'Check your email to confirm your account, then sign in.' });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${IS_TYCHE ? '/app' : ''}` });
        if (error) throw error;
        setMsg({ ok: true, text: 'If that email has an account, a reset link is on its way.' });
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signin' ? 'sign in' : mode === 'signup' ? 'create account' : 'reset password';
  return (
    <Scene>
      <form onSubmit={submit} className="bg-card" style={card}>
        <Wordmark />
        <div className="quiet" style={{ fontSize: '0.85rem', margin: '6px 0 8px' }}>{title}</div>
        <label style={labelStyle} htmlFor="email">Email</label>
        <input id="email" className="bg-input" style={input} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode !== 'reset' && (<>
          <label style={labelStyle} htmlFor="password">Password</label>
          <input id="password" className="bg-input" style={input} type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </>)}
        <button type="submit" className="btn-primary" style={primary} disabled={busy}>{busy ? 'working…' : title}</button>
        {msg && <div style={{ marginTop: 12, fontSize: '0.8rem', color: msg.ok ? 'var(--good)' : 'var(--bad)' }}>{msg.text}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {mode !== 'signin'
            ? <button type="button" style={link} onClick={() => { setMode('signin'); setMsg(null); }}>Back to sign in</button>
            : <button type="button" style={link} onClick={() => { setMode('signup'); setMsg(null); }}>Create account</button>}
          {mode === 'signin' && <button type="button" style={link} onClick={() => { setMode('reset'); setMsg(null); }}>Forgot password?</button>}
        </div>
      </form>
    </Scene>
  );
}

function NewPassword({ onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setErr(error.message); else onDone();
  }
  return (
    <Scene>
      <form onSubmit={submit} className="bg-card" style={card}>
        <Wordmark />
        <div className="quiet" style={{ fontSize: '0.85rem', margin: '6px 0 8px' }}>set a new password</div>
        <label style={labelStyle} htmlFor="newpw">New password</label>
        <input id="newpw" className="bg-input" style={input} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn-primary" style={primary} disabled={busy}>{busy ? 'saving…' : 'save password'}</button>
        {err && <div style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--bad)' }}>{err}</div>}
      </form>
    </Scene>
  );
}
