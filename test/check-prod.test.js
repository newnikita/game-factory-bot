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
        telegram: { mode: 'webhook', webhook_url: 'https://example.com/telegram/webhook', pending_updates: 0, last_error: null },
        snapshots: { enabled: false, configured: false, requested: true, last_snapshot_at: null, last_error: null },
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

test('временная ФС без снапшотов считается провалом', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, data_dir: '/opt/render/project/src', data_persistent: false }
    }), ready);
    assert.equal(report.ok, false);
    const names = report.failed.map((item) => item.name);
    assert.ok(names.includes('данные переживают деплой'));
});

test('снапшоты в R2 на Free-плане проходят проверку с предупреждением', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, data_dir: '/opt/render/project/src', data_persistent: false },
        snapshots: { enabled: true, configured: true, requested: true, last_snapshot_at: '2026-10-24T10:00:00.000Z', last_error: null }
    }), ready);
    assert.equal(report.ok, true);
    assert.match(report.checks.find((item) => item.name === 'данные переживают деплой').detail, /R2/);
    const names = report.warnings.map((item) => item.name);
    assert.ok(names.includes('постоянный диск'));
    assert.ok(!names.includes('первый снапшот'));
});

test('провайдер Supabase называется в отчёте явно', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, data_dir: '/opt/render/project/src', data_persistent: false },
        snapshots: {
            provider: 'supabase',
            enabled: true,
            configured: true,
            requested: true,
            last_snapshot_at: '2026-10-25T11:28:00.000Z',
            last_error: null
        }
    }), ready);
    assert.equal(report.ok, true);
    assert.match(report.checks.find((item) => item.name === 'данные переживают деплой').detail, /Supabase Storage/);
    assert.match(report.warnings.find((item) => item.name === 'постоянный диск').detail, /Supabase Storage/);
});

test('polling на проде считается провалом', () => {
    const report = evaluateHealth(health({ telegram: { mode: 'polling', last_error: null } }), ready);
    assert.equal(report.ok, false);
    assert.ok(report.failed.some((item) => item.name === 'Telegram в webhook-режиме'));
});

test('ошибка webhook считается провалом', () => {
    const report = evaluateHealth(health({ telegram: { mode: 'webhook', last_error: 'wrong response' } }), ready);
    assert.equal(report.ok, false);
    assert.ok(report.failed.some((item) => item.name === 'webhook без ошибок'));
});

test('ошибка снапшотов считается провалом', () => {
    const report = evaluateHealth(health({
        config: { ...health().config, data_dir: '/opt/render/project/src', data_persistent: false },
        snapshots: { enabled: true, configured: true, requested: true, last_snapshot_at: null, last_error: 'HTTP 403' }
    }), ready);
    assert.equal(report.ok, false);
    assert.equal(report.failed[0].name, 'данные переживают деплой');
    assert.match(report.failed[0].detail, /HTTP 403/);
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
