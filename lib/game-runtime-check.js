'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKER_PATH = path.join(__dirname, 'runtime-sandbox.js');
const PROCESS_TIMEOUT_MS = 6000;
const SCRIPT_TIMEOUT_MS = 1500;
const MEMORY_LIMIT_MB = 96;

const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

function extractScripts(code) {
    return extractScriptBlocks(code).map((block) => block.js);
}

// Скрипты вместе с их позициями в HTML: нужны, чтобы детерминированно
// переписать содержимое конкретного <script> по найденной ошибке.
function extractScriptBlocks(code) {
    const blocks = [];
    const text = String(code || '');
    SCRIPT_RE.lastIndex = 0;
    let match;
    while ((match = SCRIPT_RE.exec(text)) !== null) {
        const attrs = match[1] || '';
        if (/\ssrc\s*=/.test(attrs)) continue;
        const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (type && !/javascript|module/i.test(type)) continue;
        const raw = match[2] || '';
        const js = raw.trim();
        if (!js) continue;
        const contentStart = match.index + match[0].indexOf(raw);
        const lead = raw.length - raw.trimStart().length;
        blocks.push({ js, start: contentStart + lead, end: contentStart + lead + js.length });
    }
    return blocks;
}

// Игра генерируется моделью, поэтому код выполняется в отдельном процессе
// с лимитом памяти и времени: бесконечный цикл или огромный массив
// не должны ронять бота.
function checkRuntimeErrors(code, options = {}) {
    const scripts = extractScripts(code);
    if (!scripts.length) return { ok: true, errors: [] };

    let result;
    try {
        result = spawnSync(
            process.execPath,
            [`--max-old-space-size=${MEMORY_LIMIT_MB}`, WORKER_PATH],
            {
                input: JSON.stringify({ scripts, timeout: options.scriptTimeout || SCRIPT_TIMEOUT_MS }),
                encoding: 'utf8',
                timeout: options.timeout || PROCESS_TIMEOUT_MS,
                killSignal: 'SIGKILL',
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true
            }
        );
    } catch (error) {
        return { ok: true, errors: [] };
    }

    if (!result || result.error || result.status !== 0 || !result.stdout) {
        return { ok: true, errors: [] };
    }

    try {
        const parsed = JSON.parse(result.stdout);
        return { ok: parsed.ok !== false, errors: parsed.errors || [] };
    } catch (error) {
        return { ok: true, errors: [] };
    }
}

function formatRuntimeIssue(error) {
    const name = error && error.name ? error.name : 'Error';
    const message = error && error.message ? error.message : String(error);
    const script = error && error.script ? ` (скрипт #${error.script})` : '';
    if (/timed out/i.test(message)) {
        return 'игра зависает при загрузке' + script + ': ' + message
            + ' — игрок увидит застывшую страницу. Убери бесконечный цикл'
            + ' и вынеси тяжёлое вычисление за пределы кадра.';
    }
    return 'игра падает при загрузке: ' + name + ': ' + message + script
        + ' — игрок увидит пустой экран. Перенеси объявления const/let выше вызовов функций,'
        + ' проверь порядок инициализации и добавь защиту от отсутствующих элементов.';
}

module.exports = { checkRuntimeErrors, extractScripts, extractScriptBlocks, formatRuntimeIssue };
