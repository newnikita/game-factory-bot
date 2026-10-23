const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRuntimeErrors } = require('../lib/game-runtime-check');
const { scanTopLevel } = require('../lib/js-top-level');
const { isTdzError, tdzVariableName, findTdzIssues, repairTdzErrors } = require('../lib/tdz-repair');

const wrap = (js) => `<!DOCTYPE html><html><body><canvas id="game"></canvas><script>\n${js}\n</script></body></html>`;

const BROKEN = wrap(`
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function initParallax() {
    bgBuildingsFar.length = 0;
}
initParallax();
const bgBuildingsFar = [];
`);

const HEALTHY = wrap(`
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

test('ошибка temporal dead zone распознаётся', () => {
    const error = { name: 'ReferenceError', message: "Cannot access 'bgBuildingsFar' before initialization" };
    assert.equal(isTdzError(error), true);
    assert.equal(tdzVariableName(error), 'bgBuildingsFar');
    assert.equal(isTdzError({ name: 'TypeError', message: 'x is not a function' }), false);
    assert.equal(isTdzError({ name: 'ReferenceError', message: 'x is not defined' }), false);
});

test('поиск проблем temporal dead zone выбирает только их', () => {
    const issues = findTdzIssues([
        { name: 'TypeError', message: 'boom' },
        { name: 'ReferenceError', message: "Cannot access 'x' before initialization", script: 1, callLine: 12 }
    ]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].variable, 'x');
    assert.equal(issues[0].callLine, 12);
});

test('упавшая при загрузке игра чинится без модели', () => {
    const before = checkRuntimeErrors(BROKEN);
    assert.equal(before.ok, false);

    const result = repairTdzErrors(BROKEN);
    assert.equal(result.changed, true);
    assert.deepEqual(result.fixes.map((fix) => fix.variable), ['bgBuildingsFar']);
    assert.equal(checkRuntimeErrors(result.code).ok, true);
});

test('объявление переносится выше места вызова', () => {
    const result = repairTdzErrors(BROKEN);
    const declaration = result.code.indexOf('const bgBuildingsFar');
    const call = result.code.indexOf('initParallax();');
    assert.ok(declaration !== -1 && call !== -1);
    assert.ok(declaration < call, 'объявление должно оказаться выше вызова');
});

test('здоровая игра остаётся нетронутой', () => {
    const result = repairTdzErrors(HEALTHY);
    assert.equal(result.changed, false);
    assert.equal(result.code, HEALTHY);
});

test('ошибка не temporal dead zone не чинится', () => {
    const html = wrap(`
const value = null;
value.missing();
`);
    const result = repairTdzErrors(html);
    assert.equal(result.changed, false);
});

test('зависимости переносятся вместе с объявлением', () => {
    const html = wrap(`
function init() { doubled.push(1); }
init();
const base = [1, 2];
const doubled = base.map((x) => x * 2);
`);
    const result = repairTdzErrors(html);
    assert.equal(result.changed, true);
    assert.equal(checkRuntimeErrors(result.code).ok, true);
    assert.ok(result.code.indexOf('const base') < result.code.indexOf('const doubled'));
});

test('строки, регулярки и шаблонные литералы не сбивают разбор', () => {
    const html = wrap(`
const re = /\\d{2,3}/g;
const label = "a;b}c";
const tpl = \`x=\${1 + 2}\`;
function init() { items.length = 0; }
init();
const items = [];
`);
    const result = repairTdzErrors(html);
    assert.equal(result.changed, true);
    assert.equal(checkRuntimeErrors(result.code).ok, true);
    assert.ok(result.code.includes('const re = /\\d{2,3}/g;'));
    assert.ok(result.code.includes('const label = "a;b}c";'));
});

test('переменная не из этого скрипта не чинится', () => {
    const html = wrap(`
function init() { externalThing.push(1); }
init();
`);
    const result = repairTdzErrors(html);
    assert.equal(result.changed, false);
});

test('разбор верхнего уровня находит границы операторов и объявления', () => {
    const statements = scanTopLevel(`
const a = 1;
let b = 2;
function draw() { ctx.fillRect(0, 0, 1, 1); }
class Enemy {}
`);
    const names = statements.flatMap((statement) => statement.decls.map((decl) => decl.name));
    assert.deepEqual(names, ['a', 'b', 'Enemy']);
    const draw = statements.find((statement) => statement.text.startsWith('function draw'));
    assert.ok(draw, 'функция draw должна быть отдельным оператором');
    assert.ok(draw.text.includes('ctx.fillRect'));
    assert.equal(statements[0].line, 2);
});
