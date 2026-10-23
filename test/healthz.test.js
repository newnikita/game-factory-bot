const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-healthz-'));
process.env.BOT_TOKEN = '0:test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MIN_INTERVAL_MS = '0';
process.env.GEMINI_RETRY_BASE_MS = '10';
process.env.WEBAPP_URL = 'https://example.com';
process.env.DATA_DIR = dataDir;
process.env.DB_FILE = path.join(dataDir, 'test.db');
process.env.ADMIN_IDS = '999';

const db = require('../lib/db');
const gemini = require('../lib/gemini');
const axios = require('axios');
const { app } = require('../bot');

db.initDb({ file: path.join(dataDir, 'test.db'), importLegacy: false, startBalance: 50, adminIds: [999] });

let server;
let base;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server.close();
    db.closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('healthz показывает состояние Gemini', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const health = await response.json();

    assert.equal(health.ok, true);
    assert.equal(health.config.gemini_key, true);
    assert.equal(health.gemini.key, true);
    assert.equal(health.gemini.key_valid, null, 'без проверки доступа статус ключа неизвестен');
    assert.equal(health.gemini.quota_blocked, false);
    assert.equal(health.gemini.models_total, gemini.MODEL_CHAIN.length);
    assert.equal(health.gemini.quota_errors_6h, 0);
    assert.equal(health.gemini.generation_available, true);
    assert.ok(Array.isArray(health.alerts));
});

test('healthz сообщает об исчерпанной квоте', async () => {
    const original = axios.post;
    axios.post = async () => {
        const error = new Error('Request failed with status code 429');
        error.response = {
            status: 429,
            data: {
                error: {
                    message: 'Generate content requests per day limit exceeded on Free Tier. Please retry in 19h25m58s.'
                }
            }
        };
        throw error;
    };
    try {
        await assert.rejects(() => gemini.generate({ contents: [] }));
    } finally {
        axios.post = original;
    }

    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.gemini.quota_blocked, true);
    assert.equal(health.gemini.generation_available, false);
    assert.ok(health.gemini.quota_until, 'время сброса квоты должно быть известно');
    assert.match(health.gemini.reason, /квота исчерпана/);
});
