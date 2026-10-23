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
