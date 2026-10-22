const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../lib/db');

function freshDb(extra = {}) {
    db.closeDb();
    db.initDb({
        file: ':memory:',
        importLegacy: false,
        startBalance: 50,
        adminIds: [],
        rewardPerRef: 50,
        referralsPerMonth: 2,
        ...extra
    });
}

test.afterEach(() => db.closeDb());

test('ensureUser создаёт пользователя один раз и начисляет стартовый баланс', () => {
    freshDb();
    const first = db.ensureUser(1, { username: 'tester' });
    const second = db.ensureUser(1, { username: 'tester2' });
    assert.equal(first.balance, 50);
    assert.equal(second.balance, 50);
    assert.equal(second.username, 'tester2');
    assert.equal(db.getStats().users, 1);
});

test('credit идемпотентен по ref, debit не уводит баланс в минус', () => {
    freshDb();
    db.ensureUser(1);
    assert.equal(db.credit(1, 25, 'purchase', 'charge-1'), true);
    assert.equal(db.credit(1, 25, 'purchase', 'charge-1'), false);
    assert.equal(db.getUser(1).balance, 75);

    assert.equal(db.debit(1, 50, 'generation', 'gen-1'), true);
    assert.equal(db.debit(1, 50, 'generation', 'gen-2'), false);
    assert.equal(db.getUser(1).balance, 25);

    assert.equal(db.debit(1, 25, 'generation', 'gen-1'), false);
    assert.equal(db.getUser(1).balance, 25);
});

test('реферал награждается только после квалификации и один раз', () => {
    freshDb();
    db.ensureUser(100);
    db.ensureUser(200);
    assert.equal(db.attachReferral(200, 100), true);
    assert.equal(db.attachReferral(200, 100), false);
    assert.equal(db.getUser(100).balance, 50);

    const result = db.qualifyReferral(200);
    assert.equal(result.rewarded, true);
    assert.equal(result.referrerId, 100);
    assert.equal(db.getUser(100).balance, 100);
    assert.equal(db.getUser(100).referrals, 1);

    const again = db.qualifyReferral(200);
    assert.equal(again.rewarded, false);
    assert.equal(db.getUser(100).balance, 100);
});

test('лимит реферальных наград за 30 дней работает', () => {
    freshDb();
    db.ensureUser(100);
    for (let i = 1; i <= 3; i += 1) {
        db.ensureUser(200 + i);
        db.attachReferral(200 + i, 100);
        const result = db.qualifyReferral(200 + i);
        assert.equal(result.rewarded, i <= 2, `referral ${i}`);
    }
    assert.equal(db.getUser(100).referrals, 2);
    assert.equal(db.getUser(100).balance, 150);
});

test('платёж начисляет игры один раз при повторном вебхуке', () => {
    freshDb();
    db.ensureUser(1);
    const payment = {
        telegramId: 1,
        provider: 'telegram_stars',
        chargeId: 'charge-123',
        amount: 120,
        currency: 'XTR',
        planId: 'pack3',
        gamesGranted: 75,
        subscriptionDays: 0
    };
    const first = db.recordPayment(payment);
    const second = db.recordPayment(payment);
    assert.equal(first.credited, true);
    assert.equal(second.duplicate, true);
    assert.equal(db.getUser(1).balance, 125);
    assert.equal(db.getStats().payments, 1);
});

test('подписка продлевается от текущей даты окончания', () => {
    freshDb();
    db.ensureUser(1);
    const base = {
        telegramId: 1,
        provider: 'telegram_stars',
        amount: 450,
        currency: 'XTR',
        planId: 'starter',
        gamesGranted: 375,
        subscriptionDays: 30
    };
    db.recordPayment({ ...base, chargeId: 'charge-a' });
    const firstUntil = new Date(db.getUser(1).subscriptionUntil).getTime();
    db.recordPayment({ ...base, chargeId: 'charge-b' });
    const secondUntil = new Date(db.getUser(1).subscriptionUntil).getTime();
    assert.ok(secondUntil > firstUntil);
    assert.equal(db.getUser(1).subscriptionPlan, 'starter');
});

test('recordPayment берёт дату окончания подписки из Telegram', () => {
    freshDb();
    db.ensureUser(1);
    const until = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
    db.recordPayment({
        telegramId: 1,
        provider: 'telegram_stars',
        chargeId: 'charge-exact',
        amount: 450,
        currency: 'XTR',
        planId: 'starter',
        gamesGranted: 375,
        subscriptionUntil: until
    });
    assert.equal(db.getUser(1).subscriptionUntil, until);
    assert.equal(db.getUser(1).subscriptionPlan, 'starter');
});

