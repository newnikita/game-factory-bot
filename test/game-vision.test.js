const test = require('node:test');
const assert = require('node:assert/strict');
const vision = require('../lib/game-vision');
const gemini = require('../lib/gemini');
const { auditGame, auditVisuals } = require('../lib/game-quality');

test('normalizeCritic приводит оценку к шкале 0-100', () => {
    assert.equal(vision.normalizeCritic({ score: 87 }).score, 87);
    assert.equal(vision.normalizeCritic({ score: 250 }).score, 100);
    assert.equal(vision.normalizeCritic({ score: -20 }).score, 0);
    assert.equal(vision.normalizeCritic({}).score, 0);
});

test('normalizeCriteria считает среднее по критериям', () => {
    const result = vision.normalizeCriteria({
        objects: 90, background: 80, decor: 70, contrast: 100, hud: 60, palette: 80, effects: 80
    });
    assert.equal(result.rubricScore, 80);
    assert.equal(result.criteria.objects, 90);
    assert.equal(result.criteria.hud, 60);
});

test('normalizeCriteria опускает рубрику до 70 при двух слабых критериях', () => {
    const result = vision.normalizeCriteria({
        objects: 40, background: 45, decor: 92, contrast: 95, hud: 94, palette: 90, effects: 88
    });
    assert.equal(result.rubricScore, 70);
});

test('normalizeCriteria не опускает рубрику при одном слабом критерии', () => {
    const result = vision.normalizeCriteria({
        objects: 40, background: 90, decor: 85, contrast: 90, hud: 85, palette: 88, effects: 84
    });
    assert.equal(result.rubricScore, 80);
});

test('normalizeCriteria игнорирует мусор и даёт null при малом числе критериев', () => {
    assert.equal(vision.normalizeCriteria(null).rubricScore, null);
    assert.equal(vision.normalizeCriteria({}).rubricScore, null);
    assert.equal(vision.normalizeCriteria({ objects: 50, background: 50 }).rubricScore, null);
    assert.equal(vision.normalizeCriteria({ objects: 'abc', background: null }).rubricScore, null);
});

test('normalizeCriteria обрезает значения в шкалу 0-100', () => {
    const result = vision.normalizeCriteria({
        objects: 250, background: -30, decor: 55.6, contrast: 70, hud: 70, palette: 70, effects: 70
    });
    assert.equal(result.criteria.objects, 100);
    assert.equal(result.criteria.background, 0);
    assert.equal(result.criteria.decor, 56);
});

test('normalizeCritic отдаёт рубрику и её оценку', () => {
    const critic = vision.normalizeCritic({
        score: 92,
        criteria: { objects: 40, background: 45, decor: 92, contrast: 95, hud: 94, palette: 90, effects: 88 }
    });
    assert.equal(critic.rubricScore, 70);
    assert.equal(critic.criteria.objects, 40);
});

test('buildCriticResult без оценки не выдумывает рубрику', () => {
    assert.equal(vision.buildCriticResult(null).rubricScore, null);
    const critic = vision.buildCriticResult({ criteria: { objects: 30, background: 40, decor: 30 } });
    assert.equal(critic.score, null);
    assert.equal(critic.rubricScore, null);
});

test('buildReviewPrompt требует критерии рубрики', () => {
    const prompt = vision.buildReviewPrompt({ platform: 'mobile' });
    assert.match(prompt, /criteria/);
    assert.match(prompt, /objects, background, decor, contrast, hud, palette, effects/);
});

test('normalizeCritic нормализует уровни замечаний', () => {
    const critic = vision.normalizeCritic({
        score: 50,
        issues: [
            { code: 'a', level: 'blocker', msg: 'не запускается' },
            { code: 'b', level: 'warn', msg: 'медленно' },
            { code: 'c', level: 'polish', msg: 'можно лучше' },
            { code: 'd', level: 'что-то ещё', msg: 'неизвестный уровень' }
        ]
    });
    assert.deepEqual(critic.issues.map((issue) => issue.level), ['critical', 'warning', 'polish', 'polish']);
});

