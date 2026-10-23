const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { PLANS, getPlan, COST_PER_GAME, gamesGranted, gamesFromBalance, gamesLabel } = require('../lib/plans');

function freshDb() {
    db.closeDb();
    db.initDb({
        file: ':memory:',
        importLegacy: false,
        startBalance: 50,
        adminIds: [],
        rewardPerRef: 50,
        referralsPerMonth: 2
    });
}

function buy(telegramId, chargeId, planId, extra = {}) {
    const plan = getPlan(planId);
    return db.recordPayment({
        telegramId,
        provider: 'telegram_stars',
        chargeId,
        payload: JSON.stringify({ planId }),
        amount: plan.stars,
        currency: 'XTR',
        planId: plan.id,
        gamesGranted: gamesGranted(plan),
        raw: { telegram_payment_charge_id: chargeId },
        ...extra
    });
}

test.afterEach(() => db.closeDb());

test('оплата начисляет игры один раз, повторный charge_id не начисляет', () => {
    freshDb();
    db.ensureUser(1);
    const start = db.getUser(1).balance;

    const first = buy(1, 'charge-A', 'pack3');
    assert.equal(first.duplicate, false);
    assert.equal(first.credited, true);
    assert.equal(db.getUser(1).balance, start + gamesGranted(PLANS.pack3));

    const second = buy(1, 'charge-A', 'pack3');
    assert.equal(second.duplicate, true);
    assert.equal(db.getUser(1).balance, start + gamesGranted(PLANS.pack3), 'повторный платёж не должен начислить игры ещё раз');

    const payment = db.getPaymentByChargeId('charge-A');
    assert.equal(payment.plan_id, 'pack3');
    assert.equal(payment.amount, PLANS.pack3.stars);
    assert.equal(payment.status, 'succeeded');
});

test('подписка начисляет игры и ставит срок до отмены', () => {
    freshDb();
    db.ensureUser(1);
    const start = db.getUser(1).balance;
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    const result = buy(1, 'charge-S', 'starter', { subscriptionUntil: until, subscriptionDays: 0 });
    assert.equal(result.credited, true);

    const user = db.getUser(1);
    assert.equal(user.balance, start + gamesGranted(PLANS.starter));
    assert.equal(user.subscriptionPlan, 'starter');
    assert.equal(new Date(user.subscriptionUntil).getTime(), new Date(until).getTime());
});

test('продление подписки продлевает срок, а не сбрасывает его', () => {
    freshDb();
    db.ensureUser(1);
    const first = new Date(Date.now() + 30 * 24 *3600 * 1000).toISOString();
    const second = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();

    buy(1, 'charge-1', 'starter', { subscriptionUntil: first, subscriptionDays: 0 });
    buy(1, 'charge-2', 'starter', { subscriptionUntil: second, subscriptionDays: 0 });

    assert.equal(new Date(db.getUser(1).subscriptionUntil).getTime(), new Date(second).getTime());
});

test('автопродление начисляет игры заново каждый месяц', () => {
    freshDb();
    db.ensureUser(1);
    const start = db.getUser(1).balance;
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    buy(1, 'charge-1', 'creator', { subscriptionUntil: until, subscriptionDays: 0 });
    buy(1, 'charge-2', 'creator', { subscriptionUntil: until, subscriptionDays: 0 });

    assert.equal(db.getUser(1).balance, start + gamesGranted(PLANS.creator) * 2);
});

test('начисление несуществующему пользователю не проходит молча', () => {
    freshDb();
    const credited = db.credit(999, 25, 'purchase', 'charge-X');
    assert.equal(credited, false, 'несуществующий пользователь не должен получать начисление');
    assert.equal(db.getUser(999), null);

    const result = buy(999, 'charge-Y', 'pack3');
    assert.equal(result.credited, false, 'оплата без начисления должна быть видна вызывающему коду');
    assert.equal(result.duplicate, false);
});

