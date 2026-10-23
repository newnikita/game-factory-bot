const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GEMINI_MIN_INTERVAL_MS = '0';
process.env.GEMINI_RETRY_BASE_MS = '10';
process.env.GEMINI_API_KEY = 'test-key';

const gemini = require('../lib/gemini');
const axios = require('axios');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-gemini-'));
const stateFile = path.join(tmpDir, 'gemini-state.json');

const DAILY_QUOTA_BODY = 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
    + 'limit: 20, description: Generate content requests per day limit exceeded on Free Tier. '
    + 'Please retry in 19h25m58.679820436s.';

function apiError(status, body) {
    const error = new Error(`Request failed with status code ${status}`);
    error.response = { status, data: { error: { code: status, message: body } } };
    return error;
}

test.after(() => {
    gemini.initStateFile(null);
    gemini.resetQuotaState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('до ошибки квота не исчерпана', () => {
    gemini.resetQuotaState();
    const state = gemini.quotaState();
    assert.equal(state.models, gemini.MODEL_CHAIN.length);
    assert.equal(state.exhausted, 0);
    assert.equal(state.blocked, false);
    assert.equal(state.until, null);
});

test('дневная квота по всем моделям блокирует генерацию', async () => {
    gemini.resetQuotaState();
    const original = axios.post;
    axios.post = async () => {
        throw apiError(429, DAILY_QUOTA_BODY);
    };
    try {
        await assert.rejects(() => gemini.generate({ contents: [] }));
    } finally {
        axios.post = original;
    }
    const state = gemini.quotaState();
    assert.equal(state.blocked, true);
    assert.equal(state.exhausted, gemini.MODEL_CHAIN.length);
    assert.ok(state.until, 'время сброса квоты должно быть известно');
});

test('состояние квоты переживает рестарт процесса', async () => {
    gemini.resetQuotaState();
    gemini.initStateFile(stateFile);
    const original = axios.post;
    axios.post = async () => {
        throw apiError(429, DAILY_QUOTA_BODY);
    };
    try {
        await assert.rejects(() => gemini.generate({ contents: [] }));
    } finally {
        axios.post = original;
    }

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(Object.keys(saved.exhausted).length > 0, 'состояние должно попасть в файл');

    gemini.resetQuotaState();
    assert.equal(gemini.quotaState().blocked, false, 'в памяти состояние сброшено');

    gemini.initStateFile(stateFile);
    assert.equal(gemini.quotaState().blocked, true, 'после рестарта квота снова видна как исчерпанная');
    fs.rmSync(stateFile, { force: true });
});

test('проверка доступа без ключа сообщает об отсутствии ключа', async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        const result = await gemini.probeAccess();
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'no_key');
    } finally {
        if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    }
});

test('проверка доступа при 403 считает ключ отклонённым', async () => {
    const original = axios.get;
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    axios.get = async () => {
        throw apiError(403, 'API key not valid');
    };
    try {
        const result = await gemini.probeAccess();
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'auth');
        assert.equal(result.status, 403);
    } finally {
        axios.get = original;
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
});

test('сетевая ошибка не выдаёт ключ за отклонённый', async () => {
    const original = axios.get;
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    axios.get = async () => {
        throw new Error('socket hang up');
    };
    try {
        const result = await gemini.probeAccess();
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'network');
    } finally {
        axios.get = original;
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
});

test('успешная проверка возвращает число доступных моделей', async () => {
    const original = axios.get;
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    axios.get = async () => ({
        status: 200,
        data: { models: [{ name: 'models/gemini-a' }, { name: 'models/gemini-b' }] }
    });
    try {
        const result = await gemini.probeAccess();
        assert.equal(result.ok, true);
        assert.equal(result.reason, 'ok');
        assert.equal(result.models, 2);
    } finally {
        axios.get = original;
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
});

test('проверка доступа не раскрывает ключ в ответе', async () => {
    const original = axios.get;
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'super-secret-key';
    axios.get = async () => {
        throw apiError(400, 'super-secret-key is invalid');
    };
    try {
        const result = await gemini.probeAccess();
        assert.ok(!JSON.stringify(result).includes('super-secret-key'));
    } finally {
        axios.get = original;
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
});
