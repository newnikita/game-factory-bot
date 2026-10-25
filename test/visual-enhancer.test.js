const test = require('node:test');
const assert = require('node:assert/strict');
const { enhanceGameHtml, STYLE_ID, SCRIPT_ID } = require('../lib/visual-enhancer');

const GAME = '<!DOCTYPE html><html><head><title>Игра</title></head><body><canvas id="c"></canvas><script>const score = 0;</script></body></html>';

test('слой добавляет стиль и оверлеи, не трогая игру', () => {
    const html = enhanceGameHtml(GAME);
    assert.ok(html.includes(`id="${STYLE_ID}"`));
    assert.ok(html.includes('id="gf-vignette"'));
    assert.ok(html.includes('id="gf-grain"'));
    assert.ok(html.includes('id="gf-atmosphere"'));
    assert.ok(html.includes(`id="${SCRIPT_ID}"`));
    assert.ok(html.includes('<canvas id="c"></canvas>'));
    assert.ok(html.includes('<script>const score = 0;</script>'));
});

test('повторное применение не дублирует слой', () => {
    const once = enhanceGameHtml(GAME);
    const twice = enhanceGameHtml(once);
    assert.equal(twice, once);
    assert.equal(twice.match(new RegExp(`id="${STYLE_ID}"`, 'g')).length, 1);
    assert.equal(twice.match(/id="gf-vignette"/g).length, 1);
    assert.equal(twice.match(/id="gf-atmosphere"/g).length, 1);
    assert.equal(twice.match(new RegExp(`id="${SCRIPT_ID}"`, 'g')).length, 1);
});

test('слой не перехватывает нажатия', () => {
    const html = enhanceGameHtml(GAME);
    assert.match(html, /#gf-vignette\{[^}]*pointer-events:none/);
    assert.match(html, /#gf-grain\{[^}]*pointer-events:none/);
    assert.match(html, /#gf-atmosphere\{[^}]*pointer-events:none/);
});

test('HTML без head и body не ломается', () => {
    const html = enhanceGameHtml('<canvas></canvas>');
    assert.ok(html.includes(`id="${STYLE_ID}"`));
    assert.ok(html.includes('gf-vignette'));
    assert.ok(html.startsWith('<style'));
});

test('пустой и нестроковый ввод возвращается как есть', () => {
    assert.equal(enhanceGameHtml(''), '');
    assert.equal(enhanceGameHtml(null), null);
    assert.equal(enhanceGameHtml(undefined), undefined);
});
