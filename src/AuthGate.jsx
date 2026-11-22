import React, { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from './lib/supabase.js';

const shell = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  background: 'linear-gradient(180deg, #0a0a0f 0%, #12121a 100%)', color: '#e8e8ed',
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
};
const card = { background: '#1c1c28', border: '1px solid #2a2a36', padding: 28, width: '100%', maxWidth: 380 };
const input = { width: '100%', padding: '10px 12px', background: '#0e0e15', border: '1px solid #2a2a36', color: '#e8e8ed', fontFamily: 'inherit', fontSize: '0.875rem', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8a8a96', margin: '12px 0 6px' };
const primary = { width: '100%', marginTop: 18, padding: '12px', background: '#ff4d4d', color: '#fff', border: 'none', cursor: 'pointer', fontFamily: '"Bebas Neue", sans-serif', letterSpacing: '0.08em', fontSize: '1rem' };
const link = { background: 'none', border: 'none', color: '#8a8a96', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem', padding: 0, textDecoration: 'underline' };

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
      <div style={shell}><div style={card}>
        <h2 style={{ marginTop: 0, color: '#ff4d4d', fontFamily: '"Bebas Neue", sans-serif', letterSpacing: '0.06em' }}>SUPABASE NOT CONFIGURED</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Netlify (or a local <code>.env</code>) and rebuild.</p>
      </div></div>
    );
  }
  if (session === undefined) return <div style={shell}><span style={{ color: '#8a8a96' }}>Loading…</span></div>;
  if (!session) return <SignIn />;
  if (recovering) return <NewPassword onDone={() => setRecovering(false)} />;
  return children(session);
}

function SignIn() {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'reset'
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
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        if (!data.session) setMsg({ ok: true, text: 'Check your email to confirm your account, then sign in.' });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) throw error;
        setMsg({ ok: true, text: 'If that email has an account, a reset link is on its way.' });
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signin' ? 'SIGN IN' : mode === 'signup' ? 'CREATE ACCOUNT' : 'RESET PASSWORD';
  return (
    <div style={shell}>
      <form onSubmit={submit} style={card}>
        <h1 style={{ margin: 0, color: '#ff4d4d', fontFamily: '"Bebas Neue", sans-serif', letterSpacing: '0.04em', fontSize: '2rem' }}>CARDDESK</h1>
        <div style={{ color: '#8a8a96', fontSize: '0.75rem', letterSpacing: '0.12em', marginBottom: 8 }}>{title}</div>
        <label style={labelStyle} htmlFor="email">Email</label>
        <input id="email" style={input} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode !== 'reset' && (<>
          <label style={labelStyle} htmlFor="password">Password</label>
          <input id="password" style={input} type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </>)}
        <button type="submit" style={{ ...primary, opacity: busy ? 0.6 : 1 }} disabled={busy}>{busy ? 'WORKING…' : title}</button>
        {msg && <div style={{ marginTop: 12, fontSize: '0.8rem', color: msg.ok ? '#4ade80' : '#ff6b6b' }}>{msg.text}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {mode !== 'signin'
            ? <button type="button" style={link} onClick={() => { setMode('signin'); setMsg(null); }}>Back to sign in</button>
            : <button type="button" style={link} onClick={() => { setMode('signup'); setMsg(null); }}>Create account</button>}
          {mode === 'signin' && <button type="button" style={link} onClick={() => { setMode('reset'); setMsg(null); }}>Forgot password?</button>}
        </div>
      </form>
    </div>
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
    <div style={shell}>
      <form onSubmit={submit} style={card}>
        <h1 style={{ margin: 0, color: '#ff4d4d', fontFamily: '"Bebas Neue", sans-serif', letterSpacing: '0.04em', fontSize: '2rem' }}>CARDDESK</h1>
        <div style={{ color: '#8a8a96', fontSize: '0.75rem', letterSpacing: '0.12em', marginBottom: 8 }}>SET A NEW PASSWORD</div>
        <label style={labelStyle} htmlFor="newpw">New password</label>
        <input id="newpw" style={input} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" style={{ ...primary, opacity: busy ? 0.6 : 1 }} disabled={busy}>{busy ? 'SAVING…' : 'SAVE PASSWORD'}</button>
        {err && <div style={{ marginTop: 12, fontSize: '0.8rem', color: '#ff6b6b' }}>{err}</div>}
      </form>
    </div>
  );
}
