#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');
const axios = require('axios');
const gemini = require('../lib/gemini');

function installDnsFallback() {
    const cache = new Map();
    const remember = (hostname, addresses, options, callback) => {
        cache.set(hostname, addresses);
        if (options && options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
        else callback(null, addresses[0], 4);
    };
    const lookup = (hostname, options, callback) => {
        const cached = cache.get(hostname);
        if (cached) return remember(hostname, cached, options, callback);
        dns.resolve4(hostname, (error, addresses) => {
            if (!error && addresses && addresses.length) return remember(hostname, addresses, options, callback);
            dns.setServers(['8.8.8.8', '1.1.1.1']);
            dns.resolve4(hostname, (fallbackError, fallbackAddresses) => {
                if (fallbackError || !fallbackAddresses || !fallbackAddresses.length) {
                    return callback(fallbackError || error || new Error('DNS: нет A-записи'));
                }
                remember(hostname, fallbackAddresses, options, callback);
            });
        });
    };
    axios.defaults.httpsAgent = new https.Agent({ lookup, keepAlive: true });
}

const PROMPTS = [
    { id: 'defense', text: 'Защити ворота замка от драконов: стреляй из лука и переживи пять волн.' },
    { id: 'runner', text: 'Неоновый раннер по крышам Токио: прыгай, скользи и собирай монеты.' },
    { id: 'shooter', text: 'Космический шутер: выживи среди астероидов и уничтожь три волны врагов.' },
    { id: 'platformer', text: 'Платформер про лесного духа, который собирает светлячков.' },
    { id: 'puzzle', text: 'Головоломка с падающими блоками и комбо.' },
    { id: 'breaker', text: 'Арканоид в стиле киберпанк с тремя бонусами.' },
    { id: 'arena', text: 'Арена на выживание: отбивайся от волн роботов и продержись три минуты.' },
    { id: 'racing', text: 'Гонка на ховербайке по пустыне: успей к финишу и не разбейся.' }
];

function parseArgs(argv) {
    const args = { limit: 3, out: 'eval-output', browser: true, only: null, engines: false, baseline: null, failBelow: 0 };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--limit') args.limit = Number(argv[++i]) || args.limit;
        else if (arg === '--out') args.out = argv[++i] || args.out;
        else if (arg === '--no-browser') args.browser = false;
        else if (arg === '--engines') args.engines = true;
        else if (arg === '--baseline') args.baseline = argv[++i] || null;
        else if (arg === '--fail-below') args.failBelow = Number(argv[++i]) || 0;
        else if (arg === '--only') args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    }
    return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const START_LABEL_SOURCE = '^(начать|играть|старт|start|play|begin|resume|продолжить|заново)([\\s!,.…:—-]|$)';
const CANVAS_TAP_POINTS = [
    [0.5, 0.58], [0.5, 0.5], [0.5, 0.62], [0.5, 0.42], [0.25, 0.5], [0.75, 0.5]
];

function isStartLabel(text) {
    const value = String(text || '').trim();
    if (!value || value.length > 40) return false;
    return new RegExp(START_LABEL_SOURCE, 'i').test(value);
}

function stripRuntimeArtifacts(html) {
    return String(html || '')
        .replace(/\{\{AI_BG_IMAGE\}\}/g, '')
        .replace(/\[BG:\s*[^\]]*\]/gi, '')
        .trim();
}

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/opt/google/chrome/chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);
    return candidates.find((file) => fs.existsSync(file)) || null;
}

async function sampleFps(page, ms = 2000) {
    return page.evaluate((duration) => new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const start = last;
        function tick(now) {
            deltas.push(now - last);
            last = now;
            if (now - start < duration) requestAnimationFrame(tick);
            else {
                const sorted = deltas.slice(1).sort((a, b) => a - b);
                const avg = deltas.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, deltas.length - 1);
                resolve({
                    rafPerSec: Math.round(((deltas.length - 1) / ((now - start) / 1000)) * 10) / 10,
                    avgFrameMs: Math.round(avg * 10) / 10,
                    p95FrameMs: Math.round((sorted[Math.floor(sorted.length * 0.95)] || 0) * 10) / 10
                });
            }
        }
        requestAnimationFrame(tick);
    }), ms);
}

