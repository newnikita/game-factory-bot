const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL_CHAIN = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];
const MAX_ATTEMPTS = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS) || 3);
const DEFAULT_MIN_INTERVAL_MS = 4000;
const DEFAULT_RETRY_BASE_MS = 10000;
const DAILY_QUOTA_MIN_WAIT_SECONDS = 3600;
const UNAVAILABLE_MODEL_TTL_MS = 7 * 24 * 3600 * 1000;

function parseModelChain() {
    const fromChain = String(process.env.GEMINI_MODEL_CHAIN || '').trim();
    if (fromChain) {
        const models = fromChain.split(',').map((model) => model.trim()).filter(Boolean);
        if (models.length) return models;
    }
    const primary = String(process.env.GEMINI_MODEL || '').trim();
    const fallbacks = String(process.env.GEMINI_FALLBACK_MODEL || '')
        .split(',').map((model) => model.trim()).filter(Boolean);
    if (!primary && !fallbacks.length) return DEFAULT_MODEL_CHAIN.slice();
    return primary ? [primary, ...fallbacks] : fallbacks;
}

const MODEL_CHAIN = parseModelChain();
const PRIMARY_MODEL = MODEL_CHAIN[0];
const FALLBACK_MODEL = MODEL_CHAIN[1] || null;

function parseCriticChain() {
    const fromEnv = String(process.env.GEMINI_CRITIC_MODEL_CHAIN || '').trim();
    if (fromEnv) {
        const models = fromEnv.split(',').map((model) => model.trim()).filter(Boolean);
        if (models.length) return models;
    }
    const full = MODEL_CHAIN.filter((model) => !/lite/i.test(model));
    const lite = MODEL_CHAIN.filter((model) => /lite/i.test(model));
    return [...full, ...lite];
}

const CRITIC_MODEL_CHAIN = parseCriticChain();

class GeminiError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'GeminiError';
        this.status = options.status ?? null;
        this.retryable = Boolean(options.retryable);
        this.model = options.model || null;
        this.retryAfter = options.retryAfter ?? null;
        this.apiDetail = options.apiDetail || '';
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
let cooldownUntil = 0;
let rateLimitStreak = 0;
let requestQueue = Promise.resolve();
let apiCallCount = 0;
const modelState = new Map();
let stateFile = null;

function getModelState(model) {
    if (!modelState.has(model)) modelState.set(model, { failures: 0, exhaustedUntil: 0 });
    return modelState.get(model);
}

function isModelExhausted(model) {
    return getModelState(model).exhaustedUntil > Date.now();
}

// Дневная квота живёт в памяти процесса, но переживает деплой только в файле:
// без него рестарт на Render снова выглядит как «всё хорошо», хотя генерировать нельзя.
function initStateFile(file) {
    stateFile = file ? path.resolve(String(file)) : null;
    restoreQuotaState();
    return stateFile;
}

function restoreQuotaState() {
    if (!stateFile) return;
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const exhausted = (raw && raw.exhausted) || {};
        const now = Date.now();
        for (const [model, until] of Object.entries(exhausted)) {
            const value = Number(until);
            if (!Number.isFinite(value) || value <= now) continue;
            getModelState(model).exhaustedUntil = Math.max(getModelState(model).exhaustedUntil, value);
        }
    } catch (error) {
        // Файла состояния нет или он нечитаем — это нормальная ситуация при первом запуске.
    }
}

function persistQuotaState() {
    if (!stateFile) return;
    try {
        const now = Date.now();
        const exhausted = {};
        for (const model of MODEL_CHAIN) {
            const until = getModelState(model).exhaustedUntil;
            if (until > now) exhausted[model] = until;
        }
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ exhausted, savedAt: now }));
    } catch (error) {
        // Не смогли сохранить состояние: это не должно ломать генерацию.
    }
}

function resetQuotaState() {
    for (const model of Array.from(modelState.keys())) {
        modelState.set(model, { failures: 0, exhaustedUntil: 0 });
    }
}

function quotaState() {
    const now = Date.now();
    const exhausted = MODEL_CHAIN.filter((model) => getModelState(model).exhaustedUntil > now);
    const until = MODEL_CHAIN.reduce((max, model) => Math.max(max, getModelState(model).exhaustedUntil), 0);
    return {
        models: MODEL_CHAIN.length,
        exhausted: exhausted.length,
        blocked: MODEL_CHAIN.length > 0 && exhausted.length === MODEL_CHAIN.length,
        until: until > now ? new Date(until).toISOString() : null
    };
}

