const test = require('node:test');
const assert = require('node:assert/strict');
const patch = require('../lib/game-patch');

test('applyEdits заменяет точный фрагмент', () => {
    const code = '<script>\nconst a = 1;\nconst b = 2;\n</script>';
    const result = patch.applyEdits(code, [{ find: 'const a = 1;', replace: 'let a = 1;' }]);
    assert.equal(result.applied.length, 1);
    assert.equal(result.failed.length, 0);
    assert.match(result.code, /let a = 1;/);
    assert.match(result.code, /const b = 2;/);
});

test('applyEdits находит фрагмент с отличающимися отступами', () => {
    const code = '<script>\n    const a = 1;\n</script>';
    const result = patch.applyEdits(code, [{ find: 'const a = 1;', replace: 'let a = 1;' }]);
    assert.equal(result.applied.length, 1);
    assert.match(result.code, /let a = 1;/);
});

test('applyEdits сообщает о ненайденном фрагменте и не трогает код', () => {
    const code = '<script>const a = 1;</script>';
    const result = patch.applyEdits(code, [{ find: 'const missing = 9;', replace: 'x' }]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.code, code);
});

test('applyEdits игнорирует пустой find и не-строки', () => {
    const result = patch.applyEdits('код', [{ find: '  ', replace: 'x' }, { replace: 'y' }, null]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.failed.length, 3);
    assert.equal(result.code, 'код');
});

test('applyEdits применяет несколько правок подряд', () => {
    const code = 'aaa bbb ccc';
    const result = patch.applyEdits(code, [
        { find: 'aaa', replace: 'AAA' },
        { find: 'ccc', replace: 'CCC' }
    ]);
    assert.equal(result.applied.length, 2);
    assert.equal(result.code, 'AAA bbb CCC');
});

test('buildPatchPrompt перечисляет замечания и прикладывает код', () => {
    const prompt = patch.buildPatchPrompt('<canvas></canvas>', [
        { level: 'critical', msg: 'оверлей блокирует старт' },
        { level: 'warning', msg: 'нет delta time' }
    ], { platform: 'mobile' });
    assert.match(prompt, /\[КРИТИЧНО\] оверлей блокирует старт/);
    assert.match(prompt, /\[важно\] нет delta time/);
    assert.match(prompt, /<canvas><\/canvas>/);
    assert.match(prompt, /телефон/);
});

test('buildPolishPrompt требует сохранить фон и полный файл', () => {
    const prompt = patch.buildPolishPrompt('<html></html>', {
        verdict: 'скучная графика',
        issues: [{ level: 'warning', msg: 'квадраты вместо силуэтов', fix: 'нарисовать слои' }]
    }, { platform: 'mobile' });
    assert.match(prompt, /скучная графика/);
    assert.match(prompt, /квадраты вместо силуэтов/);
    assert.match(prompt, /\{\{AI_BG_IMAGE\}\}/);
    assert.match(prompt, /ПОЛНЫЙ файл/);
});

test('buildPolishPrompt может запретить плейсхолдер фона', () => {
    const prompt = patch.buildPolishPrompt('<html></html>', { issues: [] }, { keepBackground: false });
    assert.match(prompt, /не используй/);
    assert.doesNotMatch(prompt, /background: url\('\{\{AI_BG_IMAGE\}\}'\)/);
});

test('buildPolishPrompt перечисляет слабые критерии рубрики', () => {
    const prompt = patch.buildPolishPrompt('<html></html>', {
        issues: [],
        criteria: { objects: 35, background: 40, decor: 80, contrast: 85, hud: 60, palette: 88, effects: 82 }
    });
    assert.match(prompt, /СЛАБЫЕ КРИТЕРИИ ПО РУБРИКЕ/);
    assert.match(prompt, /objects: 35\/100/);
    assert.match(prompt, /background: 40\/100/);
    assert.doesNotMatch(prompt, /palette: 88/);
});

test('buildRubricBlock пуст, когда критериев нет или все сильные', () => {
    assert.equal(patch.buildRubricBlock({}), '');
    assert.equal(patch.buildRubricBlock({ criteria: { objects: 90, background: 80 } }), '');
});
