const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-legal-'));
process.env.BOT_TOKEN = '0:test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.WEBAPP_URL = 'https://example.com';
process.env.DATA_DIR = dataDir;
process.env.DB_FILE = path.join(dataDir, 'test.db');
process.env.ADMIN_IDS = '999';
process.env.SUPPORT_EMAIL = 'owner@example.com';
process.env.SUPPORT_USERNAME = '@owner';

const db = require('../lib/db');
const { app } = require('../bot');

db.initDb({ file: path.join(dataDir, 'test.db'), importLegacy: false, startBalance: 50, adminIds: [999] });

let server;
let base;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server.close();
    db.closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('документ отдаётся с подставленными реквизитами', async () => {
    const response = await fetch(`${base}/legal/offer.md`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /owner@example\.com/);
    assert.match(text, /@owner/);
    assert.ok(!text.includes('[email]'), 'заполненное поле не должно попасть к пользователю');
});

test('незаполненные поля остаются видимыми и попадают в отчёт о готовности', async () => {
    const response = await fetch(`${base}/legal/refunds.md`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes('[срок]'), 'незаполненный срок остаётся явным');

    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.ok(Array.isArray(health.config.legal_missing));
    assert.ok(health.config.legal_missing.includes('[срок]'));
    assert.equal(health.config.admin_ids, true);
    assert.equal(health.config.webapp_url, true);
});

test('выход за пределы каталога документов закрыт', async () => {
    const response = await fetch(`${base}/legal/..%2F..%2Fbot.js`, { redirect: 'manual' });
    assert.ok(response.status >= 400, `ожидался отказ, получен ${response.status}`);
});
