const gemini = require('./gemini');

const PATCH_SYSTEM = {
    parts: [{
        text: [
            'Ты — точечный патчер HTML5 Canvas-игр.',
            'Тебе дают фрагменты кода с проблемами. Ты возвращаешь ТОЛЬКО валидный JSON без markdown и пояснений.',
            'Схема ответа:',
            '{ "edits": [ { "find": "дословный фрагмент кода, который нужно заменить", "replace": "исправленный фрагмент" } ] }',
            'Правила:',
            '- find — ТОЧНАЯ копия фрагмента из присланного кода (до 80 строк), вместе с отступами.',
            '- replace — полная замена этого фрагмента.',
            '- Не трогай ничего кроме перечисленных проблем.',
            '- Если фрагмент не найден в коде — не включай его в ответ.',
            '- Никаких markdown-блоков, комментариев и пояснений вне JSON.'
        ].join('\n')
    }]
};

const POLISH_SYSTEM = {
    parts: [{
        text: [
            'Ты — арт-директор и геймдизайнер браузерных HTML5 Canvas-игр.',
            'Ты получаешь рабочую игру и список замечаний. Верни ПОЛНЫЙ файл от <!DOCTYPE html> до </html>.',
            'Только код: без markdown, пояснений и комментариев.',
            'Правила:',
            '1. Сохрани механику, управление и все состояния (Меню → Игра → Пауза → Game Over → Рестарт).',
            '2. Улучшай ровно то, что указано в замечаниях, и не ломай остальное.',
            '3. Никаких внешних ресурсов, localStorage, YaGames, i18n и HTML-элементов <button>.',
            '4. Не добавляй картинки, шрифты и аудио по URL — только процедурная графика на canvas.',
            '5. Держи 60 FPS на телефоне: не создавай градиенты и объекты в цикле отрисовки, ограничивай частицы.'
        ].join('\n')
    }]
};

function compactWithMap(code) {
    let compact = '';
    const map = [];
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (/\s/.test(ch)) continue;
        compact += ch;
        map.push(i);
    }
    return { compact, map };
}

function locateSnippet(code, snippet, compactCache) {
    const direct = code.indexOf(snippet);
    if (direct !== -1) return { start: direct, end: direct + snippet.length };

    const compactNeedle = snippet.replace(/\s+/g, '');
    if (!compactNeedle) return null;
    const cache = compactCache || (compactCache = compactWithMap(code));
    const index = cache.compact.indexOf(compactNeedle);
    if (index === -1) return null;
    const start = cache.map[index];
    const lastMapIndex = index + compactNeedle.length - 1;
    const end = (cache.map[lastMapIndex] ?? code.length) + 1;
    return { start, end };
}

function applyEdits(code, edits) {
    let current = String(code || '');
    const applied = [];
    const failed = [];
    const compactCache = { compact: '', map: [] };
    for (const edit of Array.isArray(edits) ? edits : []) {
        if (!edit || typeof edit !== 'object') {
            failed.push({ find: '', reason: 'правка не является объектом' });
            continue;
        }
        const find = typeof edit.find === 'string' ? edit.find : '';
        const replace = typeof edit.replace === 'string' ? edit.replace : '';
        if (!find.trim()) {
            failed.push({ find, reason: 'пустой find' });
            continue;
        }
        const position = locateSnippet(current, find, compactCache);
        if (!position) {
            failed.push({ find: find.slice(0, 120), reason: 'фрагмент не найден' });
            continue;
        }
        current = current.slice(0, position.start) + replace + current.slice(position.end);
        applied.push({ find: find.slice(0, 120), bytes: replace.length });
    }
    return { code: current, applied, failed };
}

function buildPatchPrompt(code, issues, options = {}) {
    const list = (Array.isArray(issues) ? issues : []).map((issue, index) => {
        const level = issue.level === 'critical' ? '[КРИТИЧНО]' : '[важно]';
        return `${index + 1}. ${level} ${issue.msg}`;
    }).join('\n');
    return [
        'Ниже — HTML5 Canvas-игра. Нужно исправить перечисленные проблемы.',
        list,
        '',
        'Верни JSON с правками. Для каждой правки укажи ДОСЛОВНЫЙ фрагмент из кода ниже в find и полную замену в replace.',
        'Если проблему лучше решить переписыванием небольшой функции — вставь всю функцию целиком в find.',
        'Платформа: ' + (options.platform === 'mobile' ? 'телефон (touch)' : 'ПК'),
        '',
        'КОД ИГРЫ:',
        String(code || '')
    ].join('\n');
}

