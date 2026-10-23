const gemini = require('./gemini');

const REVIEW_SYSTEM = {
    parts: [{
        text: [
            'Ты — строгий арт-директор и тех-критик браузерных HTML5-игр.',
            'Твоя задача — оценить качество игры и вернуть ТОЛЬКО валидный JSON без markdown и пояснений.',
            'Схема ответа:',
            '{',
            '  "score": 0-100,',
            '  "criteria": { "objects": 0-100, "background": 0-100, "decor": 0-100, "contrast": 0-100, "hud": 0-100, "palette": 0-100, "effects": 0-100 },',
            '  "verdict": "одно предложение: главная проблема или почему игра хороша",',
            '  "issues": [',
            '    { "code": "snake_case_код", "level": "critical|warning|polish", "msg": "что не так, конкретно", "fix": "что именно исправить в коде" }',
            '  ],',
            '  "strengths": ["что уже хорошо"]',
            '}',
            'Уровни: critical — игра сломана или выглядит как примитивы; warning — заметно хуже нормы; polish — можно улучшить.',
            'Ты строгий: отсутствие в коде признаков качества = отсутствие качества. Не ставь 90+ игре, где графика собрана из примитивов.',
            'Оцени каждый критерий ОТДЕЛЬНО и строго, по коду: objects (слои у объектов, силуэты), background (слои фона, градиент, параллакс), decor (декор, дальний план), contrast (читаемость силуэтов), hud (подписи не наезжают, помещаются в строку), palette (4-6 цветов с акцентом), effects (частицы, тени, следы, блики).',
            'Признака в коде нет — критерий низкий: объекты из прямоугольников 30-45, пустой однотонный фон 30-45, нет декора и теней 30-45. Не ставь критерию 80, если признака нет.',
            'Итоговый score = среднее по критериям (округлённое), и не выше 70, если хотя бы два критерия ниже 50.',
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
    lines.push('ЭКРАН НЕ ПОКАЗАН — суди о графике только по коду: отсутствие признака = отсутствие качества.');
    lines.push('');
    lines.push('ЧТО ПРОВЕРЯТЬ:');
    lines.push('1. Художественный уровень: не примитивные пиксели и квадраты, а читаемые силуэты, 2-3 геометрических слоя у объектов, согласованная палитра, параллакс, частицы, акценты.');
    lines.push('2. Соответствие замыслу: игра реально про то, что просил пользователь, а не про generic-аркаду.');
    lines.push('3. Глубина: прогрессия (волны/уровни), минимум 3 типа врагов/препятствий, улучшения, понятные победа/поражение.');
    lines.push('4. UX: крупная кнопка старта, управление без внешней инструкции, пауза, Game Over со счётом и рестарт.');
    lines.push('5. Производительность на телефоне: нет градиентов и тяжёлых объектов в цикле, частицы ограничены, есть delta time, кэширование спрайтов.');
    lines.push('6. Техническая целостность: одна система координат, нет переприсваивания const, старт реально нажимается.');
    lines.push('');
    lines.push('7. ВИЗУАЛЬНЫЙ ЧЕК-ЛИСТ (главный критерий, проверь по коду):');
    lines.push('- Объекты: у игрока, врагов и наград минимум 2 слоя (тень, корпус, блик) и тёмная обводка; силуэт не прямоугольник. Квадраты вместо персонажей — −30 к оценке.');
    lines.push('- Фон: минимум 2 слоя (градиент или небо + дальние силуэты) с параллаксом. Однотонный пустой фон — −20.');
    lines.push('- Декор: нет ни звёзд, ни облаков, ни дыма, ни пыли, ни дальнего плана — −15.');
    lines.push('- Контраст: силуэты игрока и врагов должны читаться на фоне, у них тёмная обводка.');
    lines.push('- HUD: подписи не наезжают друг на друга, не переносятся на вторую строку (метка и число в одной строке) и не закрывают игровое поле на 390 px. Наложение подписей — critical и −20.');
    lines.push('- Палитра: 4-6 цветов с акцентом против фона, а не 2 серых тона.');
    lines.push('- Эффекты: нет следа, частиц, теней, бликов — −10.');
    lines.push('');
    lines.push('ОРИЕНТИРЫ ИТОГОВОЙ ОЦЕНКИ: примитивы из прямоугольников и пустой фон — не выше 50; бедная графика без деталей — не выше 65; графика с деталями, слоями и эффектами — 85-100.');
    lines.push('');
    lines.push('ОЦЕНИ КАЖДЫЙ КРИТЕРИЙ ОТДЕЛЬНО (верни в JSON в поле criteria): objects, background, decor, contrast, hud, palette, effects — от 0 до 100.');
    lines.push('Признака в коде нет — критерий низкий: объекты из прямоугольников 30-45, пустой однотонный фон 30-45, нет декора/теней/следов 30-45, подписи в строку не помещаются 30-45.');
    lines.push('Итоговый score считай как среднее по критериям; если хотя бы два критерия ниже 50 — итог не выше 70.');

    const visualIssues = options.visualAudit && Array.isArray(options.visualAudit.issues) ? options.visualAudit.issues : [];
    if (visualIssues.length) {
        lines.push('');
        lines.push('АВТОМАТИЧЕСКИЙ АУДИТ ГРАФИКИ ПО КОДУ (найдено без модели, учти в оценке):');
        for (const issue of visualIssues) lines.push('- ' + issue.msg);
    }
    return lines.join('\n');
}

function normalizeLevel(level) {
    const value = String(level || '').toLowerCase();
    if (value === 'critical' || value === 'blocker') return 'critical';
    if (value === 'warning' || value === 'warn' || value === 'important') return 'warning';
    return 'polish';
}

const CRITERIA_KEYS = ['objects', 'background', 'decor', 'contrast', 'hud', 'palette', 'effects'];

function normalizeCriteria(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const criteria = {};
    for (const key of CRITERIA_KEYS) {
        const value = Number(source[key]);
        if (!Number.isFinite(value)) continue;
        criteria[key] = Math.max(0, Math.min(100, Math.round(value)));
    }
    const values = Object.values(criteria);
    if (values.length < 3) return { criteria, rubricScore: null };
    const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    const weak = values.filter((value) => value < 50).length;
    return {
        criteria,
        rubricScore: weak >= 2 ? Math.min(average, 70) : average
    };
}

function normalizeCritic(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
    const { criteria, rubricScore } = normalizeCriteria(data.criteria);
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
        criteria,
        rubricScore,
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
            criteria: {},
            rubricScore: null,
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
            rubricScore: null,
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

// Оценка визуала без модели: по тем же критериям рубрики, но по признакам в коде.
// Нужна, чтобы квота Gemini не превращалась в «игру отправят без визуального вердикта».
function localCriteria(visual, technical) {
    const features = (visual && visual.features) || {};
    const issues = (technical && technical.issues) || [];
    const hudBroken = issues.some((issue) => /hud|dpr/i.test(String(issue.code || '')));
    const palette = Number(features.palette) || 0;
    let objects = 35;
    if (features.shapes && (features.gradient || features.images)) objects = 85;
    else if (features.shapes) objects = 78;
    else if (features.images) objects = 72;
    else if (features.gradient) objects = 58;

    let background = 30;
    if (features.gradient && features.layers) background = 90;
    else if ((features.gradient || features.images) && features.layers) background = 82;
    else if (features.gradient) background = 70;
    else if (features.layers) background = 68;
    else if (features.images) background = 60;

    let decor = 32;
    if (features.layers && features.particles) decor = 80;
    else if (features.layers) decor = 72;
    else if (features.particles) decor = 62;

    let contrast = 38;
    if (features.shadows && palette >= 4) contrast = 80;
    else if (features.shadows) contrast = 68;
    else if (palette >= 4) contrast = 58;

    let paletteScore = 30;
    if (palette >= 6) paletteScore = 80;
    else if (palette >= 4) paletteScore = 75;
    else if (palette === 3) paletteScore = 48;

    const signals = [features.particles, features.shadows, features.animation].filter(Boolean).length;
    let effects = 28;
    if (signals >= 3) effects = 90;
    else if (signals === 2) effects = 75;
    else if (signals === 1) effects = 52;

    return {
        objects,
        background,
        decor,
        contrast,
        // Раскладку HUD по коду не проверить — признака нет, значит и балла нет.
        // Так в промпт полиша попадает подсказка про одну строку на 390 px.
        hud: hudBroken ? 35 : 55,
        palette: paletteScore,
        effects
    };
}

function localCritic(visual, technical) {
    const { criteria, rubricScore } = normalizeCriteria(localCriteria(visual, technical));
    const auditScore = Number(visual && visual.score);
    const raw = Number.isFinite(auditScore) ? Math.min(auditScore, rubricScore ?? auditScore) : (rubricScore ?? 50);
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    const issues = ((visual && visual.issues) || []).map((issue) => ({
        code: String(issue.code || 'visual_quality').slice(0, 40),
        level: 'warning',
        msg: String(issue.msg || '').slice(0, 400),
        fix: String(issue.fix || '').slice(0, 600)
    }));
    return {
        score,
        criteria,
        rubricScore,
        verdict: 'Визуальная оценка по автоматическому аудиту кода: модель-критик недоступна',
        issues,
        strengths: [],
        noVerdict: false,
        reason: 'local_audit',
        model: null,
        usage: { inputTokens: 0, outputTokens: 0 }
    };
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

function judgeChain(excludeModel) {
    const models = gemini.judgeModels(excludeModel);
    if (!models.length) {
        const error = new Error('Нет доступной модели-критика: квота исчерпана или доступна только модель-автор');
        error.criticUnavailable = true;
        throw error;
    }
    return models;
}

async function runReview(options = {}) {
    const prompt = buildReviewPrompt(options);
    const contents = buildContents(prompt, options.imageBuffer);
    const result = await gemini.generateJson({
        systemInstruction: REVIEW_SYSTEM,
        contents,
        generationConfig: { temperature: 0.3, topK: 32, topP: 0.9, maxOutputTokens: 8192 },
        models: judgeChain(options.excludeModel),
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
        models: judgeChain(options.excludeModel),
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
    try {
        return await runReview({ ...options, imageBuffer });
    } catch (error) {
        // В оценщике стенда допустим модель-автора: без независимой модели измерение невозможно,
        // а вердикт помечается, чтобы понимать, что оценка неравноценна.
        if (!error.criticUnavailable) throw error;
        const models = gemini.criticModels(options.excludeModel);
        if (!models.length) throw error;
        const result = await gemini.generateJson({
            systemInstruction: REVIEW_SYSTEM,
            contents: buildContents(prompt, imageBuffer),
            generationConfig: { temperature: 0.3, topK: 32, topP: 0.9, maxOutputTokens: 8192 },
            models,
            timeout: options.timeout || 120000
        });
        return buildCriticResult(result.data, { model: result.model, usage: result.usage, selfReview: true });
    }
}

module.exports = {
    REVIEW_SYSTEM,
    buildReviewPrompt,
    normalizeCritic,
    normalizeCriteria,
    buildCriticResult,
    criticToIssues,
    localCritic,
    localCriteria,
    reviewCode,
    reviewScreenshot
};
