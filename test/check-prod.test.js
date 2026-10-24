const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHealth } = require('../scripts/check-prod');

function health(overrides) {
    return {
        ok: true,
        version: 'abc123',
        config: {
            bot_token: true,
            gemini_key: true,
            webapp_url: true,
            games_public_url: true,
            data_dir: '/var/data',
            data_persistent: true,
            admin_ids: true,
            admin_api_token: true,
            visual_secret: 'own',
            legal_missing: []
        },
        gemini: { generation_available: true, reason: 'генерации доступны' },
        alerts: [],
        ...overrides
    };
}

const ready = { ok: true };

test('здоровый прод проходит все обязательные проверки', () => {
    const report = evaluateHealth(health(), ready);
    assert.equal(report.ok, true);
    assert.equal(report.failed.length, 0);
    assert.equal(report.warnings.length, 0);
});

test('база во временной ФС считается провалом', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, data_dir: '/opt/render/project/src', data_persistent: false }
    }), ready);
    assert.equal(report.ok, false);
    const names = report.failed.map((item) => item.name);
    assert.ok(names.includes('каталог данных на диске'));
    assert.ok(names.includes('диск постоянный'));
});

test('незаданные секреты считаются провалом', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, admin_api_token: false, visual_secret: 'bot_token' }
    }), ready);
    assert.equal(report.ok, false);
    const names = report.failed.map((item) => item.name);
    assert.ok(names.includes('админ-токен задан'));
    assert.ok(names.includes('секрет замера свой'));
});

test('недоступная база ломает готовность', () => {
    const report = evaluateHealth(health(), { ok: false, error: 'database_unavailable' });
    assert.equal(report.ok, false);
    assert.equal(report.failed[0].name, '/readyz: база доступна');
});

test('реквизиты и квота Gemini дают предупреждения, а не провал', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, legal_missing: ['[ИНН]', '[email]'] },
        gemini: { generation_available: false, reason: 'квота исчерпана' }
    }), ready);
    assert.equal(report.ok, true);
    assert.equal(report.warnings.length, 2);
    assert.match(report.warnings[0].detail, /\[ИНН\]/);
});

test('алерты монитора попадают в предупреждения', () => {
    const report = evaluateHealth(health({
        alerts: [{ key: 'critic_silent', message: 'критик не отвечает' }]
    }), ready);
    assert.equal(report.ok, true);
    assert.equal(report.warnings[0].name, 'алерт: critic_silent');
});