async function mainThread(page, ms = 2000) {
    const before = await page.metrics();
    await sleep(ms);
    const after = await page.metrics();
    const elapsed = after.Timestamp - before.Timestamp;
    return {
        mainThreadPct: Math.round(((after.TaskDuration - before.TaskDuration) / elapsed) * 1000) / 10,
        scriptMsPerSec: Math.round(((after.ScriptDuration - before.ScriptDuration) / elapsed) * 1000) / 10
    };
}

async function canvasSignature(page) {
    return page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas || !canvas.width || !canvas.height) return null;
        try {
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261;
            let nonBlank = 0;
            for (let i = 0; i < data.length; i += 64) {
                const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
                if (a > 10 && r + g + b > 10) nonBlank++;
                hash = ((hash ^ r) * 16777619) >>> 0;
                hash = ((hash ^ g) * 16777619) >>> 0;
                hash = ((hash ^ b) * 16777619) >>> 0;
                hash = ((hash ^ a) * 16777619) >>> 0;
            }
            return { hash, nonBlank, width: canvas.width, height: canvas.height };
        } catch (error) {
            return { error: String(error && error.message || error) };
        }
    });
}

async function probeState(page) {
    return page.evaluate(() => {
        const result = {};
        for (const name of ['gameState', 'gameStatus', 'currentState', 'state', 'game']) {
            try {
                const value = eval(name);
                if (typeof value === 'string' || typeof value === 'number') result[name] = value;
                else if (value && typeof value === 'object') {
                    result[name] = value.mode || value.state || value.status || value.screen || null;
                }
            } catch (error) { /* переменная не объявлена */ }
        }
        const isVisible = (el) => {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
        };
        const menus = [...document.querySelectorAll('#menu, .menu, .overlay, #start-screen, #startScreen')];
        result.visibleOverlays = menus.filter(isVisible).length;
        const startScreen = document.querySelector('#menu-overlay, #menu, #start-screen, #startScreen');
        result.menuVisible = startScreen ? isVisible(startScreen) : null;
        return result;
    });
}

async function findStartTarget(page) {
    return page.evaluate((pattern) => {
        const regex = new RegExp(pattern, 'i');
        const nodes = [...document.querySelectorAll('button, a, p, div, span, h1, h2, li, label')];
        let best = null;
        let bestElement = null;
        for (const node of nodes) {
            const label = String(node.textContent || '').trim();
            if (!label || label.length > 40) continue;
            if (!regex.test(label)) continue;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            if (rect.right < 0 || rect.left > window.innerWidth) continue;
            const area = rect.width * rect.height;
            if (!best || area < best.area) {
                best = { area, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: label.slice(0, 40) };
                bestElement = node;
            }
        }
        if (bestElement) {
            try { bestElement.click(); } catch (error) { /* у кнопки нет обработчика click */ }
        }
        return best ? { x: best.x, y: best.y, label: best.label } : null;
    }, START_LABEL_SOURCE);
}

async function canvasRect(page) {
    return page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
}

