const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../lib/gemini');
const bot = require('../bot');

const GOOD_GAME = `<!DOCTYPE html>
<html><head><style>body{margin:0}</style></head>
<body>
<canvas id="game"></canvas>
<script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let state = 'menu';
function resize() { canvas.width = canvas.clientWidth; }
window.addEventListener('pointerdown', () => { state = 'play'; });
function loop() { requestAnimationFrame(loop); ctx.clearRect(0, 0, canvas.width, canvas.height); }
loop();
</script>
</body></html>`;

const BROKEN_GAME = '<html><body><div>нет canvas</div></body></html>';

const RICH_GAME = `<!DOCTYPE html>
<html><head><style>body{margin:0}</style></head>
<body>
<canvas id="game"></canvas>
<script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const particles = [];
function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, 800);
    grad.addColorStop(0, '#101026');
    grad.addColorStop(1, '#26264d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 400, 800);
}
function drawParallaxLayer(offset) {
    ctx.fillStyle = '#00f3ff';
    ctx.beginPath();
    ctx.moveTo(0, 800);
    ctx.lineTo(100 + offset, 400);
    ctx.lineTo(400, 800);
    ctx.closePath();
    ctx.fill();
}
function drawHero() {
    ctx.shadowColor = '#00f3ff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(200, 300, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.rotate(Math.sin(performance.now() / 400) * 0.2);
    ctx.restore();
}
function spawn() { particles.push({ x: 0, y: 0, color: '#ffd700' }); }
let state = 'menu';
window.addEventListener('pointerdown', () => { state = 'play'; });
function loop() { requestAnimationFrame(loop); ctx.clearRect(0, 0, canvas.width, canvas.height); }
loop();
</script>
</body></html>`;

test('collectQualityIssues собирает валидацию и аудит вместе', () => {
    const result = bot.collectQualityIssues(BROKEN_GAME, 'mobile');
    assert.ok(result.criticals.length > 0);
    assert.equal(result.technicalScore, result.audit.score);
    assert.ok(result.issues.length >= result.criticals.length);
});

test('collectQualityIssues на чистой игре не находит критичных замечаний', () => {
    const result = bot.collectQualityIssues(GOOD_GAME, 'mobile');
    assert.equal(result.criticals.length, 0);
});

