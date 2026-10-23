const test = require('node:test');
const assert = require('node:assert/strict');
const { planRefund, normalizeMode } = require('../lib/refunds');
const { COST_PER_GAME } = require('../lib/plans');

test('возврат Stars отклоняется, если игры по платежу уже потрачены', () => {
    const decision = planRefund({ balance: 0, gamesGranted: 3 * COST_PER_GAME, mode: 'money' });
    assert.equal(decision.action, 'refuse');
    assert.equal(decision.reason, 'games_spent');
});

test('возврат Stars проходит, когда баланс покрывает начисленные игры', () => {
    const decision = planRefund({ balance: 3 * COST_PER_GAME, gamesGranted: 3 * COST_PER_GAME, mode: 'money' });
    assert.equal(decision.action, 'refund');
    assert.equal(decision.remove, 3 * COST_PER_GAME);
    assert.equal(decision.forced, false);
});

test('режим force возвращает деньги даже при потраченных играх', () => {
    const decision = planRefund({ balance: COST_PER_GAME, gamesGranted: 3 * COST_PER_GAME, mode: 'force' });
    assert.equal(decision.action, 'refund');
    assert.equal(decision.remove, COST_PER_GAME, 'списывается только то, что есть на балансе');
    assert.equal(decision.forced, true);
});

test('режим games возвращает игры без денег', () => {
    const decision = planRefund({ balance: 0, gamesGranted: 3 * COST_PER_GAME, mode: 'games' });
    assert.equal(decision.action, 'repair');
    assert.equal(decision.games, 3);
});

test('неизвестный режим трактуется как обычный возврат денег', () => {
    assert.equal(normalizeMode(''), 'money');
    assert.equal(normalizeMode('что-то'), 'money');
    assert.equal(normalizeMode('FORCE'), 'force');
    assert.equal(normalizeMode('Games'), 'games');
});
