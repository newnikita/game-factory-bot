const path = require('path');

function asString(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

function escapeHtml(value) {
    return asString(value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

function sanitizeText(value, maxLength = 200) {
    return asString(value)
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
        .trim();
}

function sanitizeGameTitle(value, fallback = 'Игра') {
    const cleaned = sanitizeText(value, 60)
        .replace(/[<>"'`\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
}

function safeFilename(value, fallback = 'game') {
    const cleaned = sanitizeText(value, 80)
        .replace(/[^\p{L}\p{N} _.-]/gu, '')
        .replace(/^[. ]+|[. ]+$/g, '')
        .trim();
    return cleaned || fallback;
}

function sanitizeBgFilename(value) {
    if (typeof value !== 'string' || !value) return null;
    const base = path.basename(value);
    if (base !== value) return null;
    if (!/^[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i.test(base)) return null;
    return base;
}

function sanitizePlatform(value) {
    return value === 'mobile' ? 'mobile' : 'pc';
}

function sanitizeEngine(value, allowed) {
    if (typeof value !== 'string') return null;
    return allowed.includes(value) ? value : null;
}

function sanitizeBiome(value, allowedKeys) {
    if (typeof value !== 'string') return 'silent_stars';
    return allowedKeys.includes(value) ? value : 'silent_stars';
}

function safeHttpsUrl(value, fallback = null) {
    try {
        const url = new URL(String(value));
        if (url.protocol !== 'https:') return fallback;
        return url.toString();
    } catch (e) {
        return fallback;
    }
}

function safeCssUrl(value, fallback) {
    const text = asString(value);
    if (!text || /["'()\\\s]/.test(text)) return fallback;
    if (!/^(?:https:\/\/|\/uploads\/)/i.test(text)) return fallback;
    return text;
}

function isSafeGameId(value) {
    return typeof value === 'string' && /^(ai|tpl)_[0-9]{10,20}(?:_[0-9]{1,6})?$/.test(value);
}

const BLOCKED_PROMPT_PATTERNS = [
    /(child|children|kid|minor|underage|teen|schoolgirl|loli|pedo|малолет|несовершеннолет|детск|школьниц|лоли).{0,40}(sex|porn|nude|naked|sexual|секс|порн|гол(ая|ые)|интим)/i,
    /(sex|porn|nude|naked|sexual|секс|порн|гол(ая|ые)|интим).{0,40}(child|children|kid|minor|underage|teen|schoolgirl|loli|pedo|малолет|несовершеннолет|детск|школьниц|лоли)/i,
    /(how to|как|инструкц|рецепт).{0,40}(make|сделать|изготов|сварган).{0,40}(bomb|бомб|explosive|взрывчат|meth|метамфетамин)/i,
    /(ddos|dos attack|ддос).{0,40}(script|скрипт|tool|инструмент)/i,
    /(steal|украсть|угнать).{0,30}(password|пароль|credit card|банковск|session|cookie)/i
];

function validatePrompt(value) {
    const raw = asString(value);
    if (raw.length > 600) {
        return { ok: false, error: 'Описание слишком длинное. Максимум 600 символов.' };
    }
    const text = sanitizeText(raw, 600);
    if (!text) {
        return { ok: false, error: 'Опиши игру одним-двумя предложениями.' };
    }
    if (text.length < 3) {
        return { ok: false, error: 'Слишком короткое описание. Добавь деталей.' };
    }
    if (BLOCKED_PROMPT_PATTERNS.some((re) => re.test(text))) {
        return { ok: false, error: 'Этот запрос нарушает правила сервиса. Переформулируй идею.' };
    }
    return { ok: true, value: text };
}

const rateBuckets = new Map();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) {
        if (bucket.resetAt <= now) rateBuckets.delete(key);
    }
}, 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

function tryConsumeRateLimit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        rateBuckets.set(key, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
}

function resetRateLimits() {
    rateBuckets.clear();
}

module.exports = {
    escapeHtml,
    sanitizeText,
    sanitizeGameTitle,
    safeFilename,
    sanitizeBgFilename,
    sanitizePlatform,
    sanitizeEngine,
    sanitizeBiome,
    safeHttpsUrl,
    safeCssUrl,
    isSafeGameId,
    validatePrompt,
    tryConsumeRateLimit,
    resetRateLimits
};
