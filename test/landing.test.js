const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-landing-'));
process.env.BOT_TOKEN = '0:test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.WEBAPP_URL = 'https://example.com';
process.env.DATA_DIR = dataDir;
process.env.DB_FILE = path.join(dataDir, 'test.db');
process.env.ADMIN_IDS = '999';

const db = require('../lib/db');
const { app } = require('../bot');
const { renderLanding, renderRobots, renderSitemap, botLink } = require('../lib/landing');

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

test('лендинг отдаёт главное сообщение, тарифы и ссылки на документы', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Опишите игру одним предложением/);
    assert.match(html, /Starter/);
    assert.match(html, /Попробовать/);
    assert.match(html, /\/legal\/offer\.md/);
    assert.match(html, /\/bubble\//, 'должна быть ссылка на живой пример');
});

test('в лендинг не попадают незаполненные реквизиты', async () => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    assert.ok(!html.includes('[email]'));
    assert.ok(!html.includes('[@username]'));
});

test('ссылка на бота строится из имени и не ломается', () => {
    assert.equal(botLink('gamefactory_bot'), 'https://t.me/gamefactory_bot');
    assert.equal(botLink('@gamefactory_bot'), 'https://t.me/gamefactory_bot');
    assert.equal(botLink(''), '');
    assert.match(renderLanding({ botUsername: 'gamefactory_bot' }), /https:\/\/t\.me\/gamefactory_bot/);
});

test('значения из окружения экранируются', () => {
    const html = renderLanding({ support: { '[email]': '<script>alert(1)</script>' } });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
});

test('robots.txt закрывает приватные маршруты и указывает на sitemap', async () => {
    const response = await fetch(`${base}/robots.txt`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Sitemap: /);
    assert.match(text, /Disallow: \/play\//);
    assert.match(text, /Disallow: \/sandbox\//);
});

test('sitemap.xml перечисляет публичные страницы', async () => {
    const response = await fetch(`${base}/sitemap.xml`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /<urlset/);
    assert.match(text, /<loc>[^<]*\/legal<\/loc>/);
    assert.match(renderSitemap('https://example.com', ['/']), /<loc>https:\/\/example\.com\/<\/loc>/);
});
