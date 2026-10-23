const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isStartLabel, stripRuntimeArtifacts, compareWithBaseline } = require('../scripts/eval-games');

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

function makeReport(scores) {
    return {
        summary: { avgScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length), completed: scores.length },
        prompts: scores.map((score, index) => ({ id: `game${index}`, pipeline: { score } }))
    };
}

test('A/B гейт пропускает прогон без просадки', () => {
    const comparison = compareWithBaseline(makeReport([90, 80]), makeReport([92, 85]));
    assert.equal(comparison.exitCode, 0);
    assert.equal(comparison.errors.length, 0);
    assert.match(comparison.lines.join('\n'), /game0: 90 → 92/);
});

test('A/B гейт ловит просадку качества по конкретной игре', () => {
    const comparison = compareWithBaseline(makeReport([90, 80]), makeReport([92, 60]));
    assert.equal(comparison.exitCode, 1);
    assert.match(comparison.errors.join('\n'), /game1: 80 → 60/);
});

test('A/B гейт считает неполный прогон невалидным, а не регрессией', () => {
    const comparison = compareWithBaseline(makeReport([90, 80]), makeReport([95]));
    assert.equal(comparison.exitCode, 1);
    assert.match(comparison.errors.join('\n'), /Прогон неполный/);
});
