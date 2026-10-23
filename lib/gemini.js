const axios = require('axios');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
const MAX_ATTEMPTS = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS) || 3);

class GeminiError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'GeminiError';
        this.status = options.status ?? null;
        this.retryable = Boolean(options.retryable);
        this.model = options.model || null;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripCodeMarkers(text) {
    const marker = String.fromCharCode(96, 96, 96);
    let out = String(text || '').replace(new RegExp(marker + 'html', 'gi'), '');
    out = out.replace(new RegExp(marker, 'g'), '');
    return out.trim();
}

function extractText(data) {
    const candidate = (data && data.candidates && data.candidates[0]) || {};
    const parts = (candidate.content && candidate.content.parts) || [];
    const text = parts.map((part) => part.text || '').join('');
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

function buildUrl(model) {
    return `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

async function callModel(model, payload, options = {}) {
    const timeout = options.timeout || 300000;
    const maxAttempts = Math.max(1, options.maxAttempts || MAX_ATTEMPTS);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axios.post(buildUrl(model), payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout
            });
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
            const normalized = error instanceof GeminiError
                ? error
                : new GeminiError(error.message, { status, retryable: isRetryableStatus(status), model });
            lastError = normalized;
            if (!normalized.retryable || attempt === maxAttempts) break;
            const delay = Math.min(20000, 3000 * attempt);
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
    for (const model of (options.models && options.models.length ? options.models : [PRIMARY_MODEL, FALLBACK_MODEL])) {
        if (model && !models.includes(model)) models.push(model);
    }
    if (!models.length) models.push(PRIMARY_MODEL);

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
    generate,
    generateJson,
    listModels,
    parseJsonLoose,
    stripCodeMarkers,
    extractText
};
