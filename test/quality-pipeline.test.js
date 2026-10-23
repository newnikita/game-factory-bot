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

test('runQualityPipeline без модели оставляет код и считает технический балл', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    gemini.generate = async () => { throw new Error('модель недоступна'); };
    gemini.generateJson = async () => { throw new Error('модель недоступна'); };
    try {
        const report = await bot.runQualityPipeline(BROKEN_GAME, { platform: 'mobile' });
        assert.equal(report.code, BROKEN_GAME);
        assert.equal(report.patched, false);
        assert.equal(report.polished, false);
        assert.equal(report.criticScore, null);
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
    gemini.generate = async () => ({ text: GOOD_GAME, usage: {}, model: 'test' });
    gemini.generateJson = async () => ({ data: { score: 90, issues: [] }, usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(GOOD_GAME, { platform: 'mobile' });
        assert.equal(report.criticScore, 90);
        assert.equal(report.score, Math.round(report.technicalScore * 0.6 + 90 * 0.4));
        assert.equal(report.polished, false, 'score выше порога полиш не нужен');
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});

test('runQualityPipeline без вердикта критика не штрафует и не полирует', async () => {
    const original = gemini.generate;
    const originalJson = gemini.generateJson;
    let generateCalls = 0;
    gemini.generate = async () => { generateCalls += 1; throw new Error('модель недоступна'); };
    gemini.generateJson = async () => ({ data: null, raw: 'не json', usage: {}, model: 'test' });
    try {
        const report = await bot.runQualityPipeline(GOOD_GAME, { platform: 'mobile' });
        assert.equal(report.criticScore, null);
        assert.equal(report.critic.noVerdict, true);
        assert.equal(report.score, report.technicalScore);
        assert.equal(report.polished, false);
        assert.equal(generateCalls, 0, 'полиш не должен запускаться без оценки');
    } finally {
        gemini.generate = original;
        gemini.generateJson = originalJson;
    }
});
