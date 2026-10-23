const LEGAL_PLACEHOLDERS = {
    '[email]': 'SUPPORT_EMAIL',
    '[@username]': 'SUPPORT_USERNAME',
    '[ИНН]': 'COMPANY_INN',
    '[ИП/ООО, ФИО]': 'COMPANY_NAME',
    '[адрес]': 'COMPANY_ADDRESS',
    '[реквизиты]': 'COMPANY_PAYMENT_DETAILS',
    '[дата]': 'CONTRACT_DATE',
    '[номер]': 'CONTRACT_NUMBER',
    '[URL]': 'WEBAPP_URL',
    '[срок]': 'REFUND_PERIOD_DAYS'
};

function legalValues(env) {
    const source = env || process.env;
    const values = {};
    for (const [token, key] of Object.entries(LEGAL_PLACEHOLDERS)) {
        const value = String(source[key] || '').trim();
        if (value) values[token] = value;
    }
    return values;
}

function renderLegal(text, values) {
    const map = values || legalValues();
    return String(text || '').replace(/\[[^\]\n]{1,40}\]/g, (token) => (
        Object.prototype.hasOwnProperty.call(map, token) ? map[token] : token
    ));
}

function missingPlaceholders(docs, values) {
    const map = values || legalValues();
    const missing = new Set();
    for (const doc of docs || []) {
        const text = String((doc && doc.text) || '');
        for (const token of text.match(/\[[^\]\n]{1,40}\]/g) || []) {
            if (!Object.prototype.hasOwnProperty.call(LEGAL_PLACEHOLDERS, token)) continue;
            if (!Object.prototype.hasOwnProperty.call(map, token)) missing.add(token);
        }
    }
    return Array.from(missing);
}

function readinessReport(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const docs = opts.legalDocs || [];
    const values = opts.legalValues || legalValues(env);
    const secret = String(env.VISUAL_TOKEN_SECRET || '').trim();
    const adminApi = String(env.ADMIN_API_TOKEN || '').trim();
    const adminIds = String(env.ADMIN_IDS || '').split(',').map((id) => Number(id.trim())).filter(Boolean);

    return {
        bot_token: Boolean(String(env.BOT_TOKEN || '').trim()),
        gemini_key: Boolean(String(env.GEMINI_API_KEY || '').trim()),
        webapp_url: /^https:\/\//i.test(String(env.WEBAPP_URL || '')),
        games_public_url: /^https:\/\//i.test(String(env.GAMES_PUBLIC_URL || '')),
        admin_ids: adminIds.length > 0,
        admin_api_token: Boolean(adminApi),
        visual_secret: secret ? 'own' : (adminApi ? 'admin_api' : 'bot_token'),
        moderation: Boolean(String(env.SIGHT_USER || '').trim() && String(env.SIGHT_SECRET || '').trim()),
        unsplash: Boolean(String(env.UNSPLASH_ACCESS_KEY || '').trim()),
        legal_files: docs.length,
        legal_missing: missingPlaceholders(docs, values)
    };
}

module.exports = {
    LEGAL_PLACEHOLDERS,
    legalValues,
    renderLegal,
    missingPlaceholders,
    readinessReport
};
