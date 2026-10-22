#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');
const axios = require('axios');

function installDnsFallback() {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    const cache = new Map();
    const lookup = (hostname, options, callback) => {
        const cached = cache.get(hostname);
        if (cached) {
            return options && options.all
                ? callback(null, cached.map((address) => ({ address, family: 4 })))
                : callback(null, cached[0], 4);
        }
        dns.resolve4(hostname, (error, addresses) => {
            if (error || !addresses || !addresses.length) return callback(error || new Error('DNS: нет A-записи'));
            cache.set(hostname, addresses);
            if (options && options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
            else callback(null, addresses[0], 4);
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
    const args = { limit: 3, out: 'eval-output', browser: true, only: null };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--limit') args.limit = Number(argv[++i]) || args.limit;
        else if (arg === '--out') args.out = argv[++i] || args.out;
        else if (arg === '--no-browser') args.browser = false;
        else if (arg === '--only') args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    }
    return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        for (const name of ['gameState', 'gameStatus', 'state', 'game']) {
            try {
                const value = eval(name);
                if (typeof value === 'string' || typeof value === 'number') result[name] = value;
                else if (value && typeof value === 'object') {
                    result[name] = value.mode || value.state || value.status || value.screen || null;
                }
            } catch (error) { /* переменная не объявлена */ }
        }
        const menus = [...document.querySelectorAll('#menu, .menu, .overlay, #start-screen, #startScreen')];
        result.visibleOverlays = menus.filter((el) => {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
        }).length;
        return result;
    });
}

async function interact(page) {
    const points = [
        { x: 195, y: 420 },
        { x: 195, y: 650 },
        { x: 195, y: 750 },
        { x: 100, y: 420 }
    ];
    for (const point of points) {
        await page.touchscreen.tap(point.x, point.y).catch(() => {});
        await sleep(250);
    }
    for (const key of ['Space', 'Enter', 'ArrowUp', 'ArrowRight']) {
        await page.keyboard.press(key).catch(() => {});
        await sleep(150);
    }
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
    const runnableHtml = html.replace(/\{\{AI_BG_IMAGE\}\}/g, '');
    try {
        await page.setContent(runnableHtml, { waitUntil: 'domcontentloaded', timeout: pageLimitMs });
        await sleep(1500);
        result.before = await probeState(page);
        result.signatureBefore = await canvasSignature(page);
        await interact(page);
        await sleep(1200);
        result.after = await probeState(page);
        result.signatureAfter = await canvasSignature(page);
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
        result.screenshot = outPath.replace(/\.html$/i, '.png');
        await page.screenshot({ path: result.screenshot });
    } catch (error) {
        result.error = String(error && error.message || error);
    } finally {
        await page.close().catch(() => {});
    }
    return result;
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
        model: 'gemini-2.5-flash',
        prompts: [],
        summary: {}
    };

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

            let code = generated.code;
            const initialIssues = bot.validateGameCode(code, 'mobile');
            const initialAudit = bot.auditGame(code, 'mobile');
            record.initialValidation = {
                critical: initialIssues.filter(i => i.level === 'critical').map(i => i.msg),
                warnings: initialIssues.filter(i => i.level === 'warning').map(i => i.msg)
            };
            record.initialAudit = initialAudit;

            const criticalIssues = initialIssues.filter(i => i.level === 'critical')
                .concat(initialAudit.issues.filter(i => i.level === 'critical'));
            if (criticalIssues.length) {
                const repaired = await bot.repairGameCode(code, criticalIssues, 'mobile');
                code = repaired.code;
            }

            const finalIssues = bot.validateGameCode(code, 'mobile');
            const finalAudit = bot.auditGame(code, 'mobile');
            record.finalValidation = {
                critical: finalIssues.filter(i => i.level === 'critical').map(i => i.msg),
                warnings: finalIssues.filter(i => i.level === 'warning').map(i => i.msg)
            };
            record.finalAudit = finalAudit;
            record.bytes = Buffer.byteLength(code);
            record.htmlPath = path.join(outDir, `${prompt.id}.html`);
            fs.writeFileSync(record.htmlPath, code);

            if (browser) {
                record.runtime = await browserCheck(browser, code, record.htmlPath);
            }
            record.durationMs = Date.now() - started;
            console.log(`audit=${finalAudit.score} crit=${record.finalValidation.critical.length} warn=${record.finalValidation.warnings.length}` +
                (record.runtime ? ` fps=${record.runtime.fps?.rafPerSec} errors=${record.runtime.pageErrors.length + record.runtime.errors.length} changed=${record.runtime.changed}` : ''));
        } catch (error) {
            record.error = String(error && error.stack || error);
            record.durationMs = Date.now() - started;
            console.error('FAILED:', error.message);
        }
        report.prompts.push(record);
    }

    if (browser) await browser.close();

    const completed = report.prompts.filter((p) => !p.error && p.finalAudit);
    report.summary = {
        requested: prompts.length,
        completed: completed.length,
        avgAuditScore: completed.length ? Math.round(completed.reduce((sum, p) => sum + p.finalAudit.score, 0) / completed.length) : 0,
        runtimeErrors: completed.filter(p => p.runtime && (p.runtime.pageErrors.length || p.runtime.errors.length)).length,
        avgRafPerSec: completed.filter(p => p.runtime && p.runtime.fps)
            .reduce((sum, p, _, list) => sum + p.runtime.fps.rafPerSec / list.length, 0) || 0,
        changedGames: completed.filter(p => p.runtime && p.runtime.changed).length
    };
    report.finishedAt = new Date().toISOString();

    const reportPath = path.join(outDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nОтчёт: ${reportPath}`);
    console.log(JSON.stringify(report.summary, null, 2));
}

run().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
});
