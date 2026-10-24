const test = require('node:test');
const assert = require('node:assert/strict');
const { renderGallery, formatDate } = require('../lib/gallery');

const GAME = {
    id: 'ai_10000000001',
    title: 'Космический шутер',
    source: 'ai',
    created_at: '2026-10-24 10:00:00'
};

test('галерея всегда показывает демо-движки с обложками', () => {
    const html = renderGallery({ games: [] });
    assert.match(html, /Попробуй движки/);
    assert.match(html, /href="\/bubble\/"/);
    assert.match(html, /Демо-движок/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
});

test('галерея показывает игру, обложку и ссылку на запуск', () => {
    const html = renderGallery({ games: [GAME], botUsername: 'gamefactory_bot' });
    assert.match(html, /Космический шутер/);
    assert.match(html, /\/play\/ai_10000000001/);
    assert.match(html, /\/covers\/ai_10000000001\.svg/);
    assert.match(html, /https:\/\/t\.me\/gamefactory_bot/);
    assert.match(html, /24 октября 2026/);
});

test('название игры экранируется', () => {
    const html = renderGallery({ games: [{ ...GAME, title: '<b>Взлом</b>' }] });
    assert.ok(!html.includes('<b>Взлом</b>'));
    assert.match(html, /&lt;b&gt;Взлом&lt;\/b&gt;/);
});

test('пустая галерея предлагает создать игру', () => {
    const html = renderGallery({ games: [], botUsername: 'gamefactory_bot' });
    assert.match(html, /В галерее пока пусто/);
    assert.match(html, /Создать свою игру/);
});

test('пагинация ведёт на соседние страницы', () => {
    const first = renderGallery({ games: [GAME], page: 1, limit: 1 });
    assert.match(first, /href="\/gallery\?page=2"/);
    const second = renderGallery({ games: [GAME], page: 2, limit: 1 });
    assert.match(second, /href="\/gallery\?page=1"/);
});

test('дата из SQLite показывается по-русски', () => {
    assert.equal(formatDate('2026-10-24 10:00:00'), '24 октября 2026');
    assert.equal(formatDate(''), '');
    assert.equal(formatDate('не дата'), '');
});
