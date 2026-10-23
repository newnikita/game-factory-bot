const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { legalValues, renderLegal, missingPlaceholders, readinessReport, loadConfig, isPersistentDataDir } = require('../lib/readiness');

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

test('реквизиты берутся из config.json, если их нет в переменных окружения', () => {
    const values = legalValues({ SUPPORT_EMAIL: 'env@example.com' }, { supportEmail: 'config@example.com', refundPeriodDays: '14' });
    assert.equal(values['[email]'], 'env@example.com', 'переменная окружения приоритетнее');
    assert.equal(values['[срок]'], '14');
});

test('отчёт учитывает админов и каталог данных из конфигурации приложения', () => {
    const report = readinessReport({ env: {}, legalDocs: [], adminIds: [6430160880], dataDir: '/var/data' });
    assert.equal(report.admin_ids, true);
    assert.equal(report.data_dir, '/var/data');
});

test('в поставленном config.json указан хотя бы один администратор', () => {
    const config = loadConfig();
    assert.ok(Array.isArray(config.adminIds), 'adminIds должен быть массивом');
    assert.ok(config.adminIds.length > 0, 'без админов команды /stats, /grant и /refund отключены');
    assert.ok(config.adminIds.every((id) => Number.isSafeInteger(id) && id > 0), 'идентификаторы админов должны быть числами');
});

test('каталог внутри каталога приложения считается непостоянным', () => {
    const appDir = path.join(__dirname, '..');
    assert.equal(isPersistentDataDir(appDir, appDir), false);
    assert.equal(isPersistentDataDir(path.join(appDir, 'нет-такой-папки'), appDir), false);
});
