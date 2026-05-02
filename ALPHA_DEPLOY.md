# Alpha deploy (v2)

## 1) Подготовка

1. Скопируйте `.env` и проверьте секреты:
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
2. Для прода задайте домены:
   - `CORS_ORIGIN=https://web.your-domain.com` (или список через запятую)
   - `VITE_API_URL=https://api.your-domain.com` (если API на отдельном домене)
3. Если API и Web под одним доменом (reverse proxy), `VITE_API_URL` можно не задавать — клиент использует текущий origin.

## 2) Локальный smoke-test через Docker

```bash
docker compose -f docker-compose.alpha.yml up --build
```

- API: `http://localhost:3100/api/v2/health`
- Web: `http://localhost:5173`

## 3) Публикация обновлений

### Server
```bash
cd apps/server
npm ci
npm run build
npm start
```

### Web
```bash
cd apps/web
npm ci
npm run build
npm run preview -- --host 0.0.0.0 --port 5173
```

## 4) Минимальный чеклист перед релизом

- [ ] `GET /api/v2/health` отвечает `ok: true`.
- [ ] Регистрация создаёт нового пользователя.
- [ ] Вход возвращает `accessToken`.
- [ ] `/api/v2/auth/me` отвечает при `Authorization: Bearer ...`.
- [ ] CORS разрешает только нужные домены.
