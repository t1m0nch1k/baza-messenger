import { FormEvent, useMemo, useState } from 'react';
import './App.css';

type AuthResponse = {
  accessToken: string;
  user: {
    phone: string;
    nickname?: string;
    role: string;
    isPremium?: boolean;
  };
};

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3100';

function App() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('Готово к альфа-тесту');
  const [me, setMe] = useState<null | AuthResponse['user']>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => phone.trim().length >= 3 && password.trim().length > 0, [phone, password]);

  async function onLogin(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setStatus('Логин...');

    try {
      const res = await fetch(`${API_URL}/api/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: phone.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'LOGIN_FAILED');

      const payload = data as AuthResponse;
      setToken(payload.accessToken);
      setMe(payload.user);
      setStatus(`Успешно: ${payload.user.nickname || payload.user.phone}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LOGIN_FAILED';
      setStatus(`Ошибка: ${message}`);
      setToken('');
      setMe(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadProfile() {
    if (!token) return;
    setStatus('Запрос профиля...');

    const res = await fetch(`${API_URL}/api/v2/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) return setStatus(`Ошибка профиля: ${data.error || 'FAILED'}`);

    setMe(data.user);
    setStatus('Профиль загружен');
  }

  return (
    <main className="page">
      <section className="card">
        <h1>BAZA v2 · Alpha Launch</h1>
        <p className="muted">Минимальная панель для проверки API авторизации перед запуском альфа-теста.</p>

        <form onSubmit={onLogin} className="form">
          <label>
            Телефон
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7..." autoComplete="username" />
          </label>

          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>

          <button disabled={!canSubmit || loading} type="submit">
            {loading ? 'Входим...' : 'Войти'}
          </button>
        </form>

        <div className="actions">
          <button onClick={loadProfile} disabled={!token} type="button">
            Проверить /me
          </button>
        </div>

        <pre className="status">{status}</pre>

        {me && (
          <div className="profile">
            <strong>Пользователь:</strong> {me.nickname || '—'} ({me.phone}) · {me.role}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
