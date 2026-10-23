const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-payflow-'));
process.env.BOT_TOKEN = '0:test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.WEBAPP_URL = 'https://example.com';
process.env.GAMES_PUBLIC_URL = 'https://example.com';
process.env.DATA_DIR = dataDir;
process.env.DB_FILE = path.join(dataDir, 'test.db');
process.env.ADMIN_IDS = '999';

const db = require('../lib/db');
const { Telegram } = require('telegraf');
const { bot } = require('../bot');
const { PLANS, gamesGranted, COST_PER_GAME } = require('../lib/plans');

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

let updateId = 500;

function paymentUpdate(userId, successfulPayment) {
    updateId += 1;
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: userId, type: 'private' },
            from: { id: userId, is_bot: false, first_name: `User${userId}` },
            successful_payment: successfulPayment
        }
    };
}

function commandUpdate(userId, text) {
    updateId += 1;
    const command = text.startsWith('/') ? text.split(/\s+/)[0] : '';
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: userId, type: 'private' },
            from: { id: userId, is_bot: false, first_name: `User${userId}` },
            text,
            entities: command ? [{ type: 'bot_command', offset: 0, length: command.length }] : undefined
        }
    };
}

function starsPayment(userId, chargeId, planId, overrides = {}) {
    const plan = PLANS[planId];
    const payload = {
        planId,
        userId,
        stars: plan.stars,
        games: plan.games,
        subscription: plan.periodDays > 0
    };
    return {
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: chargeId,
        invoice_payload: JSON.stringify({ ...payload, ...(overrides.payload || {}) }),
        currency: 'XTR',
        total_amount: overrides.total_amount !== undefined ? overrides.total_amount : plan.stars,
        subscription_expiration_date: overrides.subscription_expiration_date,
        is_recurring: Boolean(overrides.is_recurring),
        is_first_recurring: Boolean(overrides.is_first_recurring)
    };
}

function textsFor(chatId) {
    return apiCalls
        .filter((call) => call.method === 'sendMessage' && Number(call.payload.chat_id) === Number(chatId))
        .map((call) => String(call.payload.text || ''));
}

function findCall(method) {
    return apiCalls.find((call) => call.method === method);
}

