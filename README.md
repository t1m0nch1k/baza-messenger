# 🛡️ BAZA — Messenger (v1.0 Alpha)

### [RU]
**BAZA** — это высокопроизводительная коммуникационная платформа нового поколения. Проект ориентирован на интеграцию передового искусственного интеллекта в повседневное общение, обеспечивая при этом полный контроль пользователя над своими данными.

### [EN]
**BAZA** is a next-generation high-performance communication platform. The project focuses on integrating cutting-edge AI into everyday communication while ensuring that users retain full control over their data.

---

## ✨ Key Features / Ключевые возможности

### 🤖 AI Engine / Интеллект
* **Mistral AI** — умные ответы (Smart Replies) и чат-ассистент на базе модели `mistral-small`.
* **Summarization** — автоматическая суммаризация длинных диалогов.
* **Voice-to-Text** — локальная транскрипция голосовых сообщений через **Whisper**.

### ⚡ Performance / Производительность
* **Core:** сервер написан на **Node.js** с использованием **Socket.io**.
* **Optimization:** оптимизация для современных многоядерных процессоров (архитектура уровня **i7-12650H** и выше).

### 📱 Social Features / Социальные функции
* **Stories** — система временных публикаций.
* **Stickers** — система стикерпаков с поддержкой AI‑генерации.

---

## 🛠️ Installation / Установка

### [RU] Инструкция по запуску
1. **Клонируйте репозиторий:**
   ```bash
   git clone [https://github.com/t1m0nch1k/baza-messenger.git](https://github.com/t1m0nch1k/baza-messenger.git)

    Установите зависимости:
    Bash

    npm install

    Настройте окружение: Создайте файл .env на основе .env.example. Добавьте MISTRAL_API_KEY и параметры SMTP.

    Запустите сервер:
    Bash

    node server.js

[EN] Setup Guide

    Clone the repository:
    Bash

    git clone [https://github.com/t1m0nch1k/baza-messenger.git](https://github.com/t1m0nch1k/baza-messenger.git)

    Install dependencies:
    Bash

    npm install

    Configure environment: Create a .env file based on .env.example. Add MISTRAL_API_KEY and SMTP settings.

    Run the server:
    Bash

    node server.js

💻 Tech Stack

    Backend: Node.js, Express, Socket.io

    Database: SQLite, PostgreSQL

    AI: Mistral AI, Groq API, Whisper

    Frontend: Vanilla JavaScript, CSS3 (Glassmorphism UI)

⚖️ License

Distributed under the MIT License. See the LICENSE file for more information.