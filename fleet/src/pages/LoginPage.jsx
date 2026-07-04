import React, { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { Field } from '../components.jsx';

export default function LoginPage() {
  const { me, login, toast } = useApp();
  const [mode, setMode] = useState(null); // 'demo' | 'real'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/mode').then((r) => {
      setMode(r.mode);
      if (r.mode === 'demo') { setEmail('admin@wenzel.example.com'); setPassword('demo1234'); }
    }).catch(() => setMode('demo'));
  }, []);

  if (me) return <Navigate to="/dashboard" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await login(email, password); toast('Welcome back'); }
    catch (ex) { setErr(ex.message || 'Login failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1><span className="dot" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--blue)', color: '#fff', display: 'grid', placeItems: 'center' }}>FV</span> FleetView</h1>
        <div className="sub">Fleet operations platform — sign in to continue</div>
        <Field label={mode === 'real' ? 'Username' : 'Email'} required><input type={mode === 'real' ? 'text' : 'email'} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder={mode === 'real' ? 'admin username' : ''} /></Field>
        <Field label="Password" required error={err}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {mode === 'demo' && (
          <div className="demo-hint">
            <b>Demo tenants (synthetic data):</b><br />
            Admin: <code>admin@wenzel.example.com</code><br />
            Dispatcher: <code>disp0@wenzel.example.com</code><br />
            Viewer: <code>viewer@wenzel.example.com</code><br />
            Other tenant: <code>admin@redline.example.com</code><br />
            Password for all: <code>demo1234</code>
          </div>
        )}
        {mode === 'real' && (
          <div className="demo-hint">Sign in with your operations-hub admin credentials.</div>
        )}
      </form>
    </div>
  );
}