test('normalizeCritic выкидывает замечания без текста', () => {
    const critic = vision.normalizeCritic({ score: 80, issues: [{ msg: '' }, null, 'строка', { msg: 'ок' }] });
    assert.equal(critic.issues.length, 1);
    assert.equal(critic.issues[0].msg, 'ок');
});

test('normalizeCritic обрезает длинные поля и лимитирует число замечаний', () => {
    const critic = vision.normalizeCritic({
        score: 60,
        verdict: 'v'.repeat(500),
        issues: Array.from({ length: 30 }, (_, index) => ({ code: 'c' + index, level: 'warning', msg: 'm'.repeat(900) })),
        strengths: Array.from({ length: 20 }, () => 's'.repeat(400))
    });
    assert.equal(critic.verdict.length, 300);
    assert.equal(critic.issues.length, 12);
    assert.equal(critic.issues[0].msg.length, 400);
    assert.equal(critic.strengths.length, 6);
    assert.equal(critic.strengths[0].length, 160);
});

test('normalizeCritic не падает на мусоре', () => {
    const critic = vision.normalizeCritic(null);
    assert.equal(critic.score, 0);
    assert.deepEqual(critic.issues, []);
    assert.deepEqual(critic.strengths, []);
});

test('criticToIssues отдаёт только critical и warning с подсказкой исправления', () => {
    const issues = vision.criticToIssues({
        issues: [
            { level: 'critical', code: 'x', msg: 'сломалось', fix: 'починить' },
            { level: 'warning', code: 'y', msg: 'медленно' },
            { level: 'polish', code: 'z', msg: 'мелочь' }
        ]
    });
    assert.equal(issues.length, 2);
    assert.match(issues[0].msg, /починить/);
    assert.equal(issues[1].msg, 'медленно');
});

test('criticToIssues возвращает пустой список без крититики', () => {
    assert.deepEqual(vision.criticToIssues({ issues: [{ level: 'polish', msg: 'мелочь' }] }), []);
    assert.deepEqual(vision.criticToIssues(null), []);
});

test('buildReviewPrompt включает замысел, план и платформу', () => {
    const prompt = vision.buildReviewPrompt({ brief: 'Платформер про духа', plan: 'волны светлячков', platform: 'mobile' });
    assert.match(prompt, /Платформер про духа/);
    assert.match(prompt, /волны светлячков/);
    assert.match(prompt, /телефон/);
    assert.match(prompt, /ХУДОЖЕСТВЕННЫЙ/i);
});

test('buildReviewPrompt для ПК просит мышь и клавиатуру', () => {
    assert.match(vision.buildReviewPrompt({ platform: 'pc' }), /ПК/);
});

test('buildReviewPrompt требует визуальный чек-лист и ориентиры оценки', () => {
    const prompt = vision.buildReviewPrompt({ platform: 'mobile' });
    assert.match(prompt, /ВИЗУАЛЬНЫЙ ЧЕК-ЛИСТ/);
    assert.match(prompt, /не выше 50/);
    assert.match(prompt, /перенос|вторую строку/i);
    assert.match(prompt, /ЭКРАН НЕ ПОКАЗАН/);
});

test('buildReviewPrompt подставляет результаты автоматического аудита графики', () => {
    const prompt = vision.buildReviewPrompt({
        platform: 'mobile',
        visualAudit: { issues: [{ code: 'flat_background', msg: 'фон однотонный', fix: 'сделай слои' }] }
    });
    assert.match(prompt, /АВТОМАТИЧЕСКИЙ АУДИТ ГРАФИКИ/);
    assert.match(prompt, /фон однотонный/);
});

test('buildCriticResult без разбора JSON не даёт оценки', () => {
    const critic = vision.buildCriticResult(null);
    assert.equal(critic.score, null);
    assert.equal(critic.noVerdict, true);
    assert.equal(critic.reason, 'json_unparsed');
    assert.deepEqual(critic.issues, []);
});

test('buildCriticResult без поля score не даёт оценки', () => {
    const critic = vision.buildCriticResult({ issues: [{ level: 'warning', msg: 'медленно' }] });
    assert.equal(critic.score, null);
    assert.equal(critic.noVerdict, true);
    assert.equal(critic.reason, 'no_score');
});

