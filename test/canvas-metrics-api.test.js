process.env.ADMIN_IDS = '';
process.env.VISUAL_TOKEN_SECRET = 'test-visual-secret';
process.env.ADMIN_API_TOKEN = 'test-admin-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-canvas-'));
process.env.DATA_DIR = dataDir;

const db = require('../lib/db');
const bot = require('../bot');

const GAME_ID = 'ai_12345678901';

function visualToken(gameId) {
    return crypto.createHmac('sha256', 'test-visual-secret').update(String(gameId)).digest('hex').slice(0, 32);
}

function startServer() {
    return new Promise((resolve) => {
        const server = bot.app.listen(0, () => resolve(server));
    });
}

async function post(base, body) {
    return fetch(`${base}/api/canvas-metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

const RICH_METRICS = { coverage: 0.6, colors: 40, shades: 10, contrast: 0.25, animated: true, samples: 4 };
const BLANK_METRICS = { coverage: 0, colors: 0, shades: 0, contrast: 0, animated: false, samples: 4 };

test.before(() => {
    db.initDb({
        file: ':memory:',
        importLegacy: false,
        startBalance: 50,
        adminIds: [],
        rewardPerRef: 50,
        referralsPerMonth: 2
    });
});

test.after(() => db.closeDb());

test('сервер принимает замер только с верным токеном игры', async () => {
    db.ensureUser(1);
    db.recordGame({ id: GAME_ID, telegramId: 1, title: 'Игра' });
    db.setGameVisualStatic(GAME_ID, 80);

    const server = await startServer();
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const wrong = await post(base, { gameId: GAME_ID, token: 'wrong-token', metrics: RICH_METRICS });
        assert.equal(wrong.status, 403);

        const foreign = await post(base, { gameId: GAME_ID, token: visualToken('ai_99999999999'), metrics: RICH_METRICS });
        assert.equal(foreign.status, 403);

        const broken = await post(base, { gameId: GAME_ID, token: visualToken(GAME_ID), metrics: { coverage: 9 } });
        assert.equal(broken.status, 400);

        const good = await post(base, { gameId: GAME_ID, token: visualToken(GAME_ID), metrics: RICH_METRICS });
        assert.equal(good.status, 200);

        const game = db.getGame(GAME_ID);
        assert.equal(game.visual_static, 80);
        assert.equal(game.visual_measured, 100);
        assert.ok(game.visual_measured_at, 'время замера должно сохраняться');
    } finally {
        server.close();
    }
});

test('два пустых экрана подряд скрывают игру', async () => {
    const gameId = 'ai_12345678902';
    db.recordGame({ id: gameId, telegramId: 1, title: 'Пустая' });

    const server = await startServer();
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const first = await post(base, { gameId, token: visualToken(gameId), metrics: BLANK_METRICS });
        assert.equal(first.status, 200);
        assert.equal(db.getGame(gameId).status, 'ready', 'после первого замера игра остаётся доступной');

        const second = await post(base, { gameId, token: visualToken(gameId), metrics: BLANK_METRICS });
        assert.equal(second.status, 200);
        assert.equal(db.getGame(gameId).status, 'hidden', 'после второго пустого замера игра скрывается');
    } finally {
        server.close();
    }
});

test('статистика пайплайна доступна только по токену', async () => {
    const server = await startServer();
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const denied = await fetch(`${base}/admin/stats`);
        assert.equal(denied.status, 403);

        const wrong = await fetch(`${base}/admin/stats`, { headers: { 'x-admin-token': 'wrong' } });
        assert.equal(wrong.status, 403);

        const allowed = await fetch(`${base}/admin/stats`, { headers: { 'x-admin-token': 'test-admin-token' } });
        assert.equal(allowed.status, 200);
        const body = await allowed.json();
        assert.equal(body.ok, true);
        assert.ok(body.monitor);
        assert.ok(Array.isArray(body.alerts));
        assert.ok(body.visualCalibration);
    } finally {
        server.close();
    }
});

test('страница игры получает пробу, а страница запуска — пересылку', async () => {
    const gameId = 'ai_12345678903';
    const gamesDir = path.join(dataDir, 'ai_games');
    fs.mkdirSync(gamesDir, { recursive: true });
    fs.writeFileSync(path.join(gamesDir, `${gameId}.html`), '<!DOCTYPE html><html><body><canvas id="game"></canvas></body></html>');

    const server = await startServer();
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const game = await fetch(`${base}/sandbox/${gameId}`);
        assert.equal(game.status, 200);
        const gameHtml = await game.text();
        assert.match(gameHtml, /gf-canvas-metrics/, 'в игру должна попасть проба замера');
        assert.match(gameHtml, /postMessage/);
        assert.ok(gameHtml.includes(visualToken(gameId)), 'проба должна нести токен игры');

        const play = await fetch(`${base}/play/${gameId}`);
        assert.equal(play.status, 200);
        const playHtml = await play.text();
        assert.match(playHtml, /id="gf-game-frame"/, 'iframe должен иметь id для пересылки');
        assert.match(playHtml, /\/api\/canvas-metrics/);
        assert.ok(playHtml.includes(visualToken(gameId)));
    } finally {
        server.close();
    }
});