test('возврат помечает платёж и не уводит баланс в минус', () => {
    freshDb();
    db.ensureUser(1);
    buy(1, 'charge-R', 'pack3');
    const afterBuy = db.getUser(1).balance;

    assert.equal(db.debit(1, gamesGranted(PLANS.pack3), 'refund_reversal', 'refund-reversal:charge-R'), true);
    assert.equal(db.getUser(1).balance, afterBuy - gamesGranted(PLANS.pack3));
    db.markPaymentRefunded('charge-R');
    assert.equal(db.getPaymentByChargeId('charge-R').status, 'refunded');
});

test('возврат при потраченных играх не уводит баланс в минус', () => {
    freshDb();
    db.ensureUser(1);
    buy(1, 'charge-S', 'pack3');
    const balance = db.getUser(1).balance;
    db.debit(1, balance, 'generation', 'gen-1');
    assert.equal(db.getUser(1).balance, 0);

    assert.equal(db.debit(1, gamesGranted(PLANS.pack3), 'refund_reversal', 'refund-reversal:charge-S'), false);
    assert.equal(db.getUser(1).balance, 0);
});

test('неудачный платёж помечается failed и доначисляется при повторной доставке', () => {
    freshDb();
    const failed = buy(999, 'charge-F', 'pack3');
    assert.equal(failed.credited, false);
    assert.equal(db.getPaymentByChargeId('charge-F').status, 'failed');

    db.ensureUser(999);
    const start = db.getUser(999).balance;
    const retry = buy(999, 'charge-F', 'pack3');
    assert.equal(retry.duplicate, false);
    assert.equal(retry.credited, true);
    assert.equal(db.getPaymentByChargeId('charge-F').status, 'succeeded');
    assert.equal(db.getUser(999).balance, start + gamesGranted(PLANS.pack3));

    const again = buy(999, 'charge-F', 'pack3');
    assert.equal(again.duplicate, true, 'после начисления повторная доставка не должна платить ещё раз');
    assert.equal(db.getUser(999).balance, start + gamesGranted(PLANS.pack3));
});

test('возврат игр без денег начисляет баланс только один раз', () => {
    freshDb();
    db.ensureUser(1);
    buy(1, 'charge-G', 'pack3');
    const afterBuy = db.getUser(1).balance;

    assert.equal(db.credit(1, gamesGranted(PLANS.pack3), 'refund_repair', 'refund-repair:charge-G'), true);
    assert.equal(db.getUser(1).balance, afterBuy + gamesGranted(PLANS.pack3));

    assert.equal(db.credit(1, gamesGranted(PLANS.pack3), 'refund_repair', 'refund-repair:charge-G'), false);
    assert.equal(db.getUser(1).balance, afterBuy + gamesGranted(PLANS.pack3));
});

test('откат списания при сбое возврата возвращает игры на баланс', () => {
    freshDb();
    db.ensureUser(1);
    buy(1, 'charge-H', 'pack3');
    const afterBuy = db.getUser(1).balance;

    assert.equal(db.debit(1, gamesGranted(PLANS.pack3), 'refund_reversal', 'refund-reversal:charge-H'), true);
    assert.equal(db.getUser(1).balance, afterBuy - gamesGranted(PLANS.pack3));

    assert.equal(db.credit(1, gamesGranted(PLANS.pack3), 'refund_reversal_rollback', 'refund-rollback:charge-H'), true);
    assert.equal(db.getUser(1).balance, afterBuy);
});

test('тарифы согласованы со счётчиком игр', () => {
    for (const plan of Object.values(PLANS)) {
        assert.equal(plan.stars > 0, true, `${plan.id}: нужна цена в Stars`);
        assert.equal(gamesGranted(plan), plan.games * COST_PER_GAME);
        assert.equal(gamesFromBalance(gamesGranted(plan)), plan.games);
    }
    assert.equal(gamesLabel(1), '1 игра');
    assert.equal(gamesLabel(2), '2 игры');
    assert.equal(gamesLabel(5), '5 игр');
    assert.equal(gamesLabel(11), '11 игр');
});
