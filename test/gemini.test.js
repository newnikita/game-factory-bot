const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_MIN_INTERVAL_MS = '0';
process.env.GEMINI_RETRY_BASE_MS = '10';

const gemini = require('../lib/gemini');
const axios = require('axios');

test('stripCodeMarkers убирает markdown-обёртку', () => {
    assert.equal(gemini.stripCodeMarkers('```html\n<!DOCTYPE html>\n```'), '<!DOCTYPE html>');
    assert.equal(gemini.stripCodeMarkers('  ```\nкод\n```  '), 'код');
});

test('parseJsonLoose читает чистый JSON', () => {
    assert.deepEqual(gemini.parseJsonLoose('{"a":1}'), { a: 1 });
    assert.deepEqual(gemini.parseJsonLoose('[1,2]'), [1, 2]);
});

test('parseJsonLoose вытаскивает JSON из текста вокруг', () => {
    const parsed = gemini.parseJsonLoose('Вот ответ: {"score": 80, "issues": []} — всё.');
    assert.deepEqual(parsed, { score: 80, issues: [] });
});

test('parseJsonLoose переживает мусорные ```-обёртки', () => {
    const parsed = gemini.parseJsonLoose('```json\n{"ok":true}\n```');
    assert.deepEqual(parsed, { ok: true });
});

test('parseJsonLoose возвращает null на мусоре', () => {
    assert.equal(gemini.parseJsonLoose('совсем не json'), null);
    assert.equal(gemini.parseJsonLoose(''), null);
});

test('extractText собирает части ответа и считает токены', () => {
    const data = {
        candidates: [{ content: { parts: [{ text: 'Привет ' }, { text: 'мир' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 }
    };
    const result = gemini.extractText(data);
    assert.equal(result.text, 'Привет мир');
    assert.equal(result.blocked, false);
    assert.equal(result.finishReason, 'STOP');
});

test('extractText помечает заблокированный ответ', () => {
    const result = gemini.extractText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });
    assert.equal(result.blocked, true);
    assert.equal(result.text, '');
});

test('extractText отбрасывает служебные части с размышлениями модели', () => {
    const result = gemini.extractText({
        candidates: [{
            content: {
                parts: [
                    { text: 'размышление: что нарисовать', thought: true },
                    { text: '<!DOCTYPE html>' }
                ]
            }
        }]
    });
    assert.equal(result.text, '<!DOCTYPE html>');
});

test('GeminiError хранит статус и флаг повторяемости', () => {
    const error = new gemini.GeminiError('лимит', { status: 429, retryable: true, model: 'gemini-2.5-flash' });
    assert.equal(error.name, 'GeminiError');
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    assert.equal(error.model, 'gemini-2.5-flash');
});

test('generate падает без ключа и не делает запрос', async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        await assert.rejects(() => gemini.generate({ contents: [] }), /Ключ Gemini не настроен/);
    } finally {
        if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    }
});

function withStubbedPost(handler, body) {
    const original = axios.post;
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    axios.post = handler;
    return async () => {
        axios.post = original;
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
        return body;
    };
}

function httpError(status) {
    const error = new Error(`Request failed with status code ${status}`);
    error.response = { status };
    return error;
}

test('generate переключается на резервную модель даже при 400', async () => {
    const calls = [];
    const restore = withStubbedPost(async (url) => {
        calls.push(url);
        if (calls.length === 1) throw httpError(400);
        return { status: 200, data: { candidates: [{ content: { parts: [{ text: 'ответ' }] } }] } };
    });
    try {
        const result = await gemini.generate({ contents: [], models: ['model-a', 'model-b'] });
        assert.equal(result.text, 'ответ');
        assert.equal(result.fallbackUsed, true);
        assert.equal(calls.length, 2);
    } finally {
        await restore();
    }
});

test('generate не переключается при ошибке авторизации', async () => {
    let calls = 0;
    const restore = withStubbedPost(async () => {
        calls += 1;
        throw httpError(401);
    });
    try {
        await assert.rejects(() => gemini.generate({ contents: [], models: ['model-a', 'model-b'] }));
        assert.equal(calls, 1);
    } finally {
        await restore();
    }
});

