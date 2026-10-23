const test = require('node:test');
const assert = require('node:assert/strict');
const vision = require('../lib/game-vision');
const gemini = require('../lib/gemini');

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
