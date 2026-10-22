const test = require('node:test');
const assert = require('node:assert/strict');
const { detectGenre, buildDesignBrief, getGenreRecipe } = require('../lib/game-design');

test('detectGenre различает жанры по русскому промпту', () => {
    assert.equal(detectGenre('Защити ворота замка от драконов'), 'defense');
    assert.equal(detectGenre('Неоновый раннер по крышам Токио'), 'runner');
    assert.equal(detectGenre('Космический шутер с астероидами'), 'shooter');
    assert.equal(detectGenre('Головоломка с падающими блоками'), 'puzzle');
    assert.equal(detectGenre('Арканоид в стиле киберпанк'), 'breaker');
    assert.equal(detectGenre('Гонка на hoverbike по пустыне'), 'racing');
});

test('detectGenre возвращает arcade для незнакомой идеи', () => {
    assert.equal(detectGenre('игра про дружбу и созерцание'), 'arcade');
});

test('buildDesignBrief содержит глубину, визуальный стиль и технические ловушки', () => {
    const brief = buildDesignBrief('Защити замок от драконов', 'mobile');
    assert.match(brief, /Оборона базы/);
    assert.match(brief, /3 типа врагов/);
    assert.match(brief, /5 волн/);
    assert.match(brief, /pointer-events: none/);
    assert.match(brief, /одна система координат/i);
    assert.match(brief, /const/);
    assert.match(brief, /телефон/);
});

test('у каждого жанрового рецепта есть глубина и визуальное описание', () => {
    for (const id of ['defense', 'runner', 'shooter', 'platformer', 'breaker', 'puzzle', 'arcade', 'racing']) {
        const recipe = getGenreRecipe(id);
        assert.equal(recipe.id, id);
        assert.ok(recipe.depth.length >= 4, id);
        assert.ok(recipe.visual.length > 20, id);
    }
});
