const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isStartLabel, stripRuntimeArtifacts, compareWithBaseline, browserCheck, findChrome } = require('../scripts/eval-games');

test('stripRuntimeArtifacts убирает плейсхолдер фона и маркер [BG:]', () => {
    const html = '<html><body><canvas id="g"></canvas>\n[BG: Neon Tokyo Skyline]\n</body></html>';
    const cleaned = stripRuntimeArtifacts(html);
    assert.ok(!cleaned.includes('{{AI_BG_IMAGE}}'));
    assert.ok(!/\[BG:/i.test(cleaned));
    assert.ok(cleaned.includes('<canvas id="g">'));
});

test('stripRuntimeArtifacts вычищает маркер, добавленный после </html>', () => {
    const cleaned = stripRuntimeArtifacts('<html><body>игра</body></html>\n[BG: Neon Tokyo Skyline]');
    assert.ok(!/\[BG:/i.test(cleaned));
    assert.ok(cleaned.endsWith('</html>'));
});

test('stripRuntimeArtifacts не трогает обычный код', () => {
    const html = '<html><body><canvas></canvas></body></html>';
    assert.equal(stripRuntimeArtifacts(html), html);
});

test('isStartLabel узнаёт кнопки старта на русском и английском', () => {
    assert.equal(isStartLabel('НАЧАТЬ ИГРУ'), true);
    assert.equal(isStartLabel('Играть'), true);
    assert.equal(isStartLabel('ИГРАТЬ СНОВА'), true);
    assert.equal(isStartLabel('ПРОДОЛЖИТЬ'), true);
    assert.equal(isStartLabel('Start'), true);
    assert.equal(isStartLabel('Play'), true);
});

test('isStartLabel не путает обычный текст с кнопкой старта', () => {
    assert.equal(isStartLabel('ТОКИО РАННЕР'), false);
    assert.equal(isStartLabel('Нажми слева для прыжка'), false);
    assert.equal(isStartLabel('Стартовый экран'), false);
    assert.equal(isStartLabel(''), false);
    assert.equal(isStartLabel('x'.repeat(60)), false);
});

test('проба Gemini без ключа падает с понятной ошибкой', () => {
    const script = path.join(__dirname, '..', 'scripts', 'probe-gemini.js');
    const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, GEMINI_API_KEY: '' },
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GEMINI_API_KEY не задан/);
});

function makeReport(scores) {
    return {
        summary: { avgScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length), completed: scores.length },
        prompts: scores.map((score, index) => ({ id: `game${index}`, pipeline: { score } }))
    };
}

test('A/B гейт пропускает прогон без просадки', () => {
    const comparison = compareWithBaseline(makeReport([90, 80]), makeReport([92, 85]));
    assert.equal(comparison.exitCode, 0);
    assert.equal(comparison.errors.length, 0);
    assert.match(comparison.lines.join('\n'), /game0: 90 → 92/);
});

test('A/B гейт ловит просадку качества по конкретной игре', () => {
    const comparison = compareWithBaseline(makeReport([90, 80]), makeReport([92, 60]));
    assert.equal(comparison.exitCode, 1);
    assert.match(comparison.errors.join('\n'), /game1: 80 → 60/);
});

test('A/B гейт считает неполный прогон невалидным, а не регрессией', () => {
    const comparison = compareWithBaseline(makeReport([90, 80]), makeReport([95]));
    assert.equal(comparison.exitCode, 1);
    assert.match(comparison.errors.join('\n'), /Прогон неполный/);
});

test('A/B гейт не сравнивает игры, сделанные разными моделями', () => {
    const baseline = {
        summary: { avgScore: 90, completed: 1 },
        prompts: [{ id: 'game0', model: 'model-a', pipeline: { score: 90 } }]
    };
    const current = {
        summary: { avgScore: 40, completed: 1 },
        prompts: [{ id: 'game0', model: 'model-b', pipeline: { score: 40 } }]
    };
    const comparison = compareWithBaseline(baseline, current);
    assert.equal(comparison.exitCode, 0);
    assert.match(comparison.lines.join('\n'), /не сопоставимо/);
});

const PLAY_FRAME_GAME = `<!DOCTYPE html>
<html><head><style>
body { margin: 0; background: #000; }
canvas { display: block; width: 100vw; height: 100vh; }
#start-btn { position: fixed; top: 40%; left: 30%; z-index: 5; font: 20px sans-serif; padding: 12px 24px; }
#game-over { position: fixed; inset: 0; background: #ffffff; color: #000; font: 24px sans-serif; display: none; }
</style></head>
<body>
<canvas id="g"></canvas>
<div id="game-over">СИСТЕМНЫЙ СБОЙ</div>
<button id="start-btn">Играть</button>
<script>
const ctx = document.getElementById('g').getContext('2d');
let started = false;
function start() {
    if (started) return;
    started = true;
    document.getElementById('start-btn').style.display = 'none';
    setTimeout(() => { document.getElementById('game-over').style.display = 'block'; }, 4000);
}
document.addEventListener('pointerdown', start);
function loop() {
    requestAnimationFrame(loop);
    ctx.fillStyle = started ? '#00ff00' : '#000088';
    ctx.fillRect(0, 0, 100, 100);
}
loop();
</script>
</body></html>`;

test('browserCheck снимает игровой кадр, а не экран проигрыша', async (t) => {
    const chrome = findChrome();
    if (!chrome) {
        t.skip('Chrome не найден — проверка кадра пропущена');
        return;
    }
    let puppeteer;
    try {
        puppeteer = require('puppeteer-core');
    } catch (error) {
        t.skip('puppeteer-core не установлен');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-eval-'));
    const htmlPath = path.join(dir, 'game.html');
    fs.writeFileSync(htmlPath, PLAY_FRAME_GAME);

    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        const result = await browserCheck(browser, PLAY_FRAME_GAME, htmlPath);
        assert.ok(result.playShot, 'игровой кадр должен быть снят');
        assert.equal(result.screenshotKind, 'play');
        assert.ok(result.after.visibleOverlays > 0, 'к концу прогона экран проигрыша уже показан');

        const shotPath = path.join(dir, 'game.png');
        assert.ok(fs.existsSync(shotPath));
        const pixel = await readPixel(browser, shotPath, 60, 60);
        assert.ok(pixel.g > 120 && pixel.r < 120, `кадр должен быть игровым (зелёный фон), а не экраном проигрыша: ${JSON.stringify(pixel)}`);
    } finally {
        await browser.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

async function readPixel(browser, filePath, x, y) {
    const page = await browser.newPage();
    try {
        const base64 = fs.readFileSync(filePath).toString('base64');
        return await page.evaluate(async (data, px, py) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            const pixel = ctx.getImageData(px, py, 1, 1).data;
            return { r: pixel[0], g: pixel[1], b: pixel[2] };
        }, base64, x, y);
    } finally {
        await page.close();
    }
}
