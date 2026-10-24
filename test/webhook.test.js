const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
    resolveBotMode,
    deriveWebhookSecret,
    createWebhookHandler,
    createUpdateQueue
} = require('../lib/webhook');

function startApp(handler) {
    const app = express();
    app.use(express.json());
    app.post('/hook', handler);
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

async function post(base, body, headers = {}) {
    return fetch(`${base}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
}

test('режим по умолчанию: webhook на Render с HTTPS, иначе polling', () => {
    assert.equal(resolveBotMode({ WEBAPP_URL: 'https://example.com' }, true), 'webhook');
    assert.equal(resolveBotMode({ WEBAPP_URL: 'http://localhost:3000' }, true), 'polling');
    assert.equal(resolveBotMode({ WEBAPP_URL: 'https://example.com' }, false), 'polling');
    assert.equal(resolveBotMode({ BOT_MODE: 'webhook' }, false), 'webhook');
    assert.equal(resolveBotMode({ BOT_MODE: 'polling', WEBAPP_URL: 'https://example.com' }, true), 'polling');
});

test('секрет webhook детерминирован и не равен токену', () => {
    const first = deriveWebhookSecret('123:abc');
    assert.match(first, /^[0-9a-f]{48}$/);
    assert.equal(first, deriveWebhookSecret('123:abc'));
    assert.notEqual(first, deriveWebhookSecret('123:other'));
    assert.equal(deriveWebhookSecret('123:abc', ' explicit '), 'explicit');
});

test('запрос без секрета отклоняется и не обрабатывается', async (t) => {
    let called = 0;
    const { server, base } = await startApp(createWebhookHandler({
        secret: 'secret',
        onUpdate: () => { called += 1; }
    }));
    t.after(() => server.close());

    const response = await post(base, { update_id: 1 });
    assert.equal(response.status, 403);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(called, 0);
});

test('верный секрет отвечает 200 и ставит апдейт в обработку', async (t) => {
    const received = [];
    const { server, base } = await startApp(createWebhookHandler({
        secret: 'secret',
        onUpdate: (update) => { received.push(update.update_id); }
    }));
    t.after(() => server.close());

    const response = await post(base, { update_id: 7 }, { 'x-telegram-bot-api-secret-token': 'secret' });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received, [7]);
});

test('ответ уходит раньше, чем закончится долгая генерация', async (t) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { server, base } = await startApp(createWebhookHandler({
        secret: 'secret',
        onUpdate: () => gate
    }));
    t.after(() => server.close());

    const started = Date.now();
    const response = await post(base, { update_id: 8 }, { 'x-telegram-bot-api-secret-token': 'secret' });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 1000, 'ответ не должен ждать обработчик');
    release();
});

test('апдейт без update_id отвергается, неактивный маршрут — 404', async (t) => {
    const { server, base } = await startApp(createWebhookHandler({
        secret: 'secret',
        onUpdate: () => {}
    }));
    t.after(() => server.close());

    const bad = await post(base, { message: {} }, { 'x-telegram-bot-api-secret-token': 'secret' });
    assert.equal(bad.status, 400);

    const { server: inactiveServer, base: inactiveBase } = await startApp(createWebhookHandler({
        secret: 'secret',
        isActive: () => false,
        onUpdate: () => {}
    }));
    t.after(() => inactiveServer.close());
    const inactive = await post(inactiveBase, { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'secret' });
    assert.equal(inactive.status, 404);
});

test('очередь сохраняет порядок и не падает после ошибки обработчика', async () => {
    const seen = [];
    const queue = createUpdateQueue(async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item.delay));
        if (item.fail) throw new Error('boom');
        seen.push(item.id);
    }, { max: 10 });

    queue.push({ id: 1, delay: 30 });
    queue.push({ id: 2, delay: 0, fail: true });
    queue.push({ id: 3, delay: 10 });
    await queue.drain();

    assert.deepEqual(seen, [1, 3]);
    assert.equal(queue.size, 0);
});

test('очередь отклоняет апдейты сверх лимита', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queue = createUpdateQueue(() => gate, { max: 1 });

    assert.equal(queue.push(1), true);
    assert.equal(queue.push(2), false);
    release();
    await queue.drain();
    assert.equal(queue.size, 0);
});
