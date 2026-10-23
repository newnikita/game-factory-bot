const test = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../lib/health-monitor');

test.beforeEach(() => monitor.reset());

test('монитор считает генерации, ошибки и средний балл', () => {
    monitor.recordGenerationStarted();
    monitor.recordGenerationSucceeded({ score: 80 });
    monitor.recordGenerationSucceeded({ score: 60 });
    monitor.recordGenerationFailed({ error: 'квота исчерпана' });
    monitor.recordCritic('model');
    monitor.recordCritic('audit');

    const snapshot = monitor.snapshot();
    assert.equal(snapshot.generations.started, 1);
    assert.equal(snapshot.generations.succeeded, 2);
    assert.equal(snapshot.generations.failed, 1);
    assert.equal(snapshot.averageScore, 70);
    assert.equal(snapshot.pipeline.criticModel, 1);
    assert.equal(snapshot.pipeline.criticAudit, 1);
});

test('успешная генерация сбрасывает серию ошибок', () => {
    monitor.recordGenerationFailed({ error: 'первая' });
    monitor.recordGenerationFailed({ error: 'вторая' });
    monitor.recordGenerationSucceeded({ score: 90, criticSource: 'model' });
    monitor.recordGenerationFailed({ error: 'третья' });

    assert.equal(monitor.snapshot().generations.consecutiveFailures, 1);
    assert.equal(monitor.evaluate().some((alert) => alert.key === 'generation_failures'), false);
});

test('три ошибки подряд поднимают критический алерт', () => {
    monitor.recordGenerationFailed({ error: 'модель не ответила' });
    monitor.recordGenerationFailed({ error: 'модель не ответила' });
    monitor.recordGenerationFailed({ error: 'модель не ответила' });

    const alert = monitor.evaluate().find((item) => item.key === 'generation_failures');
    assert.ok(alert, 'нужен алерт о серии ошибок');
    assert.equal(alert.level, 'critical');
    assert.match(alert.text, /модель не ответила/);
});

test('критик, молчащий на последних играх, поднимает предупреждение', () => {
    for (let i = 0; i < 10; i++) {
        monitor.recordGenerationSucceeded({ score: 70, criticSource: 'audit' });
    }
    const alert = monitor.evaluate().find((item) => item.key === 'critic_unavailable');
    assert.ok(alert, 'нужен алерт о недоступном критике');
    assert.equal(alert.level, 'warn');
});

test('пока критик отвечает, предупреждения нет', () => {
    for (let i = 0; i < 10; i++) {
        monitor.recordGenerationSucceeded({ score: 90, criticSource: 'model' });
    }
    assert.equal(monitor.evaluate().some((item) => item.key === 'critic_unavailable'), false);
});

test('исчерпание квоты поднимает критический алерт', () => {
    monitor.recordQuotaError();
    const alert = monitor.evaluate().find((item) => item.key === 'quota_exhausted');
    assert.ok(alert);
    assert.equal(alert.level, 'critical');
});

test('пустой экран попадает в алерты с идентификатором игры', () => {
    monitor.recordCanvasReport({ blank: true, gameId: 'ai_123' });
    const alert = monitor.evaluate().find((item) => item.key === 'canvas_blank');
    assert.ok(alert);
    assert.match(alert.text, /ai_123/);
});

test('стадии конвейера считаются отдельно по успеху и провалу', () => {
    monitor.recordPipelineStage('patch', true);
    monitor.recordPipelineStage('patch', false);
    monitor.recordPipelineStage('repair', false);
    monitor.recordPipelineStage('polish', true);
    monitor.recordTdzRepaired(2);

    const pipeline = monitor.snapshot().pipeline;
    assert.equal(pipeline.patched, 1);
    assert.equal(pipeline.patchFailed, 1);
    assert.equal(pipeline.repairFailed, 1);
    assert.equal(pipeline.polished, 1);
    assert.equal(pipeline.tdzRepaired, 2);
});