function activeModels() {
    return MODEL_CHAIN
        .filter((model) => !isModelExhausted(model))
        .sort((a, b) => getModelState(a).failures - getModelState(b).failures);
}

// Критик оценивает игру, которую часто писала та же модель: полные модели
// в цепочке идут раньше лайтовой, а модель-автор исключается, если есть альтернатива.
function pickCriticModels(available, excludeModel) {
    const alternatives = excludeModel ? available.filter((model) => model !== excludeModel) : [];
    return alternatives.length ? alternatives : available;
}

function criticModels(excludeModel) {
    const available = CRITIC_MODEL_CHAIN.filter((model) => !isModelExhausted(model));
    if (available.length) return pickCriticModels(available, excludeModel);
    const general = activeModels();
    return general.length ? pickCriticModels(general, excludeModel) : [];
}

// Судья не оценивает игру, которую писала та же модель: если других моделей нет,
// вердикта не будет вовсе — тогда игру оценивает детерминированный аудит.
function pickJudgeModels(available, excludeModel) {
    if (!excludeModel) return available.slice();
    return available.filter((model) => model !== excludeModel);
}

function judgeModels(excludeModel) {
    const available = CRITIC_MODEL_CHAIN.filter((model) => !isModelExhausted(model));
    const alternatives = pickJudgeModels(available, excludeModel);
    if (alternatives.length) return alternatives;
    return pickJudgeModels(activeModels(), excludeModel);
}

