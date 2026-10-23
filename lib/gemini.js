const axios = require('axios');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL_CHAIN = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-2.5-flash-lite'];
const MAX_ATTEMPTS = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS) || 3);
const DEFAULT_MIN_INTERVAL_MS = 4000;
const DEFAULT_RETRY_BASE_MS = 10000;

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

function getModelState(model) {
    if (!modelState.has(model)) modelState.set(model, { failures: 0, exhaustedUntil: 0 });
    return modelState.get(model);
}

function isModelExhausted(model) {
    return getModelState(model).exhaustedUntil > Date.now();
}

function activeModels() {
    return MODEL_CHAIN
        .filter((model) => !isModelExhausted(model))
        .sort((a, b) => getModelState(a).failures - getModelState(b).failures);
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

function isDailyQuotaError(error) {
    if (!error || error.status !== 429) return false;
    const text = `${error.message || ''} ${error.apiDetail || ''}`;
    return /per day|daily/i.test(text);
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
            }
            if (isDailyQuotaError(normalized)) {
                const wait = parseRetryDelaySeconds(normalized.apiDetail) || 24 * 3600;
                getModelState(model).exhaustedUntil = Date.now() + wait * 1000;
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

module.exports = {
    GeminiError,
    PRIMARY_MODEL,
    FALLBACK_MODEL,
    MODEL_CHAIN,
    generate,
    generateJson,
    listModels,
    parseJsonLoose,
    stripCodeMarkers,
    extractText,
    retryDelayFor,
    parseRetryDelaySeconds,
    getApiCallCount: () => apiCallCount,
    resetApiCallCount: () => { apiCallCount = 0; },
    getModelState: (model) => {
        const state = getModelState(model);
        return { failures: state.failures, exhausted: isModelExhausted(model), exhaustedUntil: state.exhaustedUntil };
    }
};
