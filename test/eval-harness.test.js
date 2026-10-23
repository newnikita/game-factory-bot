const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isStartLabel, stripRuntimeArtifacts } = require('../scripts/eval-games');

test('stripRuntimeArtifacts убирает плейсхолдер фона и маркер [BG:]', () => {
    const html = '<html><body><canvas id="g"></canvas>\n[BG: Neon Tokyo Skyline]\n</body></html>';
    const cleaned = stripRuntimeArtifacts(html);
    assert.ok(!cleaned.includes('{{AI_BG_IMAGE}}'));
    assert.ok(!/\[BG:/i.test(cleaned));
    assert.ok(cleaned.includes('<canvas id="g">'));
});

test('stripRuntimeArtifacts вычищает маркер, добавленный после </html>', () => {
    const cleaned = stripRuntimeArtifacts('<html><body>игра</body></html>\n[BG: Neon Tokyo Skyline]');
    assert.ok(!/\[BG:/i.test(cleaned));
    assert.ok(cleaned.endsWith('</html>'));
});

test('stripRuntimeArtifacts не трогает обычный код', () => {
    const html = '<html><body><canvas></canvas></body></html>';
    assert.equal(stripRuntimeArtifacts(html), html);
});

test('isStartLabel узнаёт кнопки старта на русском и английском', () => {
    assert.equal(isStartLabel('НАЧАТЬ ИГРУ'), true);
    assert.equal(isStartLabel('Играть'), true);
    assert.equal(isStartLabel('ИГРАТЬ СНОВА'), true);
    assert.equal(isStartLabel('ПРОДОЛЖИТЬ'), true);
    assert.equal(isStartLabel('Start'), true);
    assert.equal(isStartLabel('Play'), true);
});

test('isStartLabel не путает обычный текст с кнопкой старта', () => {
    assert.equal(isStartLabel('ТОКИО РАННЕР'), false);
    assert.equal(isStartLabel('Нажми слева для прыжка'), false);
    assert.equal(isStartLabel('Стартовый экран'), false);
    assert.equal(isStartLabel(''), false);
    assert.equal(isStartLabel('x'.repeat(60)), false);
});

test('проба Gemini без ключа падает с понятной ошибкой', () => {
    const script = path.join(__dirname, '..', 'scripts', 'probe-gemini.js');
    const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, GEMINI_API_KEY: '' },
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GEMINI_API_KEY не задан/);
});
