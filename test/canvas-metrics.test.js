const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildProbeScript,
    buildForwarderScript,
    isValidMetrics,
    decodeScreenshot,
    scoreMetrics,
    calibrationOffset
} = require('../lib/canvas-metrics');

test('проба измеряет canvas и передаёт метрики родителю', () => {
    const script = buildProbeScript({ gameId: 'ai_123', token: 'secret-token' });
    assert.match(script, /gf-canvas-metrics/);
    assert.match(script, /postMessage/);
    assert.match(script, /ai_123/);
    assert.match(script, /secret-token/);
    assert.match(script, /getImageData/);
    assert.match(script, /toDataURL\('image\/jpeg'/);
    assert.match(script, /requestAnimationFrame\(countFps\)/);
});

test('проба отличает анимацию по пикселям и не отправляет первый одиночный кадр', () => {
    const script = buildProbeScript({ gameId: 'ai_123', token: 'secret-token' });
    assert.match(script, /signatureDiff/, 'анимация должна определяться сравнением пикселей');
    assert.match(script, /schedule\(1200, false\)/, 'ранний кадр не должен уходить отдельным отчётом');
    assert.match(script, /schedule\(3500, true\)/, 'первый отчёт должен опираться на несколько кадров');
});

test('пересылающая страница шлёт метрики на сервер только из своего iframe', () => {
    const script = buildForwarderScript({ gameId: 'ai_123', token: 'secret-token' });
    assert.match(script, /\/api\/canvas-metrics/);
    assert.match(script, /gf-game-frame/);
    assert.match(script, /event\.source !== frame\.contentWindow/);
    assert.match(script, /data\.token !== TOKEN/);
    assert.match(script, /screenshot: data\.screenshot/);
});

test('метрики вне допустимых диапазонов не принимаются', () => {
    assert.equal(isValidMetrics({ coverage: 0.5, colors: 10, shades: 5, contrast: 0.2 }), true);
    assert.equal(isValidMetrics({ coverage: 5, colors: 10, shades: 5, contrast: 0.2 }), false);
    assert.equal(isValidMetrics({ coverage: 0.5, colors: 10, shades: 90, contrast: 0.2 }), false);
    assert.equal(isValidMetrics({ coverage: 0.5, colors: 10, shades: 5, contrast: -1 }), false);
    assert.equal(isValidMetrics(null), false);
    assert.equal(isValidMetrics('нет'), false);
    assert.equal(isValidMetrics({ coverage: 0.5, colors: 10, shades: 5, contrast: 0.2, fps: 55 }), true);
    assert.equal(isValidMetrics({ coverage: 0.5, colors: 10, shades: 5, contrast: 0.2, fps: 999 }), false);
});

test('кадр принимается только как компактный JPEG', () => {
    const jpeg = Buffer.alloc(4096, 0);
    jpeg[0] = 0xFF;
    jpeg[1] = 0xD8;
    jpeg[2] = 0xFF;
    const valid = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const decoded = decodeScreenshot(valid);
    assert.equal(decoded.length, 4096);

    assert.equal(decodeScreenshot(valid.replace('image/jpeg', 'image/png')), null);
    assert.equal(decodeScreenshot('data:image/jpeg;base64,AAAA'), null, 'слишком короткий кадр');
    assert.equal(decodeScreenshot(`data:image/jpeg;base64,${Buffer.alloc(200000, 1).toString('base64')}`), null,
        'слишком большой кадр');
    assert.equal(decodeScreenshot(null), null);
});

test('пустой экран получает нулевую оценку', () => {
    const scored = scoreMetrics({ coverage: 0, colors: 0, shades: 0, contrast: 0, animated: false });
    assert.equal(scored.blank, true);
    assert.equal(scored.score, 0);
    assert.equal(scored.ceiling, 0);
    assert.ok(scored.issues.some((issue) => issue.code === 'blank_canvas'));
});

test('богатая анимированная сцена получает полную оценку', () => {
    const scored = scoreMetrics({ coverage: 0.6, colors: 40, shades: 10, contrast: 0.25, animated: true });
    assert.equal(scored.blank, false);
    assert.equal(scored.score, 100);
    assert.deepEqual(scored.issues, []);
});

test('низкий FPS снижает оценку кадра', () => {
    const base = { coverage: 0.6, colors: 40, shades: 10, contrast: 0.25, animated: true };
    assert.equal(scoreMetrics({ ...base, fps: 58 }).score, 100);
    const slow = scoreMetrics({ ...base, fps: 5 });
    assert.ok(slow.score <= 60);
    assert.ok(slow.issues.some((issue) => issue.code === 'low_fps'));
});

test('плоский кадр теряет баллы по каждому признаку', () => {
    const scored = scoreMetrics({ coverage: 0.02, colors: 2, shades: 1, contrast: 0.01, animated: false });
    assert.ok(scored.score < 60, `оценка слишком высокая: ${scored.score}`);
    const codes = scored.issues.map((issue) => issue.code);
    assert.ok(codes.includes('weak_palette'));
    assert.ok(codes.includes('empty_screen'));
    assert.ok(codes.includes('flat_shading'));
    assert.ok(codes.includes('low_contrast'));
    assert.ok(codes.includes('no_animation'));
});

test('калибровка не применяется без достаточной выборки', () => {
    assert.equal(calibrationOffset([]), null);
    assert.equal(calibrationOffset([{ staticScore: 80, measuredScore: 60 }]), null);
});

test('калибровка опускает потолок, но никогда не завышает его', () => {
    const low = Array.from({ length: 6 }, () => ({ staticScore: 80, measuredScore: 60 }));
    assert.equal(calibrationOffset(low), -20);
    const high = Array.from({ length: 6 }, () => ({ staticScore: 60, measuredScore: 95 }));
    assert.equal(calibrationOffset(high), 0);
});

test('калибровка берёт медиану и игнорирует выбросы', () => {
    const samples = [
        { staticScore: 80, measuredScore: 60 },
        { staticScore: 80, measuredScore: 60 },
        { staticScore: 80, measuredScore: 62 },
        { staticScore: 80, measuredScore: 61 },
        { staticScore: 80, measuredScore: 59 },
        { staticScore: 80, measuredScore: 10 }
    ];
    assert.equal(calibrationOffset(samples), -20);
});