test('runQualityPipeline без модели оценивает игру по автоматическому аудиту', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => { throw new Error('модель недоступна'); };
    gemini.generateJson = async () => { throw new Error('модель недоступна'); };
    try {
        const report = await bot.runQualityPipeline(BROKEN_GAME, { platform: 'mobile' });
        assert.equal(report.code, BROKEN_GAME);
        assert.equal(report.patched, false);
        assert.equal(report.polished, false);
        assert.equal(report.criticSource, 'audit', 'без модели игру оценивает аудит, а не никто');
        assert.equal(typeof report.criticScore, 'number');
        assert.ok(report.criticScore < 60, 'плоская графика без модели должна получить низкую оценку');
        assert.equal(report.effectiveCriticScore, report.criticScore);
        assert.ok(report.score < report.technicalScore, 'игра без вердикта модели не должна завышаться');
        assert.ok(report.technicalScore >= 0);
        assert.ok(report.issues.length > 0);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline применяет точечный патч и закрывает критичные замечания', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => { throw new Error('модель недоступна'); };
    gemini.generateJson = async (options) => {
        assert.match(JSON.stringify(options.contents), /нет элемента <canvas>/);
        return {
            data: { edits: [{ find: BROKEN_GAME, replace: GOOD_GAME }] },
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'test'
        };
    };
    try {
        const report = await bot.runQualityPipeline(BROKEN_GAME, { platform: 'mobile' });
        assert.equal(report.patched, true);
        assert.match(report.code, /requestAnimationFrame/);
        assert.equal(report.issues.filter((issue) => issue.level === 'critical').length, 0);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline не принимает патч, который не закрыл критичные замечания', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => { throw new Error('модель недоступна'); };
    gemini.generateJson = async () => ({
        data: { edits: [{ find: '<div>нет canvas</div>', replace: '<canvas id="game"></canvas>' }] },
        usage: {},
        model: 'test'
    });
    try {
        const report = await bot.runQualityPipeline(BROKEN_GAME, { platform: 'mobile' });
        assert.equal(report.patched, false);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline откатывает полиш, который ухудшил код', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => ({ text: '<html><body><canvas></canvas></body></html>', usage: {}, model: 'test' });
    gemini.generateJson = async () => ({ data: { score: 50, issues: [] }, usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(GOOD_GAME, { platform: 'mobile' });
        assert.equal(report.polished, false);
        assert.equal(report.code, GOOD_GAME);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline смешивает технический балл и оценку критика', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => ({ text: RICH_GAME, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({ data: { score: 90, issues: [] }, usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(RICH_GAME, { platform: 'mobile' });
        assert.equal(report.criticScore, 90);
        assert.equal(report.effectiveCriticScore, 90);
        assert.equal(report.visualScore, 100);
        assert.equal(report.score, Math.round(report.technicalScore * 0.6 + 90 * 0.4));
        assert.equal(report.polished, false, 'score выше порога полиш не нужен');
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline урезает оценку критика по аудиту графики', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => ({ text: GOOD_GAME, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({ data: { score: 95, issues: [] }, usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(GOOD_GAME, { platform: 'mobile' });
        assert.equal(report.criticScore, 95);
        assert.ok(report.visualScore < 60, 'плоская графика должна получить низкий визуальный балл');
        assert.equal(report.effectiveCriticScore, Math.max(45, report.visualScore));
        assert.ok(report.effectiveCriticScore < 95);
        assert.equal(report.polished, true, 'плоская графика обязана уйти в полиш');
        assert.equal(report.score, Math.round(report.technicalScore * 0.6 + report.effectiveCriticScore * 0.4));
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline урезает оценку критика по рубрике', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => ({ text: RICH_GAME, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({
        data: {
            score: 92,
            criteria: { objects: 40, background: 45, decor: 92, contrast: 95, hud: 94, palette: 90, effects: 88 },
            issues: []
        },
        usage: {},
        model: 'test'
    });
    try {
        const report = await bot.runQualityPipeline(RICH_GAME, { platform: 'mobile' });
        assert.equal(report.criticScore, 92);
        assert.equal(report.rubricScore, 70, 'две слабые критерии опускают рубрику до 70');
        assert.equal(report.effectiveCriticScore, 70, 'оценка не может быть выше рубрики');
        assert.equal(report.polished, true, 'низкая рубрика обязана отправить игру в полиш');
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline не отправляет в полиш игру с сильной рубрикой', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => ({ text: RICH_GAME, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({
        data: {
            score: 90,
            criteria: { objects: 92, background: 88, decor: 85, contrast: 90, hud: 86, palette: 92, effects: 84 },
            issues: []
        },
        usage: {},
        model: 'test'
    });
    try {
        const report = await bot.runQualityPipeline(RICH_GAME, { platform: 'mobile' });
        assert.equal(report.rubricScore, 88);
        assert.equal(report.effectiveCriticScore, 88);
        assert.equal(report.polished, false);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline без критериев в ответе критика оставляет оценку как есть', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => ({ text: RICH_GAME, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({ data: { score: 90, issues: [] }, usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(RICH_GAME, { platform: 'mobile' });
        assert.equal(report.rubricScore, null);
        assert.equal(report.effectiveCriticScore, 90);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline не принимает полиш, который ухудшил графику', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    const flatter = GOOD_GAME.replace(
        'ctx.clearRect(0, 0, canvas.width, canvas.height);',
        'ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillRect(0, 0, 10, 10); ctx.fillRect(20, 20, 10, 10); ctx.fillRect(40, 40, 10, 10);'
    );
    gemini.generate = async () => ({ text: flatter, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({ data: { score: 10, issues: [] }, usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(GOOD_GAME, { platform: 'mobile' });
        assert.equal(report.polished, false);
        assert.equal(report.code, GOOD_GAME);
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline без вердикта модели переходит на оценку по аудиту', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    let generateCalls = 0;
    gemini.generate = async () => { generateCalls += 1; throw new Error('модель недоступна'); };
    gemini.generateJson = async () => ({ data: null, raw: 'не json', usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(GOOD_GAME, { platform: 'mobile' });
        assert.equal(report.criticSource, 'audit');
        assert.equal(report.critic.reason, 'local_audit');
        assert.equal(typeof report.criticScore, 'number');
        assert.ok(report.score < report.technicalScore, 'игра без вердикта модели не должна завышаться');
        assert.equal(report.polished, false, 'полиш без модели не может примениться');
        assert.equal(report.code, GOOD_GAME);
        assert.equal(generateCalls, 1, 'полиш должен быть запущен, но модель недоступна');
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});
