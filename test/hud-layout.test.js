const test = require('node:test');
const assert = require('node:assert/strict');
const { auditHudLayout } = require('../lib/hud-layout');
const { auditVisuals } = require('../lib/game-quality');

const page = (style, body) => `<!DOCTYPE html><html><head><style>${style}</style></head><body>${body}</body></html>`;

const HUD_STYLE = `
    #hud-top { position: absolute; top: 10px; left: 15px; right: 15px; display: flex; justify-content: space-between; }
    .hud-panel { background: rgba(0,0,0,0.6); padding: 6px 12px; }
`;

const OVERLAPPING = page(
    HUD_STYLE + `#pause-trigger { position: absolute; top: 10px; right: 15px; width: 40px; height: 40px; background: rgba(0,0,0,0.6); }`,
    `<div id="game-container"><div id="hud-top"><div class="hud-panel">Волна: 1/5</div></div><div id="pause-trigger">II</div></div>`
);

const SEPARATED = page(
    HUD_STYLE + `#pause-trigger { position: absolute; top: 90px; right: 15px; width: 40px; height: 40px; background: rgba(0,0,0,0.6); }`,
    `<div id="game-container"><div id="hud-top"><div class="hud-panel">Волна: 1/5</div></div><div id="pause-trigger">II</div></div>`
);

const INSIDE_HUD = page(
    HUD_STYLE + `#hud-top .badge { position: absolute; top: 10px; right: 15px; width: 40px; height: 20px; background: rgba(0,0,0,0.6); }`,
    `<div id="game-container"><div id="hud-top"><div class="hud-panel">Волна: 1/5</div><span id="badge">II</span></div></div>`
);

const CANVAS_ONLY = page(
    `.panel { position: absolute; top: 10px; right: 15px; width: 40px; height: 40px; background: rgba(0,0,0,0.6); }`,
    `<div id="game-container"><canvas id="game"></canvas><div class="panel">II</div></div>`
);

test('элемент, накрывающий панель HUD, помечается', () => {
    const result = auditHudLayout(OVERLAPPING);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'hud_overlap');
    assert.match(result.issues[0].msg, /pause-trigger/);
    assert.match(result.issues[0].msg, /hud-top/);
});

test('разнесённые по вертикали элементы HUD не считаются перекрытием', () => {
    const result = auditHudLayout(SEPARATED);
    assert.deepEqual(result.issues, []);
});

test('элемент внутри самой панели HUD не считается перекрытием', () => {
    const result = auditHudLayout(INSIDE_HUD);
    assert.deepEqual(result.issues, []);
});

test('игра без DOM-HUD не считается перекрытой', () => {
    const result = auditHudLayout(CANVAS_ONLY);
    assert.deepEqual(result.issues, []);
});

test('наложение HUD снижает визуальную оценку и попадает в отчёт', () => {
    const visual = auditVisuals(OVERLAPPING);
    assert.equal(visual.features.hudOverlap, true);
    assert.ok(visual.issues.some((issue) => issue.code === 'hud_overlap'));
    assert.ok(visual.ceiling < 100);
});
