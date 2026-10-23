const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');

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
    db.ensureUser(1);
    db.ensureUser(2);
}

function seedGame(gameId, genre, title = 'Игра') {
    db.recordGeneration({ id: 'gen_' + gameId, telegramId: 1, prompt: 'Промпт: ' + genre, genre, status: 'completed' });
    db.recordGame({ id: gameId, telegramId: 1, generationId: 'gen_' + gameId, title, htmlPath: gameId + '.html', source: 'ai' });
}

test.afterEach(() => db.closeDb());

test('оценка сохраняется и средний считается по игре', () => {
    freshDb();
    seedGame('ai_1', 'platformer');
    const first = db.rateGame('ai_1', 1, 5);
    assert.equal(first.count, 1);
    assert.equal(first.avg, 5);
    assert.equal(first.myRating, 5);
});

test('повторная оценка того же пользователя перезаписывает старую', () => {
    freshDb();
    seedGame('ai_1', 'platformer');
    db.rateGame('ai_1', 1, 5);
    const updated = db.rateGame('ai_1', 1, 3);
    assert.equal(updated.count, 1);
    assert.equal(updated.avg, 3);
    assert.equal(updated.myRating, 3);
});

test('оценка принимает значения от 1 до 5 и отбрасывает мусор', () => {
    freshDb();
    seedGame('ai_1', 'platformer');
    assert.throws(() => db.rateGame('ai_1', 1, 0), /от 1 до 5/);
    assert.throws(() => db.rateGame('ai_1', 1, 6), /от 1 до 5/);
    assert.throws(() => db.rateGame('ai_1', 1, 'abc'), /от 1 до 5/);
    assert.throws(() => db.rateGame('ai_1', 0, 3), /Telegram ID/);
    assert.throws(() => db.rateGame('', 1, 3), /Не указана игра/);
});

test('getGameRating отдаёт мою оценку и общий средний', () => {
    freshDb();
    seedGame('ai_1', 'platformer');
    db.rateGame('ai_1', 1, 4);
    db.rateGame('ai_1', 2, 2);
    const rating = db.getGameRating('ai_1', 1);
    assert.equal(rating.count, 2);
    assert.equal(rating.avg, 3);
    assert.equal(rating.myRating, 4);
    assert.equal(db.getGameRating('ai_1', 2).myRating, 2);
});

test('getRatingStats пуст без голосов', () => {
    freshDb();
    const stats = db.getRatingStats(30);
    assert.equal(stats.votes, 0);
    assert.equal(stats.avg, 0);
    assert.deepEqual(stats.byGenre, []);
});

test('getRatingStats связывает оценки с жанром и промптом', () => {
    freshDb();
    seedGame('ai_1', 'platformer', 'Платформер');
    seedGame('ai_2', 'shooter', 'Шутер');
    db.rateGame('ai_1', 1, 5);
    db.rateGame('ai_1', 2, 4);
    db.rateGame('ai_2', 1, 2);

    const stats = db.getRatingStats(30);
    assert.equal(stats.votes, 3);
    assert.equal(stats.ratedGames, 2);
    assert.equal(stats.avg, 3.7);

    const platformer = stats.byGenre.find((item) => item.genre === 'platformer');
    assert.equal(platformer.votes, 2);
    assert.equal(platformer.avg, 4.5);

    const top = stats.top[0];
    assert.equal(top.gameId, 'ai_1');
    assert.equal(top.title, 'Платформер');
    assert.match(top.prompt, /platformer/);

    assert.equal(stats.bottom[0].gameId, 'ai_2');
});

test('getRatingStats считает лучшие и худшие игры', () => {
    freshDb();
    seedGame('ai_1', 'platformer', 'Лучшая');
    seedGame('ai_2', 'shooter', 'Худшая');
    db.rateGame('ai_1', 1, 5);
    db.rateGame('ai_2', 1, 1);
    const stats = db.getRatingStats(30);
    assert.equal(stats.top[0].title, 'Лучшая');
    assert.equal(stats.bottom[0].title, 'Худшая');
});

test('getStats отдаёт сводку по оценкам', () => {
    freshDb();
    seedGame('ai_1', 'platformer');
    db.rateGame('ai_1', 1, 4);
    const stats = db.getStats();
    assert.equal(stats.ratings.votes, 1);
    assert.equal(stats.ratings.avg, 4);
});
