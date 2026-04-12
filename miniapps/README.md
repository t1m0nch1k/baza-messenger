# Mini Apps Integration

## Обзор

Мессенджер теперь поддерживает нативную интеграцию HTML мини-приложений с возможностью:
- Создания мини-приложений через API
- Хранения HTML файлов на сервере
- Запуска через iframe с обёрткой
- Интеграции с Telegram WebApp API

## API Endpoints

### POST `/api/miniapp/create`
Создание нового мини-приложения из HTML контента.

**Request Body:**
```json
{
  "botId": "bot123",
  "name": "MyApp",
  "htmlContent": "<!DOCTYPE html>..."
}
```

**Response:**
```json
{
  "success": true,
  "url": "/miniapps/myapp_1234567890.html",
  "path": "/workspace/miniapps/myapp_1234567890.html"
}
```

### GET `/api/miniapp/list`
Получение списка всех мини-приложений.

**Response:**
```json
[
  {
    "fileName": "example.html",
    "url": "/miniapps/example.html",
    "size": 2048,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "modifiedAt": "2024-01-01T00:00:00.000Z"
  }
]
```

### DELETE `/api/miniapp/delete/:fileName`
Удаление мини-приложения.

**Response:**
```json
{
  "success": true
}
```

### GET `/miniapp/:botId`
Прямой запуск мини-приложения бота (редирект).

### GET `/miniapp/view/:botId`
Просмотр мини-приложения в iframe с обёрткой и заголовком.

## Примеры использования

### Создание мини-приложения через JavaScript

```javascript
const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>My App</title></head>
<body>
  <h1>Hello World!</h1>
  <button onclick="sendData()">Click me</button>
  <script>
    function sendData() {
      window.parent.postMessage({ type: 'MINI_APP_DATA', data: { action: 'click' } }, '*');
    }
  </script>
</body>
</html>
`;

fetch('/api/miniapp/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    botId: 'my-bot-id',
    name: 'HelloApp',
    htmlContent: htmlContent
  })
})
.then(res => res.json())
.then(data => console.log('Mini App created:', data.url));
```

### Получение списка мини-приложений

```javascript
fetch('/api/miniapp/list')
  .then(res => res.json())
  .then(apps => apps.forEach(app => {
    console.log(`${app.fileName}: ${app.url}`);
  }));
```

### Открытие мини-приложения

```javascript
// Прямой запуск
window.open('/miniapp/bot-id', '_blank');

// Или через iframe обёртку
window.open('/miniapp/view/bot-id', '_blank');
```

## Telegram WebApp API совместимость

Мини-приложения поддерживают базовый Telegram WebApp API:

```javascript
// В вашем HTML mini-app
window.Telegram.WebApp.ready();
window.Telegram.WebApp.sendData(JSON.stringify({ action: 'custom' }));
window.Telegram.WebApp.close();
window.Telegram.WebApp.expand();
```

## Структура хранения

```
/workspace/miniapps/
├── example.html          # Пример мини-приложения
└── myapp_1234567890.html # Созданные приложения
```

## Безопасность

- Имена файлов санитизируются (только a-z, 0-9, _)
- iframe использует sandbox атрибуты для безопасности
- Поддерживаются только .html файлы
- Автоматическая очистка ссылок у ботов при удалении
