const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-moderation-'));
process.env.BOT_TOKEN = '0:test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.WEBAPP_URL = 'https://example.com';
process.env.GAMES_PUBLIC_URL = 'https://example.com';
process.env.DATA_DIR = dataDir;
process.env.DB_FILE = path.join(dataDir, 'test.db');
process.env.ADMIN_IDS = '999';

const db = require('../lib/db');
const { Telegram } = require('telegraf');
const { app, bot } = require('../bot');

const apiCalls = [];
const originalCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async (method, payload) => {
    apiCalls.push({ method, payload });
    return true;
};
bot.botInfo = {
    id: 777,
    is_bot: true,
    first_name: 'GameFactory',
    username: 'gamefactory_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false
};

let updateId = 100;

function callbackUpdate(userId, data, messageId) {
    updateId += 1;
    return {
        update_id: updateId,
        callback_query: {
            id: `cb_${updateId}`,
            from: { id: userId, is_bot: false, first_name: `User${userId}` },
            chat_instance: `ci_${userId}`,
            data,
            message: {
                message_id: messageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: userId, type: 'private', first_name: `User${userId}` },
                from: { id: 777, is_bot: true, first_name: 'GameFactory' },
                text: 'Сообщение'
            }
        }
    };
}

function textUpdate(userId, text, messageId) {
    updateId += 1;
    return {
        update_id: updateId,
        message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: userId, type: 'private', first_name: `User${userId}` },
            from: { id: userId, is_bot: false, first_name: `User${userId}` },
            text
        }
    };
}

test.before(() => {
    db.initDb({
        file: path.join(dataDir, 'test.db'),
        importLegacy: false,
        startBalance: 50,
        adminIds: [999]
    });
});

test.after(() => {
    Telegram.prototype.callApi = originalCallApi;
    db.closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('скрытая игра не отдаётся через HTTP и восстанавливается', async (t) => {
    const gameId = 'ai_1234567890123';
    db.ensureUser(1);
    db.recordGame({ id: gameId, telegramId: 1, title: 'Тестовая игра' });
    fs.writeFileSync(path.join(dataDir, 'ai_games', `${gameId}.html`), '<!DOCTYPE html><html><body>ok</body></html>');

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => server.close());

    assert.equal((await fetch(`${base}/sandbox/${gameId}`)).status, 200);
    const sandboxResponse = await fetch(`${base}/sandbox/${gameId}`);
    assert.match(await sandboxResponse.text(), /devicePixelRatio/);
    assert.equal((await fetch(`${base}/play/${gameId}`)).status, 200);

    db.createComplaint({ gameId, reporterId: 2, reason: 'sexual' });
    assert.equal(db.hideGame(gameId, 999), true);

    assert.equal((await fetch(`${base}/sandbox/${gameId}`)).status, 404);
    assert.equal((await fetch(`${base}/play/${gameId}`)).status, 404);
    assert.equal((await fetch(`${base}/ai_games/${gameId}.html`, { redirect: 'manual' })).status, 404);

    assert.equal(db.restoreGame(gameId), true);
    assert.equal((await fetch(`${base}/play/${gameId}`)).status, 200);
});

test('жалоба из бота уведомляет админа, скрывает и возвращает игру', async () => {
    const gameId = 'ai_2234567890123';
    db.ensureUser(42);
    db.recordGame({ id: gameId, telegramId: 42, title: 'Подозрительная игра' });
    apiCalls.length = 0;

    await bot.handleUpdate(callbackUpdate(42, `report_${gameId}`, 10));
    const reasonMenu = apiCalls.find((call) =>
        call.method === 'sendMessage' &&
        call.payload.chat_id === 42 &&
        String(call.payload.text).includes('Пожаловаться'));
    assert.ok(reasonMenu);
    assert.match(JSON.stringify(reasonMenu.payload.reply_markup), /rr_sexual/);

    await bot.handleUpdate(callbackUpdate(42, `rr_sexual_${gameId}`, 10));
    const created = db.listOpenComplaints().find((item) => item.game_id === gameId);
    assert.ok(created);
    const notification = apiCalls.find((call) =>
        call.method === 'sendMessage' &&
        call.payload.chat_id === 999 &&
        String(call.payload.text).includes(`Жалоба #${created.id}`));
    assert.ok(notification);

    await bot.handleUpdate(callbackUpdate(999, `mod_hide_${created.id}`, 20));
    assert.equal(db.getGame(gameId).status, 'hidden');
    assert.ok(apiCalls.some((call) =>
        call.method === 'sendMessage' &&
        call.payload.chat_id === 42 &&
        String(call.payload.text).includes('скрыта')));

    await bot.handleUpdate(callbackUpdate(999, `mod_restore_${created.id}_${gameId}`, 20));
    assert.equal(db.getGame(gameId).status, 'ready');
});

test('причина «Другое» сохраняет текст жалобы', async () => {
    const gameId = 'ai_3234567890123';
    db.ensureUser(43);
    db.recordGame({ id: gameId, telegramId: 43, title: 'Сломанная игра' });
    apiCalls.length = 0;

    await bot.handleUpdate(callbackUpdate(43, `report_${gameId}`, 30));
    await bot.handleUpdate(callbackUpdate(43, `rr_other_${gameId}`, 30));
    await bot.handleUpdate(textUpdate(43, 'Игра зависает после старта', 31));

    const complaint = db.listOpenComplaints().find((item) => item.game_id === gameId);
    assert.ok(complaint);
    assert.equal(complaint.reason, 'other');
    assert.equal(complaint.details, 'Игра зависает после старта');
    assert.ok(apiCalls.some((call) =>
        call.method === 'sendMessage' &&
        call.payload.chat_id === 999 &&
        String(call.payload.text).includes('Игра зависает после старта')));
});

test('архив AI-игры собирается и отправляется', async (t) => {
    const gameId = 'ai_4234567890123';
    db.ensureUser(44);
    db.recordGame({ id: gameId, telegramId: 44, title: 'Архивная игра' });
    fs.writeFileSync(
        path.join(dataDir, 'ai_games', `${gameId}.html`),
        '<!DOCTYPE html><html><head><style>body{background:url(\'/uploads/bg_ai_123.jpg\') center/cover}</style></head><body><canvas></canvas><script>console.log("game")</script></body></html>'
    );
    fs.writeFileSync(path.join(dataDir, 'uploads', 'bg_ai_123.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    const sent = [];
    const originalSendDocument = Telegram.prototype.sendDocument;
    Telegram.prototype.sendDocument = async function (chatId, document) {
        const buffer = Buffer.isBuffer(document.source)
            ? document.source
            : fs.readFileSync(document.source);
        sent.push({ chatId, filename: document.filename, buffer });
        return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' } };
    };
    t.after(() => { Telegram.prototype.sendDocument = originalSendDocument; });

    await bot.handleUpdate(callbackUpdate(44, `dl_ai_${gameId}`, 40));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 44);
    assert.equal(sent[0].filename, 'ai_game.zip');
    assert.equal(sent[0].buffer.subarray(0, 2).toString(), 'PK');
    assert.ok(sent[0].buffer.length > 200);
});
