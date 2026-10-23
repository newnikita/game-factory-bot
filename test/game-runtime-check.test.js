const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkRuntimeErrors, extractScripts, formatRuntimeIssue } = require('../lib/game-runtime-check');

const wrap = (js) => `<!DOCTYPE html><html><body><canvas id="game"></canvas><script>${js}</script></body></html>`;

const BROKEN_GAME = wrap(`
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function initParallax() {
    bgBuildingsFar.length = 0;
}
initParallax();
const bgBuildingsFar = [];
`);

const HEALTHY_GAME = wrap(`
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const layers = [];
function buildCity() {
    layers.push({ x: 0 });
}
buildCity();
function loop() {
    requestAnimationFrame(loop);
    ctx.fillRect(0, 0, 10, 10);
}
loop();
`);

test('extractScripts достаёт только исполняемые скрипты', () => {
    const code = `<html><script src="app.js"></script><script type="application/json">{}</script><script>run();</script></html>`;
    assert.deepEqual(extractScripts(code), ['run();']);
});

test('игра, падающая при загрузке, помечается ошибкой', () => {
    const result = checkRuntimeErrors(BROKEN_GAME);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].name, 'ReferenceError');
    assert.match(result.errors[0].message, /bgBuildingsFar/);
});

test('здоровая игра проходит проверку загрузки', () => {
    const result = checkRuntimeErrors(HEALTHY_GAME);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
});

test('незнакомые браузерные API не считаются ошибкой', () => {
    const result = checkRuntimeErrors(wrap(`
const supported = CSS.supports('color', 'red');
if (!document.startViewTransition) { /* нет поддержки — это не ошибка */ }
navigator.wakeLock;
`));
    assert.equal(result.ok, true);
});

test('игра без скриптов считается исправной', () => {
    const result = checkRuntimeErrors('<!DOCTYPE html><html><body><canvas id="game"></canvas></body></html>');
    assert.equal(result.ok, true);
});

test('бесконечный цикл на загрузке ловится как зависание', () => {
    const result = checkRuntimeErrors(wrap('while (true) { /* вечный цикл */ }'), { scriptTimeout: 400 });
    assert.equal(result.ok, false);
    assert.match(formatRuntimeIssue(result.errors[0]), /зависает/);
});

test('сообщение об ошибке объясняет, что чинить', () => {
    const message = formatRuntimeIssue({ name: 'ReferenceError', message: "Cannot access 'x' before initialization", script: 1 });
    assert.match(message, /падает при загрузке/);
    assert.match(message, /скрипт #1/);
    assert.match(message, /const\/let/);
});

test('шаблоны движков и тестовые игры загружаются без ошибок', () => {
    const root = path.join(__dirname, '..');
    const files = [];
    const templatesDir = path.join(root, 'templates');
    if (fs.existsSync(templatesDir)) {
        for (const dir of fs.readdirSync(templatesDir)) {
            const file = path.join(templatesDir, dir, 'index.html');
            if (fs.existsSync(file)) files.push(file);
        }
    }
    const testGamesDir = path.join(root, 'test-games');
    if (fs.existsSync(testGamesDir)) {
        for (const name of fs.readdirSync(testGamesDir)) {
            if (name.endsWith('.html')) files.push(path.join(testGamesDir, name));
        }
    }
    assert.ok(files.length > 0, 'не найдено ни одного шаблона или тестовой игры');
    for (const file of files) {
        const result = checkRuntimeErrors(fs.readFileSync(file, 'utf8'));
        assert.equal(result.ok, true, `${path.basename(file)} падает при загрузке: ${JSON.stringify(result.errors)}`);
    }
});
