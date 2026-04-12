# BAZA Messenger

Мессенджер с поддержкой End-to-End шифрования, аудио/видео звонков и мини-приложений.

## 📋 О проекте

Проект находится в процессе рефакторинга. Доступны две версии:

- **v1 (legacy)** — монолитная архитектура на Express + SQLite
- **v2 (новая)** — микросервисная архитектура: TypeScript сервер + React клиент

---

## 🚀 Быстрый старт (v1 - legacy)

### Требования

- Node.js >= 16.x
- npm >= 7.x

### Установка зависимостей

```bash
npm install
```

### Запуск сервера

```bash
npm start
```

Сервер запустится на порту **3000**. Откройте в браузере: `http://localhost:3000`

### Альтернативный запуск (Windows)

```bash
start_server.bat
```

---

## 🔧 Разработка (v2 - новая архитектура)

### Требования

- Node.js >= 18.x
- npm >= 8.x

### Структура

```
apps/
├── server/    # TypeScript сервер (Express, порт 3100)
└── web/       # React клиент (Vite, порт 5173)
```

### Установка зависимостей

```bash
# Корневые зависимости
npm install

# Сервер
cd apps/server
npm install

# Клиент
cd apps/web
npm install
```

### Запуск в режиме разработки

Запустите **два терминала**:

**Терминал 1 — Сервер:**
```bash
cd apps/server
npm run dev
```
API доступно по адресу: `http://localhost:3100`

**Терминал 2 — Клиент:**
```bash
cd apps/web
npm run dev
```
Веб-интерфейс доступен по адресу: `http://localhost:5173`

### Проверка работоспособности API

```bash
curl http://localhost:3100/api/v2/health
```

### Сборка для продакшена

```bash
# Сервер
cd apps/server
npm run build
npm start

# Клиент
cd apps/web
npm run build
npm run preview
```

---

## 📁 Структура проекта

```
/workspace
├── server.js           # Основной сервер v1
├── index.html          # Клиент v1
├── db.js               # Подключение к БД
├── routes/             # API маршруты
├── middleware/         # Промежуточное ПО
├── config/             # Конфигурация
├── utils/              # Утилиты
├── apps/
│   ├── server/         # Сервер v2 (TypeScript)
│   └── web/            # Клиент v2 (React + Vite)
├── miniapps/           # Мини-приложения
└── scripts/            # Скрипты миграции
```

---

## 🛠 Технологии

### v1 (legacy)
- Express.js 5.x
- Socket.IO 4.x
- SQLite3 / PostgreSQL
- Multer (загрузка файлов)
- Nodemailer (email)

### v2 (новая)
- **Сервер:** TypeScript, Express, Zod, JWT
- **Клиент:** React 19, Vite, TypeScript
- **БД:** SQLite3

---

## 📝 Дополнительные команды

```bash
# Форматирование кода
npm run format

# Проверка форматирования
npm run format:check

# Линтинг клиента
cd apps/web
npm run lint
```

---

## 📄 Лицензия

ISC
