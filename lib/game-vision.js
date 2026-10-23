const gemini = require('./gemini');

const REVIEW_SYSTEM = {
    parts: [{
        text: [
            'Ты — строгий арт-директор и тех-критик браузерных HTML5-игр.',
            'Твоя задача — оценить качество игры и вернуть ТОЛЬКО валидный JSON без markdown и пояснений.',
            'Схема ответа:',
            '{',
            '  "score": 0-100,',
            '  "verdict": "одно предложение: главная проблема или почему игра хороша",',
            '  "issues": [',
            '    { "code": "snake_case_код", "level": "critical|warning|polish", "msg": "что не так, конкретно", "fix": "что именно исправить в коде" }',
            '  ],',
            '  "strengths": ["что уже хорошо"]',
            '}',
            'Уровни: critical — игра сломана или выглядит как примитивы; warning — заметно хуже нормы; polish — можно улучшить.',
            'Не выдумывай проблемы: если всё хорошо — верни score 90-100 и пустой issues.'
        ].join('\n')
    }]
};

function buildReviewPrompt(options = {}) {
    const lines = [];
    if (options.brief) {
        lines.push('ЗАМЫСЕЛ ИГРЫ:', String(options.brief).slice(0, 2500));
    }
    if (options.plan) {
        lines.push('ПЛАН ИГРЫ:', String(options.plan).slice(0, 2000));
    }
    lines.push('ПЛАТФОРМА:', options.platform === 'mobile' ? 'телефон (touch, экран 390×844)' : 'ПК (мышь/клавиатура)');
    lines.push('');
    lines.push('ЧТО ПРОВЕРЯТЬ:');
    lines.push('1. Художественный уровень: не примитивные пиксели и квадраты, а читаемые силуэты, 2-3 геометрических слоя у объектов, согласованная палитра, параллакс, частицы, акценты.');
    lines.push('2. Соответствие замыслу: игра реально про то, что просил пользователь, а не про generic-аркаду.');
    lines.push('3. Глубина: прогрессия (волны/уровни), минимум 3 типа врагов/препятствий, улучшения, понятные победа/поражение.');
    lines.push('4. UX: крупная кнопка старта, управление без внешней инструкции, пауза, Game Over со счётом и рестарт.');
    lines.push('5. Производительность на телефоне: нет градиентов и тяжёлых объектов в цикле, частицы ограничены, есть delta time, кэширование спрайтов.');
    lines.push('6. Техническая целостность: одна система координат, нет переприсваивания const, старт реально нажимается.');
    return lines.join('\n');
}

function normalizeLevel(level) {
    const value = String(level || '').toLowerCase();
    if (value === 'critical' || value === 'blocker') return 'critical';
    if (value === 'warning' || value === 'warn' || value === 'important') return 'warning';
    return 'polish';
}

function normalizeCritic(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
    const issues = [];
    for (const item of Array.isArray(data.issues) ? data.issues : []) {
        if (!item || typeof item !== 'object') continue;
        const msg = String(item.msg || item.message || '').trim();
        if (!msg) continue;
        issues.push({
            code: String(item.code || 'visual_quality').slice(0, 40),
            level: normalizeLevel(item.level),
            msg: msg.slice(0, 400),
            fix: String(item.fix || '').trim().slice(0, 600)
        });
    }
    return {
        score,
        verdict: String(data.verdict || '').trim().slice(0, 300),
        issues: issues.slice(0, 12),
        strengths: (Array.isArray(data.strengths) ? data.strengths : []).map((item) => String(item).slice(0, 160)).slice(0, 6)
    };
}

function buildCriticResult(data, meta = {}) {
    const isObject = data && typeof data === 'object' && !Array.isArray(data);
    if (!isObject) {
        return {
            score: null,
            verdict: 'Критик не дал оценки: ответ не удалось разобрать как JSON',
            issues: [],
            strengths: [],
            noVerdict: true,
            reason: 'json_unparsed',
            ...meta
        };
    }
    if (data.score === undefined || data.score === null) {
        return {
            ...normalizeCritic(data),
            score: null,
            verdict: 'Критик не дал оценки: в ответе нет поля score',
            issues: [],
            noVerdict: true,
            reason: 'no_score',
            ...meta
        };
    }
    return { ...normalizeCritic(data), noVerdict: false, reason: null, ...meta };
}

function criticToIssues(critic) {
    return (critic && critic.issues ? critic.issues : [])
        .filter((issue) => issue.level === 'critical' || issue.level === 'warning')
        .map((issue) => ({
            level: issue.level,
            code: issue.code,
            msg: `${issue.msg}${issue.fix ? ' — исправление: ' + issue.fix : ''}`
        }));
}

function buildContents(prompt, imageBuffer) {
    const parts = [];
    if (imageBuffer) {
        parts.push({
            inline_data: {
                mime_type: 'image/png',
                data: Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : String(imageBuffer)
            }
        });
    }
    parts.push({ text: prompt });
    return [{ role: 'user', parts }];
}

async function runReview(options = {}) {
    const prompt = buildReviewPrompt(options);
    const contents = buildContents(prompt, options.imageBuffer);
    const result = await gemini.generateJson({
        systemInstruction: REVIEW_SYSTEM,
        contents,
        generationConfig: { temperature: 0.3, topK: 32, topP: 0.9, maxOutputTokens: 8192 },
        timeout: options.timeout || 120000
    });
    return buildCriticResult(result.data, { model: result.model, usage: result.usage });
}

async function reviewCode(code, options = {}) {
    const prompt = [
        buildReviewPrompt(options),
        '',
        'КОД ИГРЫ (оцени по коду, экран не показан):',
        String(code || '').slice(0, 60000)
    ].join('\n');
    const result = await gemini.generateJson({
        systemInstruction: REVIEW_SYSTEM,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, topK: 32, topP: 0.9, maxOutputTokens: 8192 },
        timeout: options.timeout || 120000
    });
    return buildCriticResult(result.data, { model: result.model, usage: result.usage });
}

async function reviewScreenshot(imageBuffer, options = {}) {
    const prompt = [
        'Это скриншот игры на телефоне (390×844). Оцени ИГРУ ПО КАРТИНКЕ.',
        'Что смотреть: читается ли HUD, видно ли главного героя и врагов, выглядят ли объекты как выразительные силуэты или как серые квадраты, есть ли глубина фона, не наезжают ли тексты на игровое поле.',
        '',
        buildReviewPrompt(options)
    ].join('\n');
    return runReview({ ...options, imageBuffer });
}

module.exports = {
    REVIEW_SYSTEM,
    buildReviewPrompt,
    normalizeCritic,
    buildCriticResult,
    criticToIssues,
    reviewCode,
    reviewScreenshot
};
