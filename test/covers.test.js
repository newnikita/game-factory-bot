const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCoverSvg, wrapTitle, hashString } = require('../lib/covers');

test('обложка детерминирована для одной игры', () => {
    const game = { id: 'ai_10000000001', title: 'Космический шутер' };
    assert.equal(renderCoverSvg(game), renderCoverSvg(game));
    assert.match(renderCoverSvg(game), /^<svg xmlns=/);
});

test('обложка экранирует название и не вставляет скрипт', () => {
    const svg = renderCoverSvg({ id: 'ai_10000000001', title: '<script>alert(1)</script>' });
    assert.ok(!svg.includes('<script>'));
    assert.match(svg, /&lt;script&gt;/);
});

test('жанр подписан по названию', () => {
    const svg = renderCoverSvg({ id: 'ai_10000000001', title: 'Космический шутер с астероидами' });
    assert.match(svg, /ШУТЕР/);
    assert.match(svg, /Космический/);
});

test('длинное название переносится на две строки с многоточием', () => {
    const lines = wrapTitle('Очень длинное название игры про космические приключения героя', 18, 2);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /…$/);
});

test('короткое название остаётся одной строкой', () => {
    assert.deepEqual(wrapTitle('Кот', 18, 2), ['Кот']);
});

test('хэш стабилен и различает идентификаторы', () => {
    assert.equal(hashString('ai_1'), hashString('ai_1'));
    assert.notEqual(hashString('ai_1'), hashString('ai_2'));
});
