const test = require('node:test');
const assert = require('node:assert/strict');
const {
    escapeHtml,
    sanitizeGameTitle,
    sanitizeBgFilename,
    sanitizePlatform,
    sanitizeEngine,
    sanitizeBiome,
    isSafeGameId,
    safeCssUrl,
    safeFilename,
    validatePrompt,
    tryConsumeRateLimit,
    resetRateLimits
} = require('../lib/security');

test('escapeHtml экранирует опасные символы', () => {
    assert.equal(
        escapeHtml('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    assert.equal(escapeHtml("' & <>"), '&#39; &amp; &lt;&gt;');
});

test('sanitizeGameTitle убирает кавычки, теги и управляющие символы', () => {
    assert.equal(sanitizeGameTitle('<script>alert(1)</script>'), 'scriptalert(1)/script');
    assert.equal(sanitizeGameTitle('  Моя   игра  '), 'Моя игра');
    assert.equal(sanitizeGameTitle('', 'Fallback'), 'Fallback');
    assert.equal(sanitizeGameTitle('a'.repeat(100)).length, 60);
});

test('sanitizeBgFilename разрешает только безопасные имена', () => {
    assert.equal(sanitizeBgFilename('bg_123.jpg'), 'bg_123.jpg');
    assert.equal(sanitizeBgFilename('../secret.jpg'), null);
    assert.equal(sanitizeBgFilename('..\\secret.jpg'), null);
    assert.equal(sanitizeBgFilename('bg.svg'), null);
    assert.equal(sanitizeBgFilename('bg_123.jpg?x=1'), null);
    assert.equal(sanitizeBgFilename(null), null);
});

test('sanitizePlatform и safeFilename', () => {
    assert.equal(sanitizePlatform('mobile'), 'mobile');
    assert.equal(sanitizePlatform('hack'), 'pc');
    assert.equal(safeFilename('../../etc/passwd'), 'etcpasswd');
    assert.equal(safeFilename('Моя игра: 2'), 'Моя игра 2');
});

test('sanitizeEngine, sanitizeBiome и isSafeGameId пропускают только известные значения', () => {
    assert.equal(sanitizeEngine('arkanoid', ['arkanoid', 'tetris']), 'arkanoid');
    assert.equal(sanitizeEngine('../../etc', ['arkanoid']), null);
    assert.equal(sanitizeEngine(null, ['arkanoid']), null);
    assert.equal(sanitizeBiome('neon_tokyo', ['neon_tokyo', 'silent_stars']), 'neon_tokyo');
    assert.equal(sanitizeBiome('hack', ['silent_stars']), 'silent_stars');
    assert.equal(isSafeGameId('ai_1234567890123456'), true);
    assert.equal(isSafeGameId('tpl_1234567890123_42'), true);
    assert.equal(isSafeGameId('ai_123'), false);
    assert.equal(isSafeGameId('tpl_123'), false);
    assert.equal(isSafeGameId('../ai_1234567890123456'), false);
});

test('safeCssUrl разрешает только https и /uploads/', () => {
    assert.equal(safeCssUrl('/uploads/bg_1.jpg', 'fallback'), '/uploads/bg_1.jpg');
    assert.equal(safeCssUrl('https://example.com/a.jpg', 'fallback'), 'https://example.com/a.jpg');
    assert.equal(safeCssUrl('javascript:alert(1)', 'fallback'), 'fallback');
    assert.equal(safeCssUrl('/uploads/a.jpg\'); alert(1); //', 'fallback'), 'fallback');
});

test('validatePrompt отклоняет пустые, длинные и запрещённые запросы', () => {
    assert.equal(validatePrompt('').ok, false);
    assert.equal(validatePrompt('a'.repeat(601)).ok, false);
    assert.equal(validatePrompt('сделай игру про кота').ok, true);
    assert.equal(validatePrompt('child porn game').ok, false);
});

test('rate limit считает и сбрасывается', () => {
    resetRateLimits();
    assert.equal(tryConsumeRateLimit('u1', 2, 1000), true);
    assert.equal(tryConsumeRateLimit('u1', 2, 1000), true);
    assert.equal(tryConsumeRateLimit('u1', 2, 1000), false);
    resetRateLimits();
    assert.equal(tryConsumeRateLimit('u1', 2, 1000), true);
});
