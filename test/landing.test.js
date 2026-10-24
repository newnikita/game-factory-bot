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
const { renderLanding, renderLegalIndex, renderLegalDocument, renderMarkdown, renderRobots, renderSitemap, botLink } = require('../lib/landing');

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
    assert.match(html, /\/gallery/);
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
    assert.match(text, /<loc>[^<]*\/gallery<\/loc>/);
    assert.match(renderSitemap('https://example.com', ['/']), /<loc>https:\/\/example\.com\/<\/loc>/);
});

test('галерея показывает опубликованные игры, а обложка отдаётся как SVG', async () => {
    db.ensureUser(1);
    db.recordGame({ id: 'ai_10000000001', telegramId: 1, title: 'Космический шутер', htmlPath: 'ai_10000000001.html' });
    db.recordGame({ id: 'ai_10000000002', telegramId: 1, title: 'Секретная игра', htmlPath: 'ai_10000000002.html' });
    db.setGamePublic('ai_10000000001', 1, true);

    const response = await fetch(`${base}/gallery`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Космический шутер/);
    assert.match(html, /\/play\/ai_10000000001/);
    assert.match(html, /\/covers\/ai_10000000001\.svg/);
    assert.ok(!html.includes('Секретная игра'), 'неопубликованная игра не попадает в галерею');

    const cover = await fetch(`${base}/covers/ai_10000000001.svg`);
    assert.equal(cover.status, 200);
    assert.match(cover.headers.get('content-type'), /image\/svg\+xml/);
    const svg = await cover.text();
    assert.match(svg, /^<svg/);
    assert.match(svg, /Космический шутер/);

    const missing = await fetch(`${base}/covers/ai_99999999999.svg`);
    assert.equal(missing.status, 404);
});

test('страница документов перечисляет все документы с русскими названиями', async () => {
    const response = await fetch(`${base}/legal`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Публичная оферта/);
    assert.match(html, /Политика возвратов/);
    assert.match(html, /\/legal\/offer\.md/);
    assert.match(html, /\/legal\/license\.md/);
    assert.ok(!html.includes('>offer<'), 'название файла не должно быть единственным подписью');
    assert.match(renderLegalIndex({ support: {} }), /Публичная оферта/);
});

test('документ отдаётся разметкой, а не простыней текста', async () => {
    const response = await fetch(`${base}/legal/offer.md`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<h1>/);
    assert.match(html, /<h2>/);
    assert.match(html, /<p>/);
    assert.match(html, /<strong>/);
});

test('markdown переводит списки, заголовки и переносы строк', () => {
    const html = renderMarkdown('# Заголовок\n\nПараграф.\n\n- пункт один\n- пункт два\n');
    assert.match(html, /<h1>Заголовок<\/h1>/);
    assert.match(html, /<p>Параграф\.<\/p>/);
    assert.match(html, /<ul>\s*<li>пункт один<\/li>\s*<li>пункт два<\/li>\s*<\/ul>/);
});

test('markdown экранирует html и не выполняет javascript-ссылки', () => {
    const html = renderMarkdown('Текст <script>alert(1)</script> и [ссылка](javascript:alert(1)).');
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('javascript:'));
    assert.match(html, /&lt;script&gt;/);
});

test('значения реквизитов в документе экранируются', () => {
    const html = renderLegalDocument({
        file: 'offer.md',
        text: 'Оператор: <img src=x onerror=alert(1)>',
        support: { '[email]': '<script>alert(1)</script>' }
    });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
});
