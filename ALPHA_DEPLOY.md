# Alpha deploy (v2)

## 1) Подготовка

1. Скопируйте `.env` и проверьте секреты:
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
2. Убедитесь, что `PORT_V2` и `CORS_ORIGIN` соответствуют вашему домену.

## 2) Локальный smoke-test через Docker

```bash
docker compose -f docker-compose.alpha.yml up --build
```

- API: `http://localhost:3100/api/v2/health`
- Web: `http://localhost:5173`

> Важно: в проде задайте `VITE_API_URL=https://api.your-domain.com` если API на отдельном домене. Если переменная не задана, веб-клиент будет использовать текущий домен.

## 3) Прод-режим (без Docker)

```bash
cd apps/server
npm ci
npm run build
npm start
```

```bash
cd apps/web
npm ci
npm run build
npm run preview -- --host 0.0.0.0 --port 5173
```

## 4) Минимальный чеклист перед альфой

- [ ] Health endpoint отвечает `ok: true`.
- [ ] Логин работает для тестового пользователя.
- [ ] `/api/v2/auth/me` доступен по access token.
- [ ] CORS ограничен доменом фронта.
- [ ] JWT секреты заменены на production-значения.