async function requestPatch(code, issues, options = {}) {
    const result = await gemini.generateJson({
        systemInstruction: PATCH_SYSTEM,
        contents: [{ role: 'user', parts: [{ text: buildPatchPrompt(code, issues, options) }] }],
        generationConfig: { temperature: 0.2, topK: 32, topP: 0.9, maxOutputTokens: 8000 },
        timeout: options.timeout || 180000
    });
    const edits = result.data && Array.isArray(result.data.edits) ? result.data.edits : [];
    return { edits, usage: result.usage, model: result.model };
}

async function patchGameCode(code, issues, options = {}) {
    const { edits, usage, model } = await requestPatch(code, issues, options);
    if (!edits.length) return { code, patched: false, applied: [], failed: [], usage, model };
    const outcome = applyEdits(code, edits);
    if (!outcome.applied.length) return { code, patched: false, applied: [], failed: outcome.failed, usage, model };
    return { code: outcome.code, patched: true, applied: outcome.applied, failed: outcome.failed, usage, model };
}

function buildPolishPrompt(code, critic, options = {}) {
    const issues = (critic && Array.isArray(critic.issues) ? critic.issues : [])
        .filter((issue) => issue.level === 'critical' || issue.level === 'warning' || issue.level === 'polish')
        .map((issue, index) => {
            const level = issue.level === 'critical' ? '[КРИТИЧНО]' : issue.level === 'warning' ? '[важно]' : '[можно улучшить]';
            const fix = issue.fix ? ` Решение: ${issue.fix}` : '';
            return `${index + 1}. ${level} ${issue.msg}.${fix}`;
        }).join('\n');
    return [
        'Игра уже работает, но её можно сделать заметно лучше. Ниже — список замечаний от строгого критика.',
        issues || '(замечаний нет)',
        '',
        critic && critic.verdict ? 'Общее впечатление критика: ' + critic.verdict : '',
        '',
        'Требования:',
        '- Верни ПОЛНЫЙ файл от <!DOCTYPE html> до </html>, только код.',
        '- Улучши художественный уровень: выразительные силуэты вместо квадратов, 2-3 слоя у объектов, свет и тени, согласованная палитра, читаемый HUD.',
        '- Усиль глубину: прогрессия, 3 типа врагов, улучшения, финальная цель.',
        '- Не ломай управление и состояния, не добавляй внешние ресурсы.',
        '- 60 FPS на телефоне: кэшируй спрайты, ограничивай частицы, не создавай градиенты в цикле.',
        options.keepBackground === false
            ? '- Сохрани текущий фон страницы, плейсхолдер {{AI_BG_IMAGE}} не используй.'
            : "- В CSS тела оставь дословно: background: url('{{AI_BG_IMAGE}}') center/cover no-repeat; и перед </html> добавь строку [BG: два-три англ слова для фона].",
        '',
        'КОД ИГРЫ:',
        String(code || '')
    ].join('\n');
}

async function polishGameCode(code, critic, options = {}) {
    const result = await gemini.generate({
        systemInstruction: POLISH_SYSTEM,
        contents: [{ role: 'user', parts: [{ text: buildPolishPrompt(code, critic, options) }] }],
        generationConfig: { temperature: 0.5, topK: 40, topP: 0.95, maxOutputTokens: 65536 },
        timeout: options.timeout || 300000
    });
    return {
        code: gemini.stripCodeMarkers(result.text),
        usage: result.usage,
        model: result.model,
        fallbackUsed: result.fallbackUsed
    };
}

module.exports = {
    PATCH_SYSTEM,
    POLISH_SYSTEM,
    applyEdits,
    buildPatchPrompt,
    buildPolishPrompt,
    requestPatch,
    patchGameCode,
    polishGameCode
};
