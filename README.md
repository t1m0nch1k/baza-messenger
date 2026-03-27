## BAZA Messenger (refactor in progress)

Этот репозиторий находится в процессе полной переработки (стабилизация + публичный деплой).

### Текущее состояние
- **v1** (legacy): монолит `server.js` + `index.html` в корне, порт `3000`.
- **v2** (новая архитектура): `apps/server` (TypeScript) + `apps/web` (Vite+React), порт `3100` (API) и `5173` (web dev).

### Запуск v1 (legacy)

```bash
npm start
```

### Запуск v2 (dev)

В двух терминалах:

```bash
cd apps/server
npm run dev
```

```bash
cd apps/web
npm run dev
```

Проверка API:

`GET http://localhost:3100/api/v2/health`