function balanceOf(userId) {
    const user = db.getUser(userId);
    return user ? user.balance : 0;
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

test('оплата начисляет игры и подтверждает получение', async () => {
    apiCalls.length = 0;

    await bot.handleUpdate(paymentUpdate(1, starsPayment(1, 'charge-e2e-1', 'pack3')));

    const user = db.getUser(1);
    assert.equal(user.balance, 50 + gamesGranted(PLANS.pack3), 'стартовые игры плюс оплаченные');
    assert.equal(db.getPaymentByChargeId('charge-e2e-1').status, 'succeeded');
    assert.ok(textsFor(1).some((text) => text.includes('Оплата получена')), 'покупатель должен получить подтверждение');
    assert.ok(textsFor(999).some((text) => text.includes('pack3') || text.includes('Попробовать')));
    const adminNote = textsFor(999).find((text) => text.includes('Stars'));
    assert.ok(adminNote && adminNote.includes('баланс:'), 'в уведомлении админу должен быть баланс, чтобы восстановить деньги из переписки');
});

test('повторная доставка того же платежа не начисляет игры дважды', async () => {
    apiCalls.length = 0;
    const before = db.getUser(1).balance;

    await bot.handleUpdate(paymentUpdate(1, starsPayment(1, 'charge-e2e-1', 'pack3')));

    assert.equal(db.getUser(1).balance, before);
    assert.ok(textsFor(1).some((text) => text.includes('уже учтён')));
});

test('платёж с подменённой суммой не начисляет игры и зовёт админа', async () => {
    apiCalls.length = 0;

    await bot.handleUpdate(paymentUpdate(2, starsPayment(2, 'charge-e2e-bad', 'pack3', { total_amount: 1 })));

    assert.equal(balanceOf(2), 0, 'подменённая сумма не должна начислять игры');
    assert.ok(textsFor(2).some((text) => text.includes('не распознан')));
    assert.ok(textsFor(999).some((text) => text.includes('Платёж не распознан')));
});

test('покупатель без записи в базе всё равно получает игры', async () => {
    apiCalls.length = 0;
    assert.equal(db.getUser(77), null);

    await bot.handleUpdate(paymentUpdate(77, starsPayment(77, 'charge-e2e-new', 'pack3')));

    const user = db.getUser(77);
    assert.ok(user, 'покупатель должен появиться в базе');
    assert.equal(user.balance, 50 + gamesGranted(PLANS.pack3), 'стартовый баланс плюс оплаченные игры');
    assert.ok(textsFor(77).some((text) => text.includes('Оплата получена')));
});

test('возврат Stars списывает неиспользованные игры и уведомляет покупателя', async () => {
    apiCalls.length = 0;
    const before = db.getUser(1).balance;

    await bot.handleUpdate(commandUpdate(999, '/refund charge-e2e-1'));

    assert.ok(findCall('refundStarPayment'), 'возврат Stars должен уйти в Telegram');
    assert.equal(db.getUser(1).balance, before - gamesGranted(PLANS.pack3));
    assert.equal(db.getPaymentByChargeId('charge-e2e-1').status, 'refunded');
    assert.ok(textsFor(1).some((text) => text.includes('Возврат оплаты')));
});

test('возврат не проходит, если игры по платежу уже потрачены', async () => {
    apiCalls.length = 0;
    await bot.handleUpdate(paymentUpdate(3, starsPayment(3, 'charge-e2e-2', 'pack3')));
    db.debit(3, gamesGranted(PLANS.pack3), 'generation', 'gen-e2e');
    assert.equal(db.getUser(3).balance, 50);

    apiCalls.length = 0;
    await bot.handleUpdate(commandUpdate(999, '/refund charge-e2e-2'));

    assert.equal(findCall('refundStarPayment'), undefined, 'деньги не возвращаются при потраченных играх');
    assert.equal(db.getPaymentByChargeId('charge-e2e-2').status, 'succeeded');
    assert.ok(textsFor(999).some((text) => text.includes('уже потрачены')));
});

test('возврат игр без денег начисляет баланс и не трогает Stars', async () => {
    apiCalls.length = 0;
    const before = db.getUser(3).balance;

    await bot.handleUpdate(commandUpdate(999, '/refund charge-e2e-2 games'));

    assert.equal(findCall('refundStarPayment'), undefined, 'Stars не возвращаются в режиме games');
    assert.equal(db.getUser(3).balance, before + gamesGranted(PLANS.pack3));
    assert.equal(db.getPaymentByChargeId('charge-e2e-2').status, 'succeeded', 'платёж не помечается возвращённым');
    assert.ok(textsFor(3).some((text) => text.includes('Восстановили')));
});

test('подписка продлевается и начисляет игры', async () => {
    apiCalls.length = 0;
    const until = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

    await bot.handleUpdate(paymentUpdate(4, starsPayment(4, 'charge-e2e-sub', 'starter', {
        subscription_expiration_date: until
    })));

    const user = db.getUser(4);
    assert.equal(user.balance, 50 + gamesGranted(PLANS.starter));
    assert.equal(user.subscriptionPlan, 'starter');
    assert.equal(new Date(user.subscriptionUntil).getTime(), until * 1000);
    assert.ok(textsFor(4).some((text) => text.includes('Оплата получена')));
});

test('стоимость улучшения указана в кнопке', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    assert.match(source, /Улучшить · \$\{gamesLabel\(1\)\}/);
    assert.match(source, /Перегенерировать · \$\{gamesLabel\(1\)\}/);
    assert.equal(COST_PER_GAME, 25);
});
