const crypto = require('crypto');

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function isHttpsUrl(value) {
    return /^https:\/\/[^\s]+$/i.test(String(value || '').trim());
}

function resolveBotMode(env, isRender) {
    const mode = String(env.BOT_MODE || '').trim().toLowerCase();
    if (mode === 'webhook' || mode === 'polling') return mode;
    return isRender && isHttpsUrl(env.WEBAPP_URL) ? 'webhook' : 'polling';
}

function deriveWebhookSecret(botToken, explicit) {
    const value = String(explicit || '').trim();
    if (value) return value;
    return crypto.createHash('sha256')
        .update(`telegram-webhook:${String(botToken || '')}`)
        .digest('hex')
        .slice(0, 48);
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Telegram повторяет апдейт, если не получил 200 за ~60 секунд, а генерация
// идёт минутами. Поэтому отвечаем сразу, а обработку ставим в очередь.
function createWebhookHandler(options = {}) {
    const secret = String(options.secret || '');
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
    const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;
    return (req, res) => {
        if (!isActive()) {
            res.status(404).end();
            return;
        }
        const provided = typeof req.get === 'function'
            ? req.get(SECRET_HEADER)
            : (req.headers && req.headers[SECRET_HEADER]);
        if (!safeEqual(provided, secret)) {
            res.status(403).end();
            return;
        }
        const update = req.body;
        if (!update || typeof update !== 'object' || !Number.isFinite(Number(update.update_id))) {
            res.status(400).end();
            return;
        }
        res.status(200).end();
        Promise.resolve().then(() => onUpdate(update)).catch(() => {});
    };
}

// В polling Telegraf обрабатывает апдейты последовательно; в webhook сохраняем
// тот же порядок и не запускаем несколько тяжёлых генераций одновременно.
function createUpdateQueue(handler, options = {}) {
    const max = Number.isFinite(Number(options.max)) && Number(options.max) > 0 ? Number(options.max) : 100;
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    let chain = Promise.resolve();
    let size = 0;

    return {
        push(item) {
            if (size >= max) return false;
            size += 1;
            chain = chain
                .then(() => handler(item))
                .catch((error) => onError(error))
                .finally(() => { size -= 1; });
            return true;
        },
        async drain() {
            while (size > 0) await chain;
        },
        get size() {
            return size;
        }
    };
}

module.exports = {
    SECRET_HEADER,
    isHttpsUrl,
    resolveBotMode,
    deriveWebhookSecret,
    safeEqual,
    createWebhookHandler,
    createUpdateQueue
};
