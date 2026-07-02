import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Timer } from 'lucide-react';
import { api, setToken } from '../api';
import { ErrorBanner } from '../components';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === 'login'
          ? { email: form.email, password: form.password }
          : form;
      const res = await api<{ token: string }>(`/api/auth/${mode}`, { method: 'POST', body });
      setToken(res.token);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 4 }}>
          <Timer size={28} />
          <div>
            <strong>JobScheduler</strong>
            <span>distributed job platform</span>
          </div>
        </div>
        <h1>{mode === 'login' ? 'Sign in' : 'Create your organization'}</h1>
        <ErrorBanner message={error} />
        {mode === 'register' && (
          <>
            <label>
              Organization
              <input required value={form.organizationName} onChange={set('organizationName')} placeholder="Acme Inc" />
            </label>
            <label>
              Your name
              <input required value={form.name} onChange={set('name')} placeholder="Ada Lovelace" />
            </label>
          </>
        )}
        <label>
          Email
          <input required type="email" value={form.email} onChange={set('email')} placeholder="you@company.com" />
        </label>
        <label>
          Password
          <input required type="password" minLength={8} value={form.password} onChange={set('password')} placeholder="••••••••" />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}
        </button>
        <p className="muted">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <button type="button" className="link-button" onClick={() => setMode('register')}>
                Register an organization
              </button>
            </>
          ) : (
            <>
              Already registered?{' '}
              <button type="button" className="link-button" onClick={() => setMode('login')}>
                Sign in
              </button>
            </>
          )}
        </p>
        <p className="muted small">Demo account (after seeding): demo@example.com / demo1234</p>
      </form>
    </div>
  );
}