async function interact(page, capture) {
    const actions = [];
    const shoot = typeof capture === 'function' ? capture : async () => {};
    const target = await findStartTarget(page).catch(() => null);
    if (target) {
        await page.touchscreen.tap(target.x, target.y).catch(() => {});
        actions.push(`кнопка старта «${target.label}»`);
        await sleep(120);
        await shoot();
        await sleep(400);
    }
    const rect = await canvasRect(page).catch(() => null);
    if (rect) {
        for (const [index, [rx, ry]] of CANVAS_TAP_POINTS.entries()) {
            await page.touchscreen.tap(rect.left + rect.width * rx, rect.top + rect.height * ry).catch(() => {});
            await sleep(200);
            if (index === 0) await shoot();
        }
        actions.push('точки по холсту');
        for (let round = 0; round < 3; round++) {
            for (const [rx, ry] of [[0.2, 0.6], [0.2, 0.75], [0.35, 0.6]]) {
                await page.touchscreen.tap(rect.left + rect.width * rx, rect.top + rect.height * ry).catch(() => {});
                await sleep(150);
            }
        }
        actions.push('прыжки');
    }
    for (const point of [{ x: 195, y: 420 }, { x: 195, y: 500 }, { x: 195, y: 650 }, { x: 195, y: 750 }, { x: 100, y: 420 }]) {
        await page.touchscreen.tap(point.x, point.y).catch(() => {});
        await sleep(250);
    }
    for (const key of ['Space', 'Enter', 'ArrowUp', 'ArrowRight']) {
        await page.keyboard.press(key).catch(() => {});
        await sleep(150);
    }
    return actions;
}

async function browserCheck(browser, html, outPath, pageLimitMs = 45000) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)));
    page.on('requestfailed', (request) => failedRequests.push(`${request.url().slice(0, 120)} :: ${request.failure()?.errorText}`));

    const result = { errors: consoleErrors, pageErrors, failedRequests };
    const runnableHtml = stripRuntimeArtifacts(html);
    try {
        await page.setContent(runnableHtml, { waitUntil: 'domcontentloaded', timeout: pageLimitMs });
        await sleep(1500);
        result.before = await probeState(page);
        result.signatureBefore = await canvasSignature(page);
        const capture = async () => {
            const probe = await probeState(page).catch(() => null);
            if (result.screenshot && probe && probe.menuVisible === false) return;
            result.screenshot = outPath.replace(/\.html$/i, '.png');
            await page.screenshot({ path: result.screenshot });
        };
        result.actions = await interact(page, capture);
        await sleep(600);
        result.after = await probeState(page);
        result.signatureAfter = await canvasSignature(page);
        result.started = result.before.menuVisible ? !result.after.menuVisible : null;
        result.changed = Boolean(
            result.signatureBefore && result.signatureAfter &&
            result.signatureBefore.hash !== result.signatureAfter.hash
        );
        result.canvas = await page.evaluate(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return null;
            return {
                backing: [canvas.width, canvas.height],
                css: [canvas.clientWidth, canvas.clientHeight],
                rect: (() => { const r = canvas.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()
            };
        });
        result.dpr = await page.evaluate(() => window.devicePixelRatio);
        result.fps = await sampleFps(page);
        result.mainThread = await mainThread(page);
    } catch (error) {
        result.error = String(error && error.message || error);
    } finally {
        await page.close().catch(() => {});
    }
    return result;
}

async function reviewScreenshotFile(bot, filePath, brief) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const buffer = fs.readFileSync(filePath);
        const { reviewScreenshot } = require('../lib/game-vision');
        return await reviewScreenshot(buffer, { brief, platform: 'mobile' });
    } catch (error) {
        console.error('[Vision] Ревью скриншота не удалось:', error.message);
        return null;
    }
}

async function runEngines(browser, bot, outDir) {
    const hybrid = require('../lib/hybrid');
    const results = [];
    const genres = ['platformer'];
    for (const genre of genres) {
        const engine = hybrid.getEngine(genre);
        if (!engine) continue;
        const record = { id: `engine_${genre}`, genre };
        try {
            const specResult = await hybrid.generateSpec('Платформер про лесного духа, который собирает светлячков');
            record.spec = specResult.spec;
            const html = engine.render(specResult.spec, {});
            const htmlPath = path.join(outDir, `${record.id}.html`);
            fs.writeFileSync(htmlPath, html);
            record.bytes = Buffer.byteLength(html);
            record.audit = bot.auditGame(html, 'mobile');
            if (browser) {
                record.runtime = await browserCheck(browser, html, htmlPath);
                record.vision = await reviewScreenshotFile(bot, record.runtime.screenshot, 'Платформер про лесного духа');
            }
            console.log(`engine ${genre}: audit=${record.audit.score} errors=${record.runtime ? record.runtime.pageErrors.length + record.runtime.errors.length : 'n/a'}`);
        } catch (error) {
            record.error = String(error && error.stack || error);
            console.error(`engine ${genre} FAILED:`, error.message);
        }
        results.push(record);
    }
    return results;
}

