import { FormEvent, useMemo, useState } from 'react';
import './App.css';

type User = {
  phone: string;
  nickname?: string;
  role: string;
  isPremium?: boolean;
};

const API_URL = import.meta.env.VITE_API_URL || '';
const REQUEST_TIMEOUT_MS = 10000;

type Mode = 'login' | 'register';

async function apiRequest(path: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_URL}${path}`, { ...init, signal: controller.signal });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const error = payload?.error || `HTTP_${res.status}`;
      throw new Error(error);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function App() {
  const [mode, setMode] = useState<Mode>('login');
  const [phone, setPhone] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('Готово к публикации обновлений');
  const [me, setMe] = useState<null | User>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    const base = phone.trim().length >= 3 && password.trim().length >= 6;
    return mode === 'register' ? base && nickname.trim().length >= 2 : base;
  }, [mode, phone, password, nickname]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setLoading(true);

    try {
      if (mode === 'register') {
        setStatus('Регистрация...');
        await apiRequest('/api/v2/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ phone: phone.trim(), nickname: nickname.trim(), password }),
        });
        setStatus('Регистрация успешна. Выполните вход.');
        setMode('login');
      } else {
        setStatus('Вход...');
        const payload = await apiRequest('/api/v2/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ phone: phone.trim(), password }),
        });

        setToken(payload.accessToken);
        setMe(payload.user);
        setStatus(`Успешно: ${payload.user.nickname || payload.user.phone}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      setStatus(`Ошибка: ${message}`);
      if (mode === 'login') {
        setToken('');
        setMe(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadProfile() {
    if (!token) return;

    setStatus('Запрос профиля...');

    try {
      const payload = await apiRequest('/api/v2/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });

      setMe(payload.user);
      setStatus('Профиль загружен');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      setStatus(`Ошибка профиля: ${message}`);
    }
  }

  return (
    <main className="page">
      <section className="card">
        <h1>BAZA v2 · Alpha Launch</h1>
        <p className="muted">
          Панель входа/регистрации для релиза альфы. По умолчанию API вызывается на текущем домене.
        </p>

        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Вход
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Регистрация
          </button>
        </div>

        <form onSubmit={onSubmit} className="form">
          <label>
            Телефон
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7..." />
          </label>

          {mode === 'register' && (
            <label>
              Никнейм
              <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Ваш ник" />
            </label>
          )}

          <label>
            Пароль
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <button disabled={!canSubmit || loading} type="submit">
            {loading ? 'Подождите...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
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
