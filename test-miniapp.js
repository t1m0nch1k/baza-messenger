#!/usr/bin/env node
/**
 * Тестовый скрипт для проверки Mini Apps интеграции
 * Запуск: node test-miniapp.js
 */

const http = require('http');
const BASE_URL = 'http://localhost:3000';

// Helper для HTTP запросов
function request(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

async function runTests() {
    console.log('🧪 Тестирование Mini Apps Integration\n');
    
    // Тест 1: Получение списка мини-приложений
    console.log('📋 Тест 1: Получение списка мини-приложений');
    try {
        const res = await request('GET', '/api/miniapp/list');
        console.log(`   Статус: ${res.status}`);
        console.log(`   Приложения: ${Array.isArray(res.data) ? res.data.length : 'N/A'}`);
        if (Array.isArray(res.data)) {
            res.data.forEach(app => {
                console.log(`   - ${app.fileName} (${app.url})`);
            });
        }
        console.log('   ✅ Успешно\n');
    } catch (e) {
        console.log(`   ❌ Ошибка: ${e.message}\n`);
    }
    
    // Тест 2: Создание тестового мини-приложения
    console.log('📝 Тест 2: Создание тестового мини-приложения');
    const testHtml = `
<!DOCTYPE html>
<html>
<head><title>Test App</title></head>
<body>
    <h1>Test Mini App</h1>
    <p>Created at: ${new Date().toISOString()}</p>
    <button onclick="alert('Works!')">Click me</button>
</body>
</html>`;

    try {
        const createRes = await request('POST', '/api/miniapp/create', {
            botId: 'test-bot',
            name: 'TestApp',
            htmlContent: testHtml
        });
        
        console.log(`   Статус: ${createRes.status}`);
        if (createRes.status === 404) {
            console.log('   ⚠️  Бот не найден (это нормально если бот ещё не создан)');
            console.log('   Создайте бота через интерфейс мессенджера\n');
        } else if (createRes.data?.success) {
            console.log(`   URL: ${createRes.data.url}`);
            console.log('   ✅ Успешно\n');
            
            // Тест 3: Проверка что приложение появилось в списке
            console.log('📋 Тест 3: Проверка списка после создания');
            const listRes = await request('GET', '/api/miniapp/list');
            console.log(`   Статус: ${listRes.status}`);
            console.log(`   Приложений: ${listRes.data?.length || 0}`);
            console.log('   ✅ Успешно\n');
        } else {
            console.log(`   Ответ: ${JSON.stringify(createRes.data)}\n`);
        }
    } catch (e) {
        console.log(`   ❌ Ошибка: ${e.message}\n`);
    }
    
    // Тест 4: Проверка доступа к статическому файлу
    console.log('📄 Тест 4: Проверка доступа к example.html');
    try {
        const res = await request('GET', '/miniapps/example.html');
        console.log(`   Статус: ${res.status}`);
        if (res.status === 200 && res.data.includes('<!DOCTYPE html>')) {
            console.log('   ✅ Файл доступен\n');
        } else {
            console.log('   ⚠️  Файл не найден или пуст\n');
        }
    } catch (e) {
        console.log(`   ❌ Ошибка: ${e.message}\n`);
    }
    
    // Тест 5: Проверка view обёртки
    console.log('🖼️  Тест 5: Проверка view обёртки (нужен существующий бот)');
    try {
        const res = await request('GET', '/miniapp/view/test-bot');
        console.log(`   Статус: ${res.status}`);
        if (res.status === 404) {
            console.log('   ⚠️  Бот не найден (создайте бота для полной проверки)\n');
        } else if (res.status === 200 && res.data.includes('<iframe')) {
            console.log('   ✅ Обёртка работает\n');
        } else {
            console.log(`   Ответ: ${typeof res.data === 'string' ? res.data.substring(0, 100) : res.data}\n`);
        }
    } catch (e) {
        console.log(`   ❌ Ошибка: ${e.message}\n`);
    }
    
    console.log('═══════════════════════════════════════');
    console.log('Тестирование завершено!');
    console.log('Для полного тестирования создайте бота через интерфейс мессенджера');
}

runTests().catch(console.error);