function minIntervalMs() {
    const raw = process.env.GEMINI_MIN_INTERVAL_MS;
    if (raw === undefined || raw === '') return DEFAULT_MIN_INTERVAL_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function retryBaseMs() {
    const raw = process.env.GEMINI_RETRY_BASE_MS;
    if (raw === undefined || raw === '') return DEFAULT_RETRY_BASE_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function scheduleRequest() {
    const run = requestQueue.then(async () => {
        const now = Date.now();
        const wait = Math.max(0, cooldownUntil - now, lastRequestAt + minIntervalMs() - now);
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
    });
    requestQueue = run.catch(() => {});
    return run;
}

function stripCodeMarkers(text) {
    const marker = String.fromCharCode(96, 96, 96);
    let out = String(text || '').replace(new RegExp(marker + 'html', 'gi'), '');
    out = out.replace(new RegExp(marker, 'g'), '');
    return out.trim();
}

function extractText(data) {
    const candidate = (data && data.candidates && data.candidates[0]) || {};
    const parts = (candidate.content && candidate.content.parts) || [];
    const text = parts.filter((part) => !part.thought).map((part) => part.text || '').join('');
    const finishReason = candidate.finishReason || '';
    const blocked = finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'BLOCKLIST';
    return { text, blocked, finishReason };
}

function isRetryableStatus(status) {
    if (!status) return true;
    if (status === 429) return true;
    return status >= 500;
}

function isAuthError(status) {
    return status === 401 || status === 403;
}

function errorText(error) {
    const response = error && error.response ? error.response.data : null;
    const fromResponse = response
        ? (typeof response === 'string' ? response : (response.error && response.error.message) || '')
        : '';
    return `${(error && error.message) || ''} ${(error && error.apiDetail) || ''} ${fromResponse}`;
}

function errorStatus(error) {
    if (!error) return null;
    if (error.status !== undefined && error.status !== null) return error.status;
    return (error.response && error.response.status) || null;
}

function isDailyQuotaError(error) {
    if (errorStatus(error) !== 429) return false;
    const text = errorText(error);
    if (/per\s*day|daily\s*limit|per_day/i.test(text)) return true;
    const wait = parseRetryDelaySeconds(text);
    return Boolean(wait && wait >= DAILY_QUOTA_MIN_WAIT_SECONDS);
}

function isModelUnavailableError(error) {
    if (errorStatus(error) !== 404) return false;
    return /no longer available|not found|not supported|deprecated/i.test(errorText(error));
}

function isQuotaExhaustedError(error) {
    if (!error) return false;
    if (error.status === 429 && error.retryable === false) return true;
    return /квота исчерпана|quota exceeded|quota exhausted/i.test(String(error.message || ''));
}

function parseRetryDelaySeconds(text) {
    const parts = String(text || '').match(/(\d+(?:\.\d+)?)\s*([hms])/gi);
    if (!parts || !parts.length) return null;
    let seconds = 0;
    for (const part of parts) {
        const match = part.match(/(\d+(?:\.\d+)?)\s*([hms])/i);
        if (!match) continue;
        const value = Number(match[1]);
        const unit = match[2].toLowerCase();
        seconds += unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value;
    }
    return seconds > 0 ? seconds : null;
}

function retryDelayFor(status, attempt, retryAfter) {
    if (status === 429) {
        const base = retryBaseMs() * Math.pow(2, attempt - 1);
        const fromHeader = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0;
        return Math.min(120000, Math.max(base, fromHeader));
    }
    return Math.min(20000, 3000 * attempt);
}

function describeApiError(error, limit = 2000) {
    const data = error && error.response ? error.response.data : null;
    if (!data) return '';
    const raw = typeof data === 'string' ? data : (data.error && data.error.message) || JSON.stringify(data);
    const key = String(process.env.GEMINI_API_KEY || '');
    const text = String(raw);
    return (key ? text.split(key).join('***') : text).slice(0, limit);
}

function buildUrl(model) {
    return `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

async function callModel(model, payload, options = {}) {
    const timeout = options.timeout || 300000;
    const maxAttempts = Math.max(1, options.maxAttempts || MAX_ATTEMPTS);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await scheduleRequest();
            apiCallCount += 1;
            const response = await axios.post(buildUrl(model), payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout
            });
            rateLimitStreak = 0;
            cooldownUntil = 0;
            getModelState(model).failures = 0;
            if (getModelState(model).exhaustedUntil) {
                getModelState(model).exhaustedUntil = 0;
                persistQuotaState();
            }
            const usage = (response.data && response.data.usageMetadata) || {};
            const { text, blocked, finishReason } = extractText(response.data);
            if (!text) {
                throw new GeminiError(
                    blocked ? `модель заблокировала ответ (${finishReason})` : 'пустой ответ модели',
                    { status: response.status, retryable: !blocked, model }
                );
            }
            if (finishReason === 'MAX_TOKENS') {
                console.warn(`[Gemini] Ответ модели ${model} обрезан по лимиту токенов`);
            }
            return {
                text,
                usage: {
                    inputTokens: Number(usage.promptTokenCount) || 0,
                    outputTokens: Number(usage.candidatesTokenCount) || 0
                },
                model,
                finishReason
            };
        } catch (error) {
            const status = (error.response && error.response.status) || null;
            const retryAfter = error.response && error.response.headers
                ? error.response.headers['retry-after']
                : null;
            const apiDetail = describeApiError(error);
            const detail = apiDetail.slice(0, 300);
            const normalized = error instanceof GeminiError
                ? error
                : new GeminiError(detail ? `${error.message}: ${detail}` : error.message, {
                    status,
                    retryable: isRetryableStatus(status),
                    model,
                    retryAfter,
                    apiDetail
                });
            lastError = normalized;
            if (normalized.status === 429) {
                rateLimitStreak += 1;
                cooldownUntil = Date.now() + Math.min(120000, retryBaseMs() * 1.5 * rateLimitStreak);
                console.error(`[Gemini] ${model}: 429 — ${String(normalized.apiDetail || normalized.message).slice(0, 600)}`);
            }
            if (isModelUnavailableError(normalized)) {
                getModelState(model).exhaustedUntil = Date.now() + UNAVAILABLE_MODEL_TTL_MS;
                persistQuotaState();
                console.error(`[Gemini] Модель ${model}: больше не обслуживается (${String(normalized.message).slice(0, 160)}) — отключаю`);
                break;
            }
            if (isDailyQuotaError(normalized)) {
                const wait = parseRetryDelaySeconds(normalized.apiDetail || normalized.message) || 24 * 3600;
                getModelState(model).exhaustedUntil = Date.now() + wait * 1000;
                persistQuotaState();
                normalized.retryable = false;
                console.error(`[Gemini] Модель ${model}: дневная квота исчерпана, ждать ${Math.round(wait / 60)} мин`);
                break;
            }
            if (!normalized.retryable || attempt === maxAttempts) break;
            const delay = retryDelayFor(normalized.status, attempt, normalized.retryAfter);
            if (typeof options.onRetry === 'function') {
                options.onRetry({ attempt, delay, error: normalized, model });
            }
            await sleep(delay);
        }
    }
    throw lastError;
}

async function generate(options = {}) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) throw new GeminiError('Ключ Gemini не настроен', { retryable: false });

    const models = [];
    const candidates = options.models && options.models.length ? options.models : activeModels();
    for (const model of candidates) {
        if (model && !models.includes(model)) models.push(model);
    }
    if (!models.length) {
        throw new GeminiError(
            `Дневная квота Gemini исчерпана для всех моделей (${MODEL_CHAIN.join(', ')})`,
            { retryable: false, status: 429 }
        );
    }

    const payload = {
        systemInstruction: options.systemInstruction,
        contents: options.contents,
        safetySettings: options.safetySettings,
        generationConfig: options.generationConfig
    };
    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) delete payload[key];
    }

    let lastError = null;
    for (let index = 0; index < models.length; index++) {
        const model = models[index];
        const nextModel = models[index + 1] || null;
        try {
            const result = await callModel(model, payload, options);
            return { ...result, fallbackUsed: index > 0 };
        } catch (error) {
            lastError = error;
            if (isAuthError(error.status)) throw error;
            getModelState(model).failures += 1;
            const suffix = nextModel ? ` — переключаюсь на ${nextModel}` : ' — резервной модели нет';
            console.error(`[Gemini] Модель ${model} не ответила (${error.message})${suffix}`);
        }
    }
    throw lastError;
}

function parseJsonLoose(text) {
    const raw = stripCodeMarkers(text).trim();
    if (!raw) return null;
    const candidates = [raw];
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const starts = [firstBrace, firstBracket].filter((index) => index >= 0);
    if (starts.length) {
        const start = Math.min(...starts);
        const openChar = raw[start];
        const closeChar = openChar === '{' ? '}' : ']';
        const end = raw.lastIndexOf(closeChar);
        if (end > start) candidates.push(raw.slice(start, end + 1));
    }
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch (error) { /* пробуем следующий вариант */ }
    }
    return null;
}

const JSON_ONLY_HINT = [
    'Ответь ТОЛЬКО валидным JSON без markdown, без ```- fences и без пояснений.',
    'Схема: объект с ключами, которые описаны в запросе.'
].join(' ');

async function generateJson(options = {}) {
    const userParts = (options.contents && options.contents[0] && options.contents[0].parts) || [];
    const textParts = userParts.filter((part) => part.text);
    const parts = [...userParts.filter((part) => !part.text), ...textParts.map((part) => ({ text: part.text + '\n\n' + JSON_ONLY_HINT }))];
    const result = await generate({
        ...options,
        contents: [{ role: 'user', parts }]
    });
    const data = parseJsonLoose(result.text);
    return { ...result, data, raw: result.text };
}

async function listModels() {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) return [];
    try {
        const response = await axios.get(`${API_BASE}?key=${apiKey}`, { timeout: 30000 });
        const models = (response.data && response.data.models) || [];
        return models
            .map((model) => String(model.name || '').replace(/^models\//, ''))
            .filter(Boolean)
            .sort();
    } catch (error) {
        return [];
    }
}

// Проверка доступа не тратит квоту генерации: список моделей — отдельный запрос.
async function probeAccess() {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) return { ok: false, reason: 'no_key', status: null, models: 0 };
    try {
        const response = await axios.get(`${API_BASE}?key=${apiKey}`, { timeout: 10000 });
        const models = (response.data && response.data.models) || [];
        return { ok: true, reason: 'ok', status: response.status || 200, models: models.length };
    } catch (error) {
        const status = (error.response && error.response.status) || null;
        const reason = status === 401 || status === 403 ? 'auth' : 'network';
        return { ok: false, reason, status, models: 0 };
    }
}

module.exports = {
    GeminiError,
    PRIMARY_MODEL,
    FALLBACK_MODEL,
    MODEL_CHAIN,
    CRITIC_MODEL_CHAIN,
    generate,
    generateJson,
    listModels,
    probeAccess,
    quotaState,
    initStateFile,
    persistQuotaState,
    resetQuotaState,
    parseJsonLoose,
    stripCodeMarkers,
    extractText,
    retryDelayFor,
    parseRetryDelaySeconds,
    isDailyQuotaError,
    isModelUnavailableError,
    isQuotaExhaustedError,
    criticModels,
    judgeModels,
    pickCriticModels,
    pickJudgeModels,
    getApiCallCount: () => apiCallCount,
    resetApiCallCount: () => { apiCallCount = 0; },
    getModelState: (model) => {
        const state = getModelState(model);
        return { failures: state.failures, exhausted: isModelExhausted(model), exhaustedUntil: state.exhaustedUntil };
    }
};
