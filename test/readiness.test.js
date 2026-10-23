const test = require('node:test');
const assert = require('node:assert/strict');
const { legalValues, renderLegal, missingPlaceholders, readinessReport } = require('../lib/readiness');

const env = {
    SUPPORT_EMAIL: 'owner@example.com',
    SUPPORT_USERNAME: '@owner',
    WEBAPP_URL: 'https://example.com',
    ADMIN_IDS: '999',
    BOT_TOKEN: 'x',
    GEMINI_API_KEY: 'y'
};

test('реквизиты подставляются в текст документа', () => {
    const values = legalValues(env);
    const text = renderLegal('Пишите: [email] или [@username]. Реквизиты: [ИНН].', values);
    assert.match(text, /owner@example\.com/);
    assert.match(text, /@owner/);
    assert.match(text, /\[ИНН\]/, 'незаполненные поля остаются на месте');
});

test('ссылки в markdown не считаются плейсхолдерами', () => {
    const docs = [{ file: 'offer.md', text: 'См. [Правила](https://example.com/rules.md) и [email].' }];
    const missing = missingPlaceholders(docs, legalValues({}));
    assert.deepEqual(missing, ['[email]']);
});

test('отчёт о готовности перечисляет незаполненные поля и настройки', () => {
    const docs = [
        { file: 'offer.md', text: 'Пишите: [email].' },
        { file: 'refunds.md', text: 'Ответим за [срок] рабочих дней.' }
    ];
    const report = readinessReport({ env, legalDocs: docs });
    assert.equal(report.bot_token, true);
    assert.equal(report.gemini_key, true);
    assert.equal(report.webapp_url, true);
    assert.equal(report.admin_ids, true);
    assert.equal(report.admin_api_token, false);
    assert.equal(report.moderation, false);
    assert.equal(report.legal_files, 2);
    assert.deepEqual(report.legal_missing, ['[срок]']);
});

test('без секретов визуального токена отчёт показывает источник', () => {
    const report = readinessReport({ env: { BOT_TOKEN: 'x' }, legalDocs: [] });
    assert.equal(report.visual_secret, 'bot_token');
    assert.deepEqual(report.legal_missing, []);
});