test('generate при 429 повторяет запрос и уходит на резервную модель', async () => {
    const calls = [];
    const restore = withStubbedPost(async (url) => {
        calls.push(url);
        if (calls.length === 1) throw httpError(429);
        return { status: 200, data: { candidates: [{ content: { parts: [{ text: 'ответ' }] } }] } };
    });
    try {
        const result = await gemini.generate({ contents: [], models: ['model-a', 'model-b'] });
        assert.equal(result.text, 'ответ');
        assert.equal(result.fallbackUsed, false);
        assert.equal(calls.length, 2);
    } finally {
        await restore();
    }
});

test('пауза перед повтором при 429 растёт экспоненциально', () => {
    assert.equal(gemini.retryDelayFor(429, 1), 10);
    assert.equal(gemini.retryDelayFor(429, 2), 20);
    assert.equal(gemini.retryDelayFor(429, 3), 40);
    assert.equal(gemini.retryDelayFor(429, 1, '60'), 60000);
    assert.equal(gemini.retryDelayFor(500, 1), 3000);
});

test('базовая пауза при 429 по умолчанию десять секунд', () => {
    const previous = process.env.GEMINI_RETRY_BASE_MS;
    delete process.env.GEMINI_RETRY_BASE_MS;
    try {
        assert.equal(gemini.retryDelayFor(429, 1), 10000);
        assert.equal(gemini.retryDelayFor(429, 2), 20000);
    } finally {
        if (previous !== undefined) process.env.GEMINI_RETRY_BASE_MS = previous;
    }
});

test('generate падает, когда не отвечает ни одна модель', async () => {
    let calls = 0;
    const restore = withStubbedPost(async () => {
        calls += 1;
        throw httpError(404);
    });
    try {
        await assert.rejects(() => gemini.generate({ contents: [], models: ['model-a', 'model-b'] }));
        assert.equal(calls, 2);
    } finally {
        await restore();
    }
});

test('listModels возвращает идентификаторы моделей', async () => {
    const original = axios.get;
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    axios.get = async () => ({ data: { models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-2.5-flash' }] } });
    try {
        const models = await gemini.listModels();
        assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-3.8-flash']);
    } finally {
        axios.get = original;
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test('listModels не падает без ключа', async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        assert.deepEqual(await gemini.listModels(), []);
    } finally {
        if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    }
});

test('модели по умолчанию живы и различаются', () => {
    assert.notEqual(gemini.PRIMARY_MODEL, gemini.FALLBACK_MODEL);
    assert.ok(gemini.PRIMARY_MODEL.startsWith('gemini-'));
    assert.ok(gemini.FALLBACK_MODEL.startsWith('gemini-'));
    assert.ok(gemini.MODEL_CHAIN.length >= 2);
});

test('модель с исчерпанной дневной квотой выключается из цепочки', async () => {
    const quotaError = new Error('Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, '
        + 'description: Generate content requests per day limit exceeded on Free Tier.');
    quotaError.response = { status: 429, data: { error: { message: quotaError.message } } };
    const calls = [];
    const restore = withStubbedPost(async (url) => {
        calls.push(url);
        if (calls.length === 1) throw quotaError;
        return { status: 200, data: { candidates: [{ content: { parts: [{ text: 'ответ' }] } }] } };
    });
    try {
        const result = await gemini.generate({ contents: [], models: ['model-a', 'model-b'] });
        assert.equal(result.text, 'ответ');
        assert.equal(result.fallbackUsed, true);
        assert.equal(calls.length, 2);
        assert.equal(gemini.getModelState('model-a').exhausted, true);
    } finally {
        await restore();
    }
});

test('счётчик запросов Gemini растёт', async () => {
    const before = gemini.getApiCallCount();
    const restore = withStubbedPost(async () => ({
        status: 200,
        data: { candidates: [{ content: { parts: [{ text: 'ответ' }] } }] }
    }));
    try {
        await gemini.generate({ contents: [], models: ['model-c'] });
        assert.equal(gemini.getApiCallCount(), before + 1);
    } finally {
        await restore();
    }
});

test('время ожидания квоты разбирается из ответа API', () => {
    assert.equal(Math.round(gemini.parseRetryDelaySeconds('Please retry in 19h25m58.679820436s.')), 69959);
    assert.equal(Math.round(gemini.parseRetryDelaySeconds('Please retry in 45s.')), 45);
    assert.equal(gemini.parseRetryDelaySeconds('без подсказки'), null);
});
