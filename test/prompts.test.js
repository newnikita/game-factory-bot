const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGenerationPrompt, SYSTEM_INSTRUCTION, PROMPT_VERSION } = require('../bot');

test('generation-промпт содержит жанровый рецепт и технический контракт', () => {
    const prompt = buildGenerationPrompt('Защити ворота замка от драконов', 'mobile', {
        plan: 'Жанр: оборона\nПрогрессия и сложность: 5 волн',
        referenceCode: ''
    });
    assert.match(prompt, /БРИФ ГЕЙМДИЗАЙНЕРА/);
    assert.match(prompt, /Оборона базы/);
    assert.match(prompt, /3 типа врагов/);
    assert.match(prompt, /5 волн/);
    assert.match(prompt, /pointer-events: none/);
    assert.match(prompt, /Одна система координат/);
    assert.match(prompt, /390×844/);
    assert.match(prompt, /Защити ворота замка от драконов/);
});

test('generation-промпт для ПК не требует touch-управления', () => {
    const prompt = buildGenerationPrompt('Космический шутер с астероидами', 'pc', { referenceCode: '' });
    assert.match(prompt, /Платформа: ПК/);
    assert.match(prompt, /мышь\/клавиатура/);
});

test('generation-промпт сохраняет план и идею пользователя', () => {
    const prompt = buildGenerationPrompt('Гонка на ховербайке', 'mobile', {
        plan: 'Жанр: гонка\nФишка: ускорение',
        referenceCode: ''
    });
    assert.match(prompt, /=== ПЛАН ИГРЫ/);
    assert.match(prompt, /Фишка: ускорение/);
    assert.match(prompt, /Идея пользователя важнее рецепта/);
});

test('системная инструкция требует безопасного старта', () => {
    const text = SYSTEM_INSTRUCTION.parts.map((part) => part.text).join('\n');
    assert.match(text, /Первые 1–1\.5 секунды после старта/);
    assert.match(text, /300 px от игрока/);
});

test('версия промпта помечена', () => {
    assert.match(PROMPT_VERSION, /^v\d+-quality-pipeline$/);
});
