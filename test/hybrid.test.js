const test = require('node:test');
const assert = require('node:assert/strict');
const hybrid = require('../lib/hybrid');
const { auditGame } = require('../lib/game-quality');
const { validateGameCode } = require('../bot');

test('normalizeSpec откатывается к дефолтам на мусоре', () => {
    const spec = hybrid.normalizeSpec(null);
    assert.equal(spec.title, hybrid.DEFAULT_SPEC.title);
    assert.equal(spec.enemies.length, 3);
    assert.equal(spec.player.speed, hybrid.DEFAULT_SPEC.player.speed);
});

test('normalizeSpec принимает валидный ответ модели', () => {
    const spec = hybrid.normalizeSpec({
        title: 'Ночной Раннер',
        narration: 'Беги и собирай огни',
        palette: { sky: '#123456', deep: '#654321', ground: '#111111', accent: '#abcdef', danger: '#fedcba', reward: '#010203' },
        player: { name: 'Искра', color: '#aabbcc', speed: 200, jump: 600 },
        world: { length: 3000 },
        bg: 'Neon City Night',
        enemies: [
            { type: 'patrol', name: 'Шатун', color: '#ff0000', speed: 60, behavior: 'patrol' },
            { type: 'jumper', name: 'Прыгун', color: '#00ff00', speed: 100, behavior: 'jump' },
            { type: 'hazard', name: 'Яма', color: '#0000ff', speed: 0, behavior: 'static' }
        ],
        collectible: { name: 'Огонёк', color: '#ffff00' }
    });
    assert.equal(spec.title, 'Ночной Раннер');
    assert.equal(spec.palette.sky, '#123456');
    assert.equal(spec.player.speed, 200);
    assert.equal(spec.world.length, 3000);
    assert.equal(spec.bg, 'neon city night');
    assert.deepEqual(spec.enemies.map((enemy) => enemy.behavior), ['patrol', 'jump', 'static']);
    assert.equal(spec.enemies[2].speed, 0);
});

test('normalizeSpec выкидывает невалидные цвета и подрезает числа', () => {
    const spec = hybrid.normalizeSpec({
        palette: { sky: 'не цвет' },
        player: { speed: 9999, jump: -100 },
        world: { length: 100 }
    });
    assert.equal(spec.palette.sky, hybrid.DEFAULT_SPEC.palette.sky);
    assert.equal(spec.player.speed, 330);
    assert.equal(spec.player.jump, 520);
    assert.equal(spec.world.length, 2600);
});

test('normalizeSpec чистит bg до трёх английских слов', () => {
    const spec = hybrid.normalizeSpec({ bg: 'Дракон!!! в небе <script>' });
    assert.match(spec.bg, /^[a-z0-9 ]*$/);
    assert.doesNotMatch(spec.bg, /[<>]/);
});

test('normalizeSpec всегда оставляет ровно трёх врагов', () => {
    const spec = hybrid.normalizeSpec({ enemies: [{ type: 'patrol', name: 'A', color: '#111111', speed: 50, behavior: 'patrol' }] });
    assert.equal(spec.enemies.length, 3);
});

test('getEngine отдаёт движок для платформера и null для остальных', () => {
    assert.ok(hybrid.getEngine('platformer'));
    assert.equal(hybrid.getEngine('shooter'), null);
    assert.equal(hybrid.supportsGenre('platformer'), true);
    assert.equal(hybrid.supportsGenre('racing'), false);
});

test('renderPlatformer подставляет спеку, заголовок и фон', () => {
    const spec = hybrid.normalizeSpec({ title: 'Лесной дух', bg: 'fantasy forest' });
    const html = hybrid.renderPlatformer(spec, {});
    assert.match(html, /<title>Лесной дух<\/title>/);
    assert.match(html, /\{\{AI_BG_IMAGE\}\}/);
    assert.match(html, /\[BG: fantasy forest\]/);
    assert.doesNotMatch(html, /\{\{SPEC_JSON\}\}/);
    assert.doesNotMatch(html, /\{\{TITLE\}\}/);
    assert.match(html, /"title":"Лесной дух"/);
});

test('renderPlatformer подставляет готовый URL фона', () => {
    const spec = hybrid.normalizeSpec({});
    const html = hybrid.renderPlatformer(spec, { backgroundUrl: '/uploads/bg_1.jpg' });
    assert.match(html, /url\('\/uploads\/bg_1\.jpg'\)/);
    assert.doesNotMatch(html, /\{\{AI_BG_IMAGE\}\}/);
});

test('движок платформера проходит технический аудит', () => {
    const html = hybrid.renderPlatformer(hybrid.normalizeSpec({}), {});
    const audit = auditGame(html, 'mobile');
    assert.equal(audit.score, 100, JSON.stringify(audit.issues));
    assert.deepEqual(audit.issues, []);
});

test('движок платформера проходит валидацию без критичных замечаний', () => {
    const html = hybrid.renderPlatformer(hybrid.normalizeSpec({}), {});
    const issues = validateGameCode(html, 'mobile');
    assert.equal(issues.filter((issue) => issue.level === 'critical').length, 0);
});

test('движок не тянет внешние ресурсы', () => {
    const html = hybrid.renderPlatformer(hybrid.normalizeSpec({}), {});
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /localStorage/);
    assert.doesNotMatch(html, /YaGames/);
    assert.doesNotMatch(html, /<button/i);
});
