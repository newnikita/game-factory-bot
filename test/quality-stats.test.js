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
}

test.afterEach(() => db.closeDb());

test('getQualityStats считает средний балл и частые замечания', () => {
    freshDb();
    db.logEvent('generation_quality', 1, { score: 100, issues: [] });
    db.logEvent('generation_quality', 1, { score: 60, issues: ['overlay_blocking', 'double_dpr_scale'] });
    db.logEvent('improvement_quality', 1, { score: 80, issues: ['double_dpr_scale'] });

    const quality = db.getQualityStats(7);
    assert.equal(quality.count, 3);
    assert.equal(quality.avgScore, 80);
    assert.equal(quality.lowQuality, 1);
    assert.equal(quality.topIssues[0].code, 'double_dpr_scale');
    assert.equal(quality.topIssues[0].occurrences, 2);
});

test('getQualityStats возвращает нули без событий', () => {
    freshDb();
    const quality = db.getStats().quality;
    assert.equal(quality.count, 0);
    assert.equal(quality.avgScore, 0);
    assert.deepEqual(quality.topIssues, []);
});
