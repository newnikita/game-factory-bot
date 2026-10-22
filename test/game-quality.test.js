const test = require('node:test');
const assert = require('node:assert/strict');
const { auditGame } = require('../lib/game-quality');

const canvas = '<canvas id="game"></canvas>';

test('аудит ловит полноэкранный оверлей, перекрывающий старт', () => {
    const code = `
        <style>.overlay { position: absolute; inset: 0; z-index: 10; }</style>
        ${canvas}
        <div class="overlay">Start</div>
        <script>document.getElementById('game').addEventListener('pointerdown', () => {});</script>
    `;
    const audit = auditGame(code, 'mobile');
    assert.ok(audit.issues.some(i => i.code === 'overlay_blocking'));
    assert.ok(audit.score < 100);
});

test('оверлей с pointer-events:none не считается блокером', () => {
    const code = `
        <style>.overlay { position: absolute; inset: 0; pointer-events: none; }</style>
        ${canvas}
        <div class="overlay">Start</div>
        <script>document.getElementById('game').addEventListener('pointerdown', () => {});</script>
    `;
    const audit = auditGame(code, 'mobile');
    assert.equal(audit.issues.some(i => i.code === 'overlay_blocking'), false);
});

test('аудит ловит повторное присваивание const', () => {
    const code = `
        <style>.overlay { position: absolute; inset: 0; pointer-events: none; }</style>
        ${canvas}
        <div class="overlay"></div>
        <script>const offscreenCanvasCache = {}; function resize() { offscreenCanvasCache = {}; }</script>
    `;
    const audit = auditGame(code, 'pc');
    assert.ok(audit.issues.some(i => i.code === 'const_reassignment'));
});

test('одинаковые const в разных функциях не считаются переприсваиванием', () => {
    const code = `
        ${canvas}
        <script>
            function drawA() { const bodyWidth = 20; return bodyWidth; }
            function drawB() { const bodyWidth = 40; return bodyWidth; }
        </script>
    `;
    const audit = auditGame(code, 'pc');
    assert.equal(audit.issues.some(i => i.code === 'const_reassignment'), false);
});

test('аудит предупреждает о двойном DPR и раздутом HUD', () => {
    const code = `
        ${canvas}
        <script>
            const canvas = document.getElementById('game');
            const dpr = Math.min(devicePixelRatio, 2);
            canvas.width = canvas.clientWidth * dpr;
            const ctx = canvas.getContext('2d');
            function draw() { ctx.scale(dpr, dpr); ctx.font = 'bold ' + (24 * dpr) + 'px sans-serif'; }
        </script>
    `;
    const audit = auditGame(code, 'mobile');
    assert.ok(audit.issues.some(i => i.code === 'double_dpr_scale'));
    assert.ok(audit.issues.some(i => i.code === 'hud_font_overscaled'));
});

test('аудит предупреждает о частицах без лимита', () => {
    const code = `
        ${canvas}
        <script>
            const particles = [];
            function spawn() { particles.push({ x: 0, y: 0 }); }
        </script>
    `;
    const audit = auditGame(code, 'pc');
    assert.ok(audit.issues.some(i => i.code === 'no_particle_cap'));
});

test('чистая игра без известных ловушек получает 100', () => {
    const code = `
        <style>.overlay { position: absolute; inset: 0; pointer-events: none; }</style>
        ${canvas}
        <div class="overlay"></div>
        <script>
            const canvas = document.getElementById('game');
            const ctx = canvas.getContext('2d');
            const particles = [];
            const MAX_PARTICLES = 80;
            function spawn() { if (particles.length >= MAX_PARTICLES) particles.shift(); particles.push({ x: 0, y: 0 }); }
            function draw() { requestAnimationFrame(draw); }
            draw();
        </script>
    `;
    const audit = auditGame(code, 'mobile');
    assert.equal(audit.score, 100);
    assert.deepEqual(audit.issues, []);
});