async function run() {
    const args = parseArgs(process.argv);
    installDnsFallback();
    const bot = require('../bot');
    if (!process.env.GEMINI_API_KEY) {
        console.error('GEMINI_API_KEY не задан. eval-стенд не может генерировать игры.');
        process.exit(1);
    }

    const outDir = path.resolve(args.out);
    fs.mkdirSync(outDir, { recursive: true });

    let prompts = PROMPTS;
    if (args.only && args.only.length) prompts = prompts.filter((prompt) => args.only.includes(prompt.id));
    prompts = prompts.slice(0, Math.max(1, args.limit));

    let browser = null;
    if (args.browser) {
        const executablePath = findChrome();
        if (!executablePath) {
            console.error('Chrome/Edge не найден. Укажи CHROME_PATH или запусти с --no-browser.');
            process.exit(1);
        }
        const puppeteer = require('puppeteer-core');
        browser = await puppeteer.launch({
            executablePath,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--enable-gpu'
            ]
        });
    }

    const report = {
        startedAt: new Date().toISOString(),
        model: gemini.PRIMARY_MODEL,
        fallbackModel: gemini.FALLBACK_MODEL,
        promptVersion: bot.PROMPT_VERSION,
        prompts: [],
        engines: [],
        summary: {}
    };

    const availableModels = await gemini.listModels();
    if (availableModels.length) {
        console.log(`Модели в доступе: ${availableModels.join(', ')}`);
    }

    for (const prompt of prompts) {
        const record = { id: prompt.id, prompt: prompt.text };
        console.log(`\n=== ${prompt.id}: ${prompt.text}`);
        const started = Date.now();
        try {
            const plan = await bot.generateGamePlan(prompt.text, 'mobile');
            record.plan = plan.plan;
            record.planTokens = { input: plan.inputTokens, output: plan.outputTokens };
            const generated = await bot.generateAIGame(prompt.text, 'mobile', { plan: plan.plan });
            if (!generated || !generated.code) throw new Error('модель не вернула полный HTML');
            record.generatedTokens = { input: generated.inputTokens, output: generated.outputTokens };
            record.model = generated.model;
            record.fallbackUsed = Boolean(generated.fallbackUsed);

            const initial = bot.collectQualityIssues(generated.code, 'mobile');
            record.initialAudit = { score: initial.technicalScore, issues: initial.issues.map((i) => i.msg) };

            const quality = await bot.runQualityPipeline(generated.code, {
                platform: 'mobile',
                brief: prompt.text,
                plan: plan.plan
            });

            const code = quality.code;
            record.pipeline = {
                score: quality.score,
                technicalScore: quality.technicalScore,
                criticScore: quality.criticScore,
                criticNoVerdict: Boolean(quality.critic && quality.critic.noVerdict),
                patched: quality.patched,
                repaired: quality.repaired,
                polished: quality.polished,
                issues: quality.issueCodes
            };
            record.finalAudit = { score: quality.technicalScore, issues: quality.issues.map((i) => i.msg) };
            record.bytes = Buffer.byteLength(code);
            record.htmlPath = path.join(outDir, `${prompt.id}.html`);
            fs.writeFileSync(record.htmlPath, code);

            if (browser) {
                record.runtime = await browserCheck(browser, code, record.htmlPath);
                record.vision = await reviewScreenshotFile(bot, record.runtime.screenshot, prompt.text);
            }
            record.durationMs = Date.now() - started;
            console.log(`score=${quality.score} tech=${quality.technicalScore} critic=${quality.criticScore} ` +
                `model=${record.model}${record.fallbackUsed ? ' (fallback)' : ''} ` +
                (record.runtime ? `fps=${record.runtime.fps?.rafPerSec} errors=${record.runtime.pageErrors.length + record.runtime.errors.length} started=${record.runtime.started} changed=${record.runtime.changed} ` : '') +
                (record.vision ? `vision=${record.vision.score}` : ''));
        } catch (error) {
            record.error = String(error && error.stack || error);
            record.durationMs = Date.now() - started;
            console.error('FAILED:', error.message);
        }
        report.prompts.push(record);
    }

    if (args.engines) {
        report.engines = await runEngines(browser, bot, outDir);
    }

    if (browser) await browser.close();

    const completed = report.prompts.filter((p) => !p.error && p.pipeline);
    const withVision = completed.filter((p) => p.vision);
    const withCritic = completed.filter((p) => typeof p.pipeline.criticScore === 'number');
    report.summary = {
        requested: prompts.length,
        completed: completed.length,
        failed: report.prompts.length - completed.length,
        avgScore: completed.length ? Math.round(completed.reduce((sum, p) => sum + p.pipeline.score, 0) / completed.length) : 0,
        avgTechnical: completed.length ? Math.round(completed.reduce((sum, p) => sum + p.pipeline.technicalScore, 0) / completed.length) : 0,
        criticScored: withCritic.length,
        criticUnavailable: completed.length - withCritic.length,
        avgCritic: withCritic.length ? Math.round(withCritic.reduce((sum, p) => sum + p.pipeline.criticScore, 0) / withCritic.length) : 0,
        avgVisionScore: withVision.length ? Math.round(withVision.reduce((sum, p) => sum + p.vision.score, 0) / withVision.length) : 0,
        patched: completed.filter((p) => p.pipeline.patched).length,
        polished: completed.filter((p) => p.pipeline.polished).length,
        runtimeErrors: completed.filter(p => p.runtime && (p.runtime.pageErrors.length || p.runtime.errors.length)).length,
        avgRafPerSec: completed.filter(p => p.runtime && p.runtime.fps)
            .reduce((sum, p, _, list) => sum + p.runtime.fps.rafPerSec / list.length, 0) || 0,
        changedGames: completed.filter(p => p.runtime && p.runtime.changed).length,
        startedGames: completed.filter(p => p.runtime && p.runtime.started === true).length,
        fallbackUsed: completed.filter(p => p.fallbackUsed).length
    };
    report.finishedAt = new Date().toISOString();

    const reportPath = path.join(outDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nОтчёт: ${reportPath}`);
    console.log(JSON.stringify(report.summary, null, 2));

    let exitCode = 0;
    if (args.failBelow && report.summary.avgScore < args.failBelow) {
        console.error(`\n❌ Регрессия: средний score ${report.summary.avgScore} ниже порога ${args.failBelow}`);
        exitCode = 1;
    }
    if (args.baseline && fs.existsSync(args.baseline)) {
        try {
            const baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
            const base = (baseline.summary && baseline.summary.avgScore) || 0;
            const delta = report.summary.avgScore - base;
            console.log(`\nBaseline: ${base} → сейчас ${report.summary.avgScore} (Δ ${delta >= 0 ? '+' : ''}${delta})`);
            if (delta < 0) {
                console.error('❌ Качество упало относительно baseline.');
                exitCode = 1;
            }
        } catch (error) {
            console.error('Не удалось прочитать baseline:', error.message);
        }
    }
    process.exit(exitCode);
}

module.exports = { isStartLabel, stripRuntimeArtifacts, browserCheck, findChrome, PROMPTS };

if (require.main === module) {
    run().catch((error) => {
        console.error(error && error.stack || error);
        process.exit(1);
    });
}