test('recordGame сохраняет параметры сборки шаблона', () => {
    freshDb();
    db.ensureUser(1);
    db.recordGame({
        id: 'tpl_1234567890123_42',
        telegramId: 1,
        title: 'Тест',
        source: 'template',
        build: { engine: 'arkanoid', biome: 'neon_tokyo', platform: 'mobile' }
    });

    const game = db.getGame('tpl_1234567890123_42');
    assert.equal(JSON.parse(game.build_json).engine, 'arkanoid');
    assert.equal(game.telegram_id, 1);
});

test('жалоба создаётся один раз и скрывает игру', () => {
    freshDb();
    db.ensureUser(1);
    db.ensureUser(2);
    const gameId = 'ai_1234567890123';
    db.recordGame({ id: gameId, telegramId: 1, title: 'Тестовая игра' });

    const first = db.createComplaint({ gameId, reporterId: 2, reason: 'sexual', details: 'Проверка' });
    assert.equal(first.created, true);
    assert.equal(first.complaint.status, 'open');
    assert.equal(first.complaint.game_title, 'Тестовая игра');
    assert.equal(first.complaint.owner_id, 1);

    const duplicate = db.createComplaint({ gameId, reporterId: 2, reason: 'violence' });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.reason, 'duplicate');

    assert.equal(db.getStats().openComplaints, 1);
    assert.equal(db.listOpenComplaints().length, 1);

    assert.equal(db.hideGame(gameId, 999), true);
    assert.equal(db.getGame(gameId).status, 'hidden');
    assert.equal(db.getStats().openComplaints, 0);
    const resolved = db.getComplaint(first.complaint.id);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.action, 'hide_game');
    assert.equal(resolved.resolved_by, 999);

    assert.equal(db.hideGame(gameId, 999), false);
    assert.equal(db.restoreGame(gameId), true);
    assert.equal(db.getGame(gameId).status, 'ready');
    assert.equal(db.restoreGame(gameId), false);
});

test('жалоба отклоняется и не создаётся для несуществующей игры', () => {
    freshDb();
    const gameId = 'ai_1234567890124';
    db.recordGame({ id: gameId, telegramId: 1, title: 'Игра' });

    const missing = db.createComplaint({ gameId: 'ai_1234567890125', reporterId: 2, reason: 'other' });
    assert.equal(missing.created, false);
    assert.equal(missing.reason, 'game_not_found');

    const created = db.createComplaint({ gameId, reporterId: 2, reason: 'broken' });
    assert.equal(db.dismissComplaint(created.complaint.id, 777), true);
    assert.equal(db.dismissComplaint(created.complaint.id, 777), false);
    const dismissed = db.getComplaint(created.complaint.id);
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.action, 'dismiss');
    assert.equal(dismissed.resolved_by, 777);
    assert.equal(db.getStats().openComplaints, 0);

    const again = db.createComplaint({ gameId, reporterId: 2, reason: 'other' });
    assert.equal(again.created, true);
});

test('backupDb создаёт согласованную копию базы', () => {
    db.closeDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-backup-'));
    db.initDb({ file: path.join(dir, 'source.db'), importLegacy: false, startBalance: 50, adminIds: [] });
    db.ensureUser(7);
    const target = path.join(dir, 'backup.db');
    db.backupDb(target);
    assert.ok(fs.existsSync(target));
    assert.ok(fs.statSync(target).size > 0);
    db.closeDb();

    db.initDb({ file: target, importLegacy: false });
    assert.equal(db.getUser(7).balance, 50);
    db.closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('импорт users.json сохраняет балансы и не платит старые рефералы', () => {
    db.closeDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-db-'));
    const legacyFile = path.join(dir, 'users.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
        10: { balance: 300, referrals: 2, referredBy: 5 },
        5: { balance: 100, referrals: 0, referredBy: null }
    }));

    db.initDb({
        file: path.join(dir, 'test.db'),
        importLegacy: true,
        legacyUsersFile: legacyFile,
        startBalance: 50,
        adminIds: [],
        rewardPerRef: 50,
        referralsPerMonth: 2
    });

    assert.equal(db.getUser(10).balance, 300);
    assert.equal(db.getUser(5).balance, 100);
    assert.equal(db.getUser(10).referralQualified, true);
    assert.equal(db.qualifyReferral(10).rewarded, false);

    db.closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
});