test('buildCriticResult с оценкой работает как раньше', () => {
    const critic = vision.buildCriticResult({ score: 87, issues: [{ level: 'critical', msg: 'сломано' }] });
    assert.equal(critic.score, 87);
    assert.equal(critic.noVerdict, false);
    assert.equal(critic.issues.length, 1);
});

test('buildCriticResult сохраняет модель и расход токенов', () => {
    const critic = vision.buildCriticResult({ score: 50 }, { model: 'test-model', usage: { inputTokens: 3 } });
    assert.equal(critic.model, 'test-model');
    assert.equal(critic.usage.inputTokens, 3);
});

test('reviewCode при нечитаемом ответе отдаёт null вместо нуля', async () => {
    const original = gemini.generateJson;
    gemini.generateJson = async () => ({ data: null, raw: 'просто текст', usage: {}, model: 'test' });
    try {
        const critic = await vision.reviewCode('<html></html>', { platform: 'mobile' });
        assert.equal(critic.score, null);
        assert.equal(critic.noVerdict, true);
    } finally {
        gemini.generateJson = original;
    }
});

const RICH_CODE = `<!DOCTYPE html>
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
}
function spawn() { particles.push({ x: 0, y: 0, color: '#ffd700' }); }
function loop() { requestAnimationFrame(loop); ctx.save(); ctx.rotate(Math.sin(performance.now() / 400) * 0.2); ctx.restore(); }
loop();
</script>
</body></html>`;

const FLAT_CODE = `<!DOCTYPE html>
<html><head><style>body{margin:0}</style></head>
<body>
<canvas id="game"></canvas>
<script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function loop() { requestAnimationFrame(loop); ctx.fillRect(0, 0, 10, 10); ctx.fillRect(20, 20, 10, 10); ctx.fillRect(40, 40, 10, 10); }
loop();
</script>
</body></html>`;

test('localCritic оценивает богатую графику выше примитивов', () => {
    const rich = vision.localCritic(auditVisuals(RICH_CODE), auditGame(RICH_CODE, 'mobile'));
    const flat = vision.localCritic(auditVisuals(FLAT_CODE), auditGame(FLAT_CODE, 'mobile'));
    assert.ok(rich.score > flat.score, `богатая графика ${rich.score} должна быть выше примитивов ${flat.score}`);
    assert.ok(rich.score >= 60, 'богатая графика без модели должна получать достойную оценку');
    assert.ok(flat.score < 50, 'примитивы без модели должны получать низкую оценку');
});

test('localCritic заполняет все критерии рубрики', () => {
    const critic = vision.localCritic(auditVisuals(RICH_CODE), auditGame(RICH_CODE, 'mobile'));
    for (const key of ['objects', 'background', 'decor', 'contrast', 'hud', 'palette', 'effects']) {
        assert.equal(typeof critic.criteria[key], 'number', `критерий ${key} должен быть заполнен`);
    }
    assert.equal(critic.rubricScore, Math.round(Object.values(critic.criteria).reduce((sum, value) => sum + value, 0) / 7));
    assert.equal(critic.noVerdict, false);
    assert.equal(critic.reason, 'local_audit');
    assert.equal(critic.model, null);
});

test('localCritic не ставит оценку выше потолка аудита', () => {
    const visual = auditVisuals(FLAT_CODE);
    const critic = vision.localCritic(visual, auditGame(FLAT_CODE, 'mobile'));
    assert.ok(critic.score <= visual.score);
    assert.ok(critic.issues.length > 0, 'замечания аудита должны попасть в вердикт');
});

test('localCritic опускает HUD-критерий при сломанном HUD', () => {
    const brokenHud = `<!DOCTYPE html><html><body><canvas id="game"></canvas><script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
ctx.scale(dpr, dpr);
function loop() { requestAnimationFrame(loop); ctx.font = '20px * dpr sans-serif'; ctx.fillText('счёт', 10, 10); }
loop();
</script></body></html>`;
    const critic = vision.localCritic(auditVisuals(brokenHud), auditGame(brokenHud, 'mobile'));
    assert.ok(critic.criteria.hud <= 40, `сломанный HUD должен потерять баллы, получено ${critic.criteria.hud}`);
});
