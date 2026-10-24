const DEFAULT_URL = 'https://game-factory-bot.onrender.com';
const REQUIRED_DATA_DIR = '/var/data';

function evaluateHealth(health, ready) {
    const config = (health && health.config) || {};
    const gemini = (health && health.gemini) || {};
    const checks = [];
    const warn = [];

    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

    add('/healthz отвечает', health && health.ok === true, health && health.version ? `версия ${health.version}` : 'нет ответа');
    add('/readyz: база доступна', ready && ready.ok === true, ready && ready.error ? String(ready.error) : 'ok');
    add('каталог данных на диске', config.data_dir === REQUIRED_DATA_DIR, `data_dir=${config.data_dir || '—'}, нужно ${REQUIRED_DATA_DIR}`);
    add('диск постоянный', config.data_persistent === true, `data_persistent=${String(config.data_persistent)}, нужно true`);
    add('админ-токен задан', config.admin_api_token === true, `admin_api_token=${String(config.admin_api_token)}`);
    add('секрет замера свой', config.visual_secret === 'own', `visual_secret=${String(config.visual_secret)}`);
    add('токен бота задан', config.bot_token === true, `bot_token=${String(config.bot_token)}`);
    add('ключ Gemini задан', config.gemini_key === true, `gemini_key=${String(config.gemini_key)}`);
    add('рекламные ссылки заданы', config.webapp_url === true && config.games_public_url === true,
        `webapp_url=${String(config.webapp_url)}, games_public_url=${String(config.games_public_url)}`);
    add('админы настроены', config.admin_ids === true, `admin_ids=${String(config.admin_ids)}`);

    const legalMissing = Array.isArray(config.legal_missing) ? config.legal_missing : [];
    if (legalMissing.length > 0) {
        warn.push({ name: 'реквизиты в юрдокументах', detail: `не заполнено: ${legalMissing.join(', ')}` });
    }
    if (gemini.generation_available !== true) {
        warn.push({ name: 'генерация доступна', detail: gemini.reason || `generation_available=${String(gemini.generation_available)}` });
    }
    const alerts = Array.isArray(health && health.alerts) ? health.alerts : [];
    for (const alert of alerts) {
        warn.push({ name: `алерт: ${alert.key || 'без ключа'}`, detail: alert.message || String(alert) });
    }

    const failed = checks.filter((item) => !item.ok);
    return { ok: failed.length === 0, checks, failed, warnings: warn };
}

async function fetchJson(url, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 30000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

const color = (code) => (process.stdout.isTTY ? `\x1b[${code}m` : '');
const GREEN = color('32');
const RED = color('31');
const YELLOW = color('33');
const RESET = color('0');

function printReport(url, report) {
    console.log(`Проверка прода: ${url}`);
    for (const item of report.checks) {
        const mark = item.ok ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
        console.log(`${mark} ${item.name}: ${item.detail}`);
    }
    for (const item of report.warnings) {
        console.log(`${YELLOW}⚠️${RESET} ${item.name}: ${item.detail}`);
    }
    const passed = report.checks.length - report.failed.length;
    if (report.ok) {
        console.log(`${GREEN}Итог: ${passed}/${report.checks.length} обязательных проверок пройдено.${RESET}`);
    } else {
        console.log(`${RED}Итог: ${report.failed.length} из ${report.checks.length} обязательных проверок провалены.${RESET}`);
    }
}

async function main() {
    const url = process.argv[2] || process.env.PROD_URL || DEFAULT_URL;
    const base = url.replace(/\/+$/, '');
    let health;
    let ready;
    try {
        [health, ready] = await Promise.all([
            fetchJson(`${base}/healthz`),
            fetchJson(`${base}/readyz`)
        ]);
    } catch (error) {
        console.error(`${RED}Не удалось прочитать прод: ${error.message}${RESET}`);
        process.exitCode = 2;
        return;
    }
    const report = evaluateHealth(health, ready);
    printReport(base, report);
    if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
    main();
}

module.exports = { evaluateHealth, DEFAULT_URL };
