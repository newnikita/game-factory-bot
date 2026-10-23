const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

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

const CONFIG_FIELDS = {
    '[email]': 'supportEmail',
    '[@username]': 'supportUsername',
    '[ИНН]': 'companyInn',
    '[ИП/ООО, ФИО]': 'companyName',
    '[адрес]': 'companyAddress',
    '[реквизиты]': 'companyPaymentDetails',
    '[дата]': 'contractDate',
    '[номер]': 'contractNumber',
    '[срок]': 'refundPeriodDays'
};

function loadConfig(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file || CONFIG_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

function legalValues(env, config) {
    const source = env || process.env;
    const fallback = config || loadConfig();
    const values = {};
    for (const [token, key] of Object.entries(LEGAL_PLACEHOLDERS)) {
        const value = String(source[key] || '').trim();
        if (value) {
            values[token] = value;
            continue;
        }
        const field = CONFIG_FIELDS[token];
        const fromConfig = field ? String(fallback[field] || '').trim() : '';
        if (fromConfig) values[token] = fromConfig;
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

// Постоянный диск на Render монтируется отдельной файловой системой, поэтому
// у него другой device. Совпадение device с каталогом приложения означает,
// что данные живут во временной ФС и исчезнут при каждом деплое.
function isPersistentDataDir(dir, appDir) {
    try {
        const target = fs.statSync(dir);
        const app = fs.statSync(appDir || path.join(__dirname, '..'));
        return target.dev !== app.dev;
    } catch (error) {
        return false;
    }
}

function readinessReport(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const config = opts.config || loadConfig();
    const docs = opts.legalDocs || [];
    const values = opts.legalValues || legalValues(env, config);
    const secret = String(env.VISUAL_TOKEN_SECRET || '').trim();
    const adminApi = String(env.ADMIN_API_TOKEN || '').trim();
    const adminIds = Array.isArray(opts.adminIds)
        ? opts.adminIds.map(Number).filter(Boolean)
        : String(env.ADMIN_IDS || env.ADMIN_ID || '').split(',').map((id) => Number(id.trim())).filter(Boolean);

    return {
        bot_token: Boolean(String(env.BOT_TOKEN || '').trim()),
        gemini_key: Boolean(String(env.GEMINI_API_KEY || '').trim()),
        webapp_url: /^https:\/\//i.test(String(env.WEBAPP_URL || '')),
        games_public_url: /^https:\/\//i.test(String(env.GAMES_PUBLIC_URL || env.WEBAPP_URL || '')),
        data_dir: String(opts.dataDir || env.DATA_DIR || '(по умолчанию каталог проекта)'),
        data_persistent: Boolean(opts.dataPersistent),
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
    CONFIG_FIELDS,
    loadConfig,
    legalValues,
    renderLegal,
    missingPlaceholders,
    isPersistentDataDir,
    readinessReport
};
