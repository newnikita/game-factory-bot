require('dotenv').config({ quiet: true });
const { Telegraf, session, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const express = require('express');
const fse = require('fs-extra');
const axios = require('axios');
const vm = require('vm');

const {
    initDb,
    closeDb,
    getUser: findUser,
    ensureUser,
    debit,
    credit,
    attachReferral,
    qualifyReferral,
    recordPayment,
    getPaymentByChargeId,
    markPaymentRefunded,
    recordGeneration,
    recordGame,
    getGame,
    createComplaint,
    getComplaint,
    listOpenComplaints,
    hideGame,
    restoreGame,
    dismissComplaint,
    logEvent,
    getStats,
    getQualityStats,
    rateGame,
    getGameRating,
    getRatingStats,
    importLegacyUsers
} = require('./lib/db');
const {
    escapeHtml,
    sanitizeText,
    sanitizeGameTitle,
    safeFilename,
    sanitizeBgFilename,
    sanitizePlatform,
    sanitizeEngine,
    sanitizeBiome,
    safeHttpsUrl,
    safeCssUrl,
    isSafeGameId,
    validatePrompt,
    tryConsumeRateLimit
} = require('./lib/security');
const { COST_PER_GAME, PLANS, getPlan, gamesGranted, gamesFromBalance, gamesLabel } = require('./lib/plans');
const { buildDesignBrief, buildRatingFeedback, detectGenre } = require('./lib/game-design');
const { auditGame } = require('./lib/game-quality');
const { patchGameCode, polishGameCode } = require('./lib/game-patch');
const { reviewCode, criticToIssues } = require('./lib/game-vision');
const hybrid = require('./lib/hybrid');
const gemini = require('./lib/gemini');

function envInt(name, fallback) {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const START_FREE_GAMES = envInt('START_FREE_GAMES', 2);
const REWARD_PER_REF = COST_PER_GAME * 2;
const MAX_GENERATIONS_PER_DAY = envInt('MAX_GENERATIONS_PER_DAY', 20);
const GENERATION_COOLDOWN_MS = envInt('GENERATION_COOLDOWN_MS', 30000);
const ADMIN_IDS = String(process.env.ADMIN_IDS || process.env.ADMIN_ID || '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
const WEBAPP_URL = String(process.env.WEBAPP_URL || '').replace(/\/+$/, '');
const GAMES_PUBLIC_URL = String(process.env.GAMES_PUBLIC_URL || WEBAPP_URL).replace(/\/+$/, '');
const MAX_DEVICE_PIXEL_RATIO = Math.min(Math.max(Number(process.env.MAX_DEVICE_PIXEL_RATIO) || 2, 1), 3);
const PROMPT_VERSION = 'v4-quality-pipeline';
const QUALITY_CRITIC_ENABLED = String(process.env.QUALITY_CRITIC_ENABLED || 'true') === 'true';
const QUALITY_CRITIC_MIN_SCORE = Math.max(40, Math.min(100, Number(process.env.QUALITY_CRITIC_MIN_SCORE) || 80));
const QUALITY_POLISH_ENABLED = String(process.env.QUALITY_POLISH_ENABLED || 'true') === 'true';
const ALLOW_UNMODERATED_IMAGE_UPLOADS = String(process.env.ALLOW_UNMODERATED_IMAGE_UPLOADS || 'false') === 'true';

process.on('uncaughtException', (err) => console.error('❌ Неперехваченная ошибка:', err.stack || err.message));
process.on('unhandledRejection', (err) => console.error('❌ Необработанная ошибка:', (err && err.stack) || err));

function getUser(id) {
    return ensureUser(id);
}

function tgUser(ctx) {
    return ensureUser(ctx.from.id, {
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        language: ctx.from.language_code
    });
}

function userGames(user) {
    return gamesFromBalance(user.balance);
}

function isAdmin(id) {
    return ADMIN_IDS.includes(Number(id));
}

async function notifyAdmins(text) {
    if (!ADMIN_IDS.length) return;
    try {
        await bot.telegram.sendMessage(ADMIN_IDS[0], text);
    } catch (error) {
        // Админ мог не начать диалог с ботом.
    }
}

function escapeHtmlText(value) {
    return escapeHtml(value);
}

const bot = new Telegraf(process.env.BOT_TOKEN || '0:test');
bot.use(session());

bot.use((ctx, next) => {
    if (!ctx.session) ctx.session = {};
    if (!ctx.session.gameData) ctx.session.gameData = {};
    return next();
});

const styles = {
    'silent_stars': {
        name: 'Немые Звезды', bg: '#050510', block: '#E0E0FF',
        img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1080&auto=format&fit=crop',
        font: '"Courier New", monospace', shadow: '0 0 15px rgba(224, 224, 255, 0.5)',
        life: '💠', score: '☄️', b_wide: '🌌', b_triple: '✨', b_fire: '🌠', b_lightning: '🌩️'
    },
    'credo_fantasy': {
        name: 'Темное Фэнтези', bg: '#110000', block: '#8B0000',
        img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop',
        font: '"Palatino Linotype", "Book Antiqua", serif', shadow: '0 0 20px rgba(139, 0, 0, 0.8)',
        life: '🩸', score: '💀', b_wide: '📜', b_triple: '🔮', b_fire: '🔥', b_lightning: '🗡️'
    },
    'ghibli_forest': {
        name: 'Волшебный Лес', bg: '#1E3B27', block: '#A8E6CF',
        img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1080&auto=format&fit=crop',
        font: '"Comic Sans MS", cursive, sans-serif', shadow: '2px 2px 5px rgba(0, 0, 0, 0.3)',
        life: '🌸', score: '🍃', b_wide: '🍄', b_triple: '✨', b_fire: '☀️', b_lightning: '🌩️'
    },
    'neon_tokyo': {
        name: 'Неоновый Токио', bg: '#090014', block: '#FF00FF',
        img: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?q=80&w=1080&auto=format&fit=crop',
        font: '"Trebuchet MS", sans-serif', shadow: '0 0 10px #00FFFF, 0 0 20px #FF00FF',
        life: '🔋', score: '💿', b_wide: '🛹', b_triple: '💠', b_fire: '💥', b_lightning: '⚡'
    },
    'wasteland': {
        name: 'Ржавая Пустошь', bg: '#2B1D14', block: '#D2691E',
        img: 'https://images.unsplash.com/photo-1508361001413-7a9dca21d08a?q=80&w=1080&auto=format&fit=crop',
        font: '"Impact", charcoal, sans-serif', shadow: '4px 4px 0px rgba(0, 0, 0, 0.8)',
        life: '⚙️', score: '🔩', b_wide: '🛡️', b_triple: '☢️', b_fire: '🔥', b_lightning: '⚡'
    }
};

async function checkImageSafety(imageUrl) {
    if (ALLOW_UNMODERATED_IMAGE_UPLOADS) return true;
    if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) {
        console.error('[Модерация] SIGHT_USER/SIGHT_SECRET не заданы: загрузка изображений отключена');
        return false;
    }
    try {
        const response = await axios.get('https://api.sightengine.com/1.0/check.json', {
            params: {
                url: imageUrl,
                models: 'nudity-2.0',
                api_user: process.env.SIGHT_USER,
                api_secret: process.env.SIGHT_SECRET
            },
            timeout: 15000
        });
        if (!response.data || response.data.status !== 'success' || !response.data.nudity) return false;
        return Number(response.data.nudity.none) >= 0.8;
    } catch (e) {
        console.error('[Модерация] Не удалось проверить изображение:', e.message);
        return false;
    }
}

function selectReferenceEngine(prompt) {
    const text = prompt.toLowerCase();
    const pWords = ['прыг', 'скач', 'платформ', 'беж', 'паркур', 'гравитац', 'вверх', 'уворачива', 'вниз'];
    const sWords = ['шутер', 'стреля', 'выживан', 'оружие', 'пул', 'зомб', 'арена', 'отстрел', 'убива', 'враг'];
    
    if (sWords.some(w => text.includes(w))) return 'shooter.html';
    if (pWords.some(w => text.includes(w))) return 'platformer.html';
    return 'breaker.html';
}

const CONTROLS_MOBILE = "▶ УПРАВЛЕНИЕ ДЛЯ МОБИЛЬНЫХ: ИСКЛЮЧИТЕЛЬНО touch-события (или pointer-события). ЗАПРЕЩЕНЫ мышь и клавиатура. ЗАПРЕЩЕНЫ HTML-кнопки. Используй e.preventDefault().";
const CONTROLS_PC = "▶ УПРАВЛЕНИЕ ДЛЯ ПК: Стандартное управление с клавиатуры или клики мышью. ЗАПРЕЩЕНЫ touch-события.";
const MOBILE_PERFORMANCE = [
    '▶ ПРОИЗВОДИТЕЛЬНОСТЬ НА ТЕЛЕФОНЕ (КРИТИЧНО):',
    '- Целевой FPS — 60. Бюджет кадра маленький: никаких сотен gradient/fill вызовов.',
    '- Ограничь devicePixelRatio: const dpr = Math.min(window.devicePixelRatio || 1, 2);',
    '- Не создавай createLinearGradient/createRadialGradient внутри цикла отрисовки для каждого объекта. Создай градиент один раз или нарисуй объект в offscreen-canvas и переиспользуй через drawImage.',
    '- shadowBlur — максимум для 1–2 объектов на кадр; для остальных используй заранее нарисованные спрайты свечения.',
    '- Частиц не больше 80, врагов и снарядов — не больше 40 одновременно. Переиспользуй массивы и удаляй элементы на месте.',
    '- Запрещены ctx.filter, тяжёлые globalCompositeOperation и создание новых массивов в каждом кадре.',
    '- Используй delta time с ограничением: dt = Math.min(dt, 1 / 30).'
].join('\n');
const DESKTOP_PERFORMANCE = [
    '▶ ПРОИЗВОДИТЕЛЬНОСТЬ:',
    '- Создавай градиенты и спрайты один раз, а не в каждом кадре.',
    '- Повторяющиеся объекты рисуй через offscreen-canvas и drawImage.',
    '- Ограничь количество частиц и врагов разумным бюджетом.',
    '- Используй delta time с ограничением: dt = Math.min(dt, 1 / 30).'
].join('\n');

const GEMINI_INPUT_PRICE_PER_M = Number(process.env.GEMINI_INPUT_PRICE_PER_M || 0.30);
const GEMINI_OUTPUT_PRICE_PER_M = Number(process.env.GEMINI_OUTPUT_PRICE_PER_M || 2.50);

function estimateCostUsd(inputTokens, outputTokens) {
    const input = (Number(inputTokens) || 0) / 1_000_000 * GEMINI_INPUT_PRICE_PER_M;
    const output = (Number(outputTokens) || 0) / 1_000_000 * GEMINI_OUTPUT_PRICE_PER_M;
    return Math.round((input + output) * 1_000_000) / 1_000_000;
}

const SAFETY_THRESHOLD = process.env.GEMINI_SAFETY_THRESHOLD || 'BLOCK_MEDIUM_AND_ABOVE';
const SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: SAFETY_THRESHOLD },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: SAFETY_THRESHOLD },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: SAFETY_THRESHOLD },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: process.env.GEMINI_DANGEROUS_THRESHOLD || 'BLOCK_ONLY_HIGH' }
];

const SYSTEM_INSTRUCTION = {
    parts: [{
        text: [
            "Ты — профессиональный разработчик браузерных игр на HTML5 Canvas.",
            "Отвечай ТОЛЬКО полным кодом одного самодостаточного HTML-файла: от <!DOCTYPE html> до </html>. Запрещены markdown-блоки, пояснения и комментарии в коде.",
            "АБСОЛЮТНЫЕ ПРАВИЛА:",
            "1. Игра запускается мгновенно. Запрещены экраны загрузки, прелоадеры и обращения к элементу loading-screen.",
            "2. Всё в одном файле: CSS в <style>, JS в <script>. Запрещены внешние <script src>, библиотеки, движки, шрифты по ссылкам, картинки и аудиофайлы по URL. Графику рисуй процедурно на Canvas. Не используй примитивные пиксель-арт спрайты и сетки 8×8: персонажи, враги и объекты — выразительные векторные формы (круги, полигоны, скруглённые прямоугольники), градиенты, тени, свечение, частицы и плавная анимация.",
            "3. Запрещены localStorage, Яндекс SDK (YaGames), лидерборды, словари локализаций i18n и HTML-элементы <button>. Меню, кнопки и HUD рисуй на самом canvas либо через div-оверлеи с обработкой ввода по координатам.",
            "4. Обязательные состояния: Меню (старт) → Игра → Пауза → Game Over → Рестарт.",
            "5. Ресайз: обрабатывай изменение размера окна, игра корректно заполняет экран и на ПК, и на телефоне.",
            "6. В CSS тела обязателен дословно этот фон: background: url('{{AI_BG_IMAGE}}') center/cover no-repeat;",
            "7. Перед </html> добавь ровно одну строку вида [BG: два-три англ слова для фона], например [BG: space nebula].",
            "8. Визуальный уровень — как у современной 2D-игры: 2–3 слоя параллакса полупрозрачными силуэтами, частицы (искры, пыль, взрывы), градиенты через createLinearGradient/createRadialGradient, свечение через shadowBlur, screen shake при попаданиях.",
            "9. У игрока, врагов, снарядов и декораций должны быть разные узнаваемые силуэты, цвета и анимация (покачивание, вращение, масштаб). Запрещено рисовать всё одинаковыми квадратами.",
            "10. Производительность: 60 FPS на телефоне. Не создавай градиенты и тяжёлые объекты в цикле отрисовки, кэшируй спрайты в offscreen-canvas, ограничивай частицы и используй delta time.",
            "11. Глубина: не ограничивайся одним бесконечным циклом. Нужны прогрессия (волны/уровни), 3 типа врагов или препятствий, 2–3 улучшения/усилителя, финальная цель или босс и внятная кривая сложности.",
            "12. UX: крупная кнопка старта, одна строка с управлением, пауза, экран Game Over со счётом и кнопкой «Заново». Игрок должен понимать цель без внешней инструкции.",
            "13. Визуальная система: палитра 5–6 цветов, 3 слоя фона с параллаксом, объекты из 2–3 геометрических слоёв с обводкой и бликом, единый HUD. Фото-фон — только подложка, поверх него нужен плотный градиент/силуэты.",
            "14. Технические ловушки: не смешивай CSS-пиксели и backing-пиксели canvas; не присваивай значения переменным const; лимит частиц должен реально соблюдаться в функции спавна; полноэкранный оверлей не должен перекрывать ввод без pointer-events:none.",
            "15. Перед ответом мысленно запусти игру на экране 390×844: старт нажимается, все объекты в кадре, HUD читается, частицы и враги не растут без предела.",
            "16. Первые 1–1.5 секунды после старта игрок должен быть в безопасности: не спавни врагов и препятствия ближе чем за 300 px от игрока и не ставь игрока на путь первого препятствия. Игра не должна закончиться раньше, чем игрок успеет сделать первое осмысленное действие."
        ].join('\n')
    }]
};

const PLAN_INSTRUCTION = {
    parts: [{
        text: [
            "Ты — геймдизайнер браузерных HTML5-игр.",
            "Составь краткий план игры по идее пользователя. Не пиши код.",
            "Формат — ровно 9 строк, без markdown и нумерации:",
            "Жанр: ...",
            "Ядро цикла: ...",
            "Управление: ...",
            "Объекты и враги: 3 типа с разным поведением ...",
            "Правила победы: ...",
            "Правила поражения: ...",
            "Прогрессия и сложность: волны/уровни, улучшения, финальная цель или босс ...",
            "Визуальная система: палитра 5–6 цветов, 3 слоя фона, силуэты объектов, стиль HUD ...",
            "Фишка: ...",
            "Учитывай: один HTML-файл, Canvas, без внешних библиотек и ассетов.",
            "Бюджет: 60 FPS на телефоне, без сотен эффектов и объектов на экране."
        ].join('\n')
    }]
};

const IMPROVE_SYSTEM_INSTRUCTION = {
    parts: [{
        text: [
            "Ты — профессиональный разработчик браузерных игр на HTML5 Canvas.",
            "Отвечай ТОЛЬКО полным кодом одного самодостаточного HTML-файла: от <!DOCTYPE html> до </html>. Запрещены markdown-блоки, пояснения и комментарии в коде.",
            "ПРАВИЛА УЛУЧШЕНИЯ:",
            "1. Сохрани всё, что пользователь не просил менять: управление, механику, визуальный стиль и фон.",
            "2. Игра запускается мгновенно; запрещены экраны загрузки и loading-screen.",
            "3. Всё в одном файле; запрещены внешние библиотеки, шрифты, картинки и аудио.",
            "4. Запрещены localStorage, YaGames, i18n и HTML-элементы <button>.",
            "5. Не используй плейсхолдер {{AI_BG_IMAGE}} и не добавляй строку [BG: ...] — фон уже в коде.",
            "6. Сохрани состояния: Меню → Игра → Пауза → Game Over → Рестарт."
        ].join('\n')
    }]
};

function stripCodeMarkers(text) {
    return gemini.stripCodeMarkers(text);
}

const RATING_FEEDBACK_TTL_MS = 10 * 60 * 1000;
let ratingFeedbackCache = { at: 0, byGenre: null };

function getRatingFeedback(prompt) {
    const now = Date.now();
    if (now - ratingFeedbackCache.at > RATING_FEEDBACK_TTL_MS) {
        let byGenre = null;
        try {
            byGenre = getRatingStats(30).byGenre;
        } catch (error) {
            console.error('[Оценки] Не удалось собрать статистику:', error.message);
        }
        ratingFeedbackCache = { at: now, byGenre };
    }
    if (!ratingFeedbackCache.byGenre) return null;
    return buildRatingFeedback({ byGenre: ratingFeedbackCache.byGenre }, prompt);
}

async function generateGamePlan(userPrompt, platform = 'pc') {
    if (!process.env.GEMINI_API_KEY) return { plan: '', inputTokens: 0, outputTokens: 0 };
    const controlsPrompt = platform === 'mobile' ? CONTROLS_MOBILE : CONTROLS_PC;
    const prompt = [
        'Идея игры: ' + userPrompt,
        'Платформа: ' + (platform === 'mobile' ? 'мобильная' : 'ПК'),
        'Управление: ' + controlsPrompt,
        '',
        buildDesignBrief(userPrompt, platform, { feedback: getRatingFeedback(userPrompt) })
    ].join('\n');
    try {
        const result = await gemini.generate({
            systemInstruction: PLAN_INSTRUCTION,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            safetySettings: SAFETY_SETTINGS,
            generationConfig: { temperature: 0.5, topK: 40, topP: 0.9, maxOutputTokens: 1200 },
            timeout: 60000
        });
        return {
            plan: stripCodeMarkers(result.text).slice(0, 4000),
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            model: result.model,
            fallbackUsed: result.fallbackUsed
        };
    } catch (e) {
        console.error('[План] Не удалось составить план:', e.message);
        return { plan: '', inputTokens: 0, outputTokens: 0 };
    }
}

function findFunctionStart(code, fnName) {
    const esc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = code.match(new RegExp('(?:async\\s+)?function\\s+' + esc + '\\s*\\('));
    return m ? m.index : -1;
}

function findBlockEnd(code, fromIndex) {
    let i = code.indexOf('{', fromIndex);
    if (i === -1) return -1;
    let depth = 0;
    let state = 'code';
    for (; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1];
        if (state === 'code') {
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) return i; }
            else if (ch === "'") state = 's1';
            else if (ch === '"') state = 's2';
            else if (ch === '`') state = 'tpl';
            else if (ch === '/' && next === '/') { state = 'line'; i++; }
            else if (ch === '/' && next === '*') { state = 'block'; i++; }
        } else if (state === 's1') { if (ch === '\\') i++; else if (ch === "'") state = 'code'; }
        else if (state === 's2') { if (ch === '\\') i++; else if (ch === '"') state = 'code'; }
        else if (state === 'tpl') { if (ch === '\\') i++; else if (ch === '`') state = 'code'; }
        else if (state === 'line') { if (ch === '\n') state = 'code'; }
        else if (state === 'block') { if (ch === '*' && next === '/') { state = 'code'; i++; } }
    }
    return -1;
}

function removeFunctionBlock(code, fnName) {
    const start = findFunctionStart(code, fnName);
    if (start === -1) return code;
    const end = findBlockEnd(code, start);
    if (end === -1) return code;
    let tail = end + 1;
    if (code[tail] === ';') tail++;
    return code.slice(0, start) + code.slice(tail);
}

function replaceFunctionBlock(code, fnName, replacement) {
    const start = findFunctionStart(code, fnName);
    if (start === -1) return code;
    const end = findBlockEnd(code, start);
    if (end === -1) return code;
    let tail = end + 1;
    if (code[tail] === ';') tail++;
    return code.slice(0, start) + replacement + code.slice(tail);
}

function sanitizeReference(raw) {
    let code = raw;
    const s = styles.silent_stars;

    code = code
        .replace(/\{\{GAME_TITLE\}\}/g, 'Эталонная Игра')
        .replace(/\{\{BG_IMAGE\}\}/g, s.img)
        .replace(/\{\{BG_COLOR\}\}/g, s.bg)
        .replace(/\{\{BLOCK_COLOR\}\}/g, s.block)
        .replace(/\{\{FONT_FAMILY\}\}/g, s.font)
        .replace(/\{\{SHADOW\}\}/g, s.shadow)
        .replace(/\{\{LIFE_ICON\}\}/g, s.life)
        .replace(/\{\{SCORE_ICON\}\}/g, s.score)
        .replace(/\{\{BOOSTER_WIDE\}\}/g, s.b_wide)
        .replace(/\{\{BOOSTER_TRIPLE\}\}/g, s.b_triple)
        .replace(/\{\{BOOSTER_FIRE\}\}/g, s.b_fire)
        .replace(/\{\{BOOSTER_LIGHTNING\}\}/g, s.b_lightning)
        .replace(/\{\{PLATFORM\}\}/g, 'pc');

    code = code.replace(/<div[^>]*id=["']loading-screen["'][^>]*>[\s\S]*?<\/div>/i, '');
    code = code.replace(/#loading-screen\s*\{[^}]*\}/gi, '');
    code = code.replace(/document\.getElementById\(\s*['"]loading-screen['"]\s*\)/g, "document.createElement('div')");

    code = code.replace(/<script[^>]*src=["'][^"']*sdk\.js["'][^>]*>\s*<\/script>/gi, '');
    code = code.replace(/<script[^>]*onload=["'][^"']*initSDK[^"']*["'][^>]*>\s*<\/script>/gi, '');

    code = code.replace(/fetch\(\s*['"][^'"]+\.(?:mp3|wav|ogg|m4a)['"]\s*\)[\s\S]*?\.catch\([^;]*\);?/gi, '');
    code = code.replace(/\.(?:mp3|wav|ogg|m4a)(?=["'])/gi, '');

    code = replaceFunctionBlock(code, 'initSDK',
        'function initSDK() { try { if (window.updateStaticTexts) window.updateStaticTexts(); if (window.startGameLogic) window.startGameLogic(); } catch (e) {} }');
    code = removeFunctionBlock(code, 'loadLocalProgress');
    code = code.replace(/\b(?:initSDK|loadLocalProgress)\s*\(\s*\)\s*;/g, '');

    return code;
}

const referenceCache = {};
function loadReference(fileName) {
    if (referenceCache[fileName] !== undefined) return referenceCache[fileName];
    const refPath = path.join(__dirname, 'references', fileName);
    if (!fs.existsSync(refPath)) { referenceCache[fileName] = ''; return ''; }
    const clean = sanitizeReference(fs.readFileSync(refPath, 'utf8'));
    referenceCache[fileName] = clean;
    return clean;
}

function validateGameCode(code, platform) {
    const issues = [];
    const critical = (msg) => issues.push({ level: 'critical', msg });
    const warning = (msg) => issues.push({ level: 'warning', msg });

    if (!/<\/html>/i.test(code)) critical('файл обрезан: нет закрывающего </html>');
    if (!/<canvas[\s>]/i.test(code)) critical('нет элемента <canvas>');
    if (!/getContext\s*\(\s*['"]2d['"]/.test(code)) critical('canvas не инициализирован через getContext("2d")');
    if (!/requestAnimationFrame/i.test(code)) critical('нет игрового цикла requestAnimationFrame');

    const phs = (code.match(/\{\{\s*[^}]+\s*\}\}/g) || []).filter(p => !/AI_BG_IMAGE/.test(p));
    if (phs.length) critical('неподставленные плейсхолдеры: ' + [...new Set(phs)].slice(0, 5).join(', '));

    const extScripts = code.match(/<script[^>]*\ssrc\s*=\s*["'][^"']+["'][^>]*>/gi) || [];
    if (extScripts.length) critical('внешние <script src> запрещены (' + extScripts.length + ' шт.)');
    if (/getElementById\s*\(\s*['"]loading-screen['"]\s*\)/i.test(code)) critical('остались обращения к экрану загрузки loading-screen');
    if (/\.(mp3|wav|ogg|m4a|aac|flac)(?=["'\s?#])/i.test(code) || /new\s+Audio\s*\(\s*["']/.test(code)) critical('внешние аудиофайлы запрещены — используй WebAudio');
    const extImgs = (code.match(/<img[^>]*\ssrc\s*=\s*["']https?:\/\/[^"']+["']/gi) || []).filter(u => !/unsplash/i.test(u));
    if (extImgs.length) critical('внешние <img src> запрещены (' + extImgs.length + ' шт.)');

    const extLinks = code.match(/<link[^>]*\shref\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi) || [];
    if (extLinks.length) warning('внешние <link> (стили/шрифты): ' + extLinks.length + ' шт.');

    const hasTouch = /touch(start|end|move)|pointer(down|move|up)/i.test(code);
    const hasKeyboard = /key(down|up)|wheel/i.test(code);
    const hasMouse = /mouse(down|up|move)|pointer(down|move|up)|\bclick\b/i.test(code);
    if (platform === 'mobile') {
        if (!hasTouch && !hasMouse) critical('нет touch-управления для мобильной версии');
        if (hasKeyboard) warning('клавиатура в мобильной версии — по условию её быть не должно');
    } else {
        if (!hasKeyboard && !hasMouse) critical('нет управления мышью/клавиатурой для ПК');
        if (/touch(start|move|end)/i.test(code)) warning('touch-события в ПК-версии — по условию их быть не должно');
    }
    if (!/resize|innerWidth|clientWidth|devicePixelRatio|width:\s*100%|100vw/i.test(code)) warning('нет обработки ресайза/адаптации под экран');
    if (platform === 'mobile' && /canvas\.width\s*=\s*[^;]*devicePixelRatio/i.test(code) && !/Math\.min\s*\([^)]*devicePixelRatio/i.test(code)) {
        critical('canvas.width использует неограниченный devicePixelRatio');
    }

    if (!/меню|\bmenu\b|\bstart\b|старт/i.test(code)) warning('не найдено состояние Меню');
    if (!/game\s*over|gameover|оконч\w*\s*игр|конец\s*игр|поражени|проигрыш|неудач/i.test(code)) warning('не найдено состояние Game Over');
    if (!/restart|рестарт|заново|ещ[её]\s*раз|replay|try\s*again/i.test(code)) warning('не найдено состояние Рестарт');

    if (/YaGames|\bysdk\b/i.test(code)) warning('Яндекс SDK (YaGames) — должен быть удалён');
    if (/localStorage/i.test(code)) warning('localStorage — должен быть удалён');
    if (/\bi18n\s*[=:[]/i.test(code)) warning('словари локализации i18n — должны быть удалены');
    if (/<button[\s>]/i.test(code)) warning('HTML-элементы <button> — рисуй кнопки на canvas или div-оверлеями');
    if (/fetch\s*\(|XMLHttpRequest/i.test(code)) warning('сетевые запросы fetch/XHR в игре — обычно не нужны');

    const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m, idx = 0;
    while ((m = scriptRe.exec(code)) !== null) {
        const attrs = m[1] || '';
        if (/\ssrc\s*=/.test(attrs)) continue;
        const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (type && !/javascript|module/i.test(type)) continue;
        const js = m[2].trim();
        if (!js) continue;
        try {
            new vm.Script(js, { filename: 'game_' + idx + '.js' });
        } catch (e) {
            critical('сбой JavaScript в скрипте #' + (idx + 1) + ': ' + e.message);
        }
        idx++;
    }
    return issues;
}

function detectPlatform(code) {
    const text = String(code || '');
    const hasTouch = /touch(start|end|move)|pointer(down|move|up)/i.test(text);
    const hasKeyboard = /key(down|up)|wheel/i.test(text);
    return hasTouch && !hasKeyboard ? 'mobile' : 'pc';
}

function extractBackgroundUrl(code) {
    const match = String(code || '').match(/background(?:-image)?\s*:\s*[^;]*?url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    return match ? safeCssUrl(match[1], '') : '';
}

function normalizeImprovedCode(code, originalCode) {
    let out = String(code || '').replace(/\[BG:\s*[^\]]+\]/gi, '').trim();
    const originalBg = extractBackgroundUrl(originalCode);
    if (originalBg) {
        out = out.replace(/\{\{AI_BG_IMAGE\}\}/g, originalBg);
        if (!/background(?:-image)?\s*:[^;]*url\(/i.test(out)) {
            const styleTag = `<style>body { background: url('${originalBg}') center/cover no-repeat !important; }</style>`;
            if (out.includes('</head>')) out = out.replace('</head>', '\n' + styleTag + '\n</head>');
            else out = out.replace(/<body/i, styleTag + '<body');
        }
    } else {
        out = out.replace(/\{\{AI_BG_IMAGE\}\}/g, '');
    }
    return out;
}

async function repairGameCode(code, issues, platform, options = {}) {
    const controlsPrompt = platform === 'mobile' ? CONTROLS_MOBILE : CONTROLS_PC;
    const preserveBackground = Boolean(options.preserveBackground);
    const backgroundRules = preserveBackground
        ? [
            '- Сохрани существующий фон и визуальный стиль игры.',
            '- Не используй {{AI_BG_IMAGE}} и не добавляй строку [BG: ...].'
        ]
        : [
            "- В CSS тела оставь дословно: background: url('{{AI_BG_IMAGE}}') center/cover no-repeat;",
            '- Перед </html> добавь строку [BG: два-три англ слова для фона].'
        ];
    let current = code;
    let currentIssues = issues;
    for (let round = 1; round <= 2; round++) {
        const criticals = currentIssues.filter(i => i.level === 'critical');
        if (!criticals.length) break;
        const list = currentIssues.map((it, n) => `${n + 1}. ${it.level === 'critical' ? '[КРИТИЧНО]' : '[важно]'} ${it.msg}`).join('\n');
        const repairPrompt = [
            'Ниже — сгенерированная HTML5 Canvas-игра. Автоматическая проверка нашла проблемы:',
            list,
            '',
            'Исправь ВСЕ перечисленные проблемы, сохранив рабочую механику игры.',
            'Требования к результату:',
            '- Верни ПОЛНЫЙ файл целиком: от <!DOCTYPE html> до </html>.',
            '- Только код: без markdown, пояснений и комментариев.',
            '- Один файл: CSS в <style>, JS в <script>, без внешних ресурсов.',
            ...backgroundRules,
            '- Управление: ' + controlsPrompt,
            '',
            'КОД ИГРЫ:',
            current
        ].join('\n');
        try {
            const result = await gemini.generate({
                systemInstruction: preserveBackground ? IMPROVE_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION,
                contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
                safetySettings: SAFETY_SETTINGS,
                generationConfig: { temperature: 0.3, topK: 40, topP: 0.9, maxOutputTokens: 65536 },
                timeout: 300000
            });
            let repaired = stripCodeMarkers(result.text);
            if (!repaired || !/<\/html>/i.test(repaired)) continue;
            if (preserveBackground) repaired = normalizeImprovedCode(repaired, options.originalCode || code);
            current = repaired;
            currentIssues = validateGameCode(current, platform);
            if (!currentIssues.some(i => i.level === 'critical')) break;
        } catch (e) {
            console.error(`[Авторемонт] Раунд ${round} не удался:`, e.message);
        }
    }
    return { code: current, issues: currentIssues };
}

function collectQualityIssues(code, platform) {
    const validation = validateGameCode(code, platform);
    const audit = auditGame(code, platform);
    const issues = validation.concat(audit.issues);
    return {
        issues,
        criticals: issues.filter((issue) => issue.level === 'critical'),
        audit,
        technicalScore: audit.score
    };
}

async function runQualityPipeline(code, options = {}) {
    const platform = options.platform || 'pc';
    const report = {
        code,
        patched: false,
        repaired: false,
        polished: false,
        criticRepaired: false,
        critic: null,
        criticScore: null,
        technicalScore: 0,
        score: 0,
        issues: []
    };

    let currentCode = code;
    let current = collectQualityIssues(currentCode, platform);
    report.technicalScore = current.technicalScore;

    if (current.criticals.length) {
        try {
            const patched = await patchGameCode(currentCode, current.criticals, { platform });
            if (patched.patched) {
                const after = collectQualityIssues(patched.code, platform);
                if (!after.criticals.length) {
                    currentCode = patched.code;
                    current = after;
                    report.patched = true;
                    console.log('[Качество] Точечный патч закрыл замечания');
                }
            }
        } catch (error) {
            console.error('[Качество] Патч не удался:', error.message);
        }
    }

    if (current.criticals.length) {
        try {
            const repaired = await repairGameCode(currentCode, current.issues, platform);
            const after = collectQualityIssues(repaired.code, platform);
            if (!after.criticals.length) {
                currentCode = repaired.code;
                current = after;
                report.repaired = true;
            }
        } catch (error) {
            console.error('[Качество] Ремонт не удался:', error.message);
        }
    }

    if (QUALITY_CRITIC_ENABLED) {
        try {
            const critic = await reviewCode(currentCode, {
                brief: options.brief || '',
                plan: options.plan || '',
                platform
            });
            report.critic = critic;
            report.criticScore = critic.score;
            if (critic.noVerdict) {
                console.warn(`[Качество] Критик не дал вердикта (${critic.reason}) — оцениваю по техническому аудиту`);
            }

            const criticIssues = criticToIssues(critic);
            if (criticIssues.some((issue) => issue.level === 'critical')) {
                try {
                    const repaired = await repairGameCode(currentCode, criticIssues, platform);
                    const after = collectQualityIssues(repaired.code, platform);
                    if (!after.criticals.length) {
                        currentCode = repaired.code;
                        current = after;
                        report.criticRepaired = true;
                    }
                } catch (error) {
                    console.error('[Качество] Ремонт по критику не удался:', error.message);
                }
            }

            if (!QUALITY_POLISH_ENABLED) {
                console.log('[Качество] Полиш выключен');
            } else if (typeof critic.score !== 'number') {
                console.log('[Качество] Полиш пропущен: у критика нет оценки');
            } else if (critic.score >= QUALITY_CRITIC_MIN_SCORE) {
                console.log(`[Качество] Полиш не требуется: оценка ${critic.score} >= ${QUALITY_CRITIC_MIN_SCORE}`);
            } else {
                try {
                    const polished = await polishGameCode(currentCode, critic, { platform, keepBackground: true });
                    if (!polished.code || !/<\/html>/i.test(polished.code)) {
                        console.log('[Качество] Полиш отклонён: модель вернула неполный HTML');
                    } else {
                        const after = collectQualityIssues(polished.code, platform);
                        if (after.criticals.length) {
                            console.log(`[Качество] Полиш отклонён: осталось критичных замечаний (${after.criticals.length})`);
                        } else if (after.technicalScore < current.technicalScore) {
                            console.log(`[Качество] Полиш отклонён: технический балл упал ${current.technicalScore} → ${after.technicalScore}`);
                        } else {
                            currentCode = polished.code;
                            current = after;
                            report.polished = true;
                            console.log('[Качество] Полиш-пасс применён');
                        }
                    }
                } catch (error) {
                    console.error('[Качество] Полиш не удался:', error.message);
                }
            }
        } catch (error) {
            console.error('[Качество] Критик не ответил:', error.message);
        }
    }

    report.code = currentCode;
    report.technicalScore = current.technicalScore;
    report.issues = current.issues.map((issue) => ({
        level: issue.level,
        code: issue.code || null,
        msg: issue.msg
    }));
    report.issueCodes = report.issues.map((issue) => issue.code || issue.msg).slice(0, 12);
    report.score = report.criticScore === null
        ? current.technicalScore
        : Math.round(current.technicalScore * 0.6 + report.criticScore * 0.4);
    return report;
}

function buildGenerationPrompt(userPrompt, platform = 'pc', options = {}) {
    const plan = String(options.plan || '').trim();
    const selectedFile = options.selectedFile || selectReferenceEngine(userPrompt);
    const referenceCode = options.referenceCode !== undefined ? options.referenceCode : loadReference(selectedFile);
    const controlsPrompt = platform === 'mobile' ? CONTROLS_MOBILE : CONTROLS_PC;

    const promptLines = [];
    if (referenceCode) {
        promptLines.push(
            `=== ЭТАЛОН КОДА (${selectedFile}) — ДЛЯ СПРАВКИ ПО МЕХАНИКЕ ===`,
            referenceCode,
            '=== КОНЕЦ ЭТАЛОНА ===',
            '',
            '⚠️ ПОСТОРОННИЙ КОД В ЭТАЛОНЕ НЕ ПЕРЕНОСИ: Yandex SDK (YaGames), localStorage, словари i18n, экран загрузки и getElementById("loading-screen"), HTML-элементы <button>.',
            'Копируй из эталона ТОЛЬКО: игровой цикл requestAnimationFrame, физику и коллизии, структуру состояний (меню/игра/пауза/game over/рестарт). Визуальный стиль не копируй: сделай графику современнее и богаче, чем в эталоне.',
            ''
        );
    }
    if (plan) {
        promptLines.push(
            '=== ПЛАН ИГРЫ (СЛЕДУЙ ЕМУ) ===',
            plan,
            '=== КОНЕЦ ПЛАНА ===',
            ''
        );
    }
    promptLines.push(
        'ПРАВИЛА УПРАВЛЕНИЯ: ' + controlsPrompt,
        platform === 'mobile' ? MOBILE_PERFORMANCE : DESKTOP_PERFORMANCE,
        '',
        buildDesignBrief(userPrompt, platform, { feedback: getRatingFeedback(userPrompt) }),
        '',
        'Идея для новой игры: ' + userPrompt,
        'Перед ответом проверь: старт нажимается, canvas не 0×0, все объекты в кадре, частицы и враги не растут без предела.'
    );
    return promptLines.join('\n');
}

async function generateAIGame(userPrompt, platform = 'pc', options = {}, maxRetries = 5) {
    const plan = String(options.plan || '').trim();
    try {
        if (!process.env.GEMINI_API_KEY) throw new Error('Ключ Gemini не настроен');

        const selectedFile = selectReferenceEngine(userPrompt);
        const referenceCode = loadReference(selectedFile);
        const fullPrompt = buildGenerationPrompt(userPrompt, platform, { plan, selectedFile, referenceCode });

        let fullCode = '';
        let history = [{ role: 'user', parts: [{ text: fullPrompt }] }];
        let isFinished = false;
        let inputTokens = 0;
        let outputTokens = 0;
        let usedModel = null;
        let fallbackUsed = false;

        for (let chunk = 0; chunk < 5 && !isFinished; chunk++) {
            let attemptSuccess = false;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const result = await gemini.generate({
                        systemInstruction: SYSTEM_INSTRUCTION,
                        contents: history,
                        safetySettings: SAFETY_SETTINGS,
                        generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 65536 },
                        timeout: 300000,
                        onRetry: ({ attempt: retryAttempt, delay, model }) => {
                            console.error(`[Генерация] Модель ${model} не ответила, повтор ${retryAttempt} через ${delay} мс`);
                        }
                    });
                    const chunkText = result.text;
                    inputTokens += result.usage.inputTokens;
                    outputTokens += result.usage.outputTokens;
                    usedModel = result.model;
                    fallbackUsed = fallbackUsed || result.fallbackUsed;
                    fullCode += chunkText;

                    if (!stripCodeMarkers(fullCode).includes('</html>')) {
                        history.push({ role: 'model', parts: [{ text: chunkText }] });
                        history.push({ role: 'user', parts: [{ text: 'Код оборвался. Продолжи СТРОГО с того символа, где остановился, и доведи файл до </html>.' }] });
                        attemptSuccess = true;
                        break;
                    }
                    isFinished = true;
                    attemptSuccess = true;
                    break;
                } catch (err) {
                    const status = err.response ? err.response.status : null;
                    const retryable = !status || status === 429 || status >= 500;
                    if (!retryable || attempt === maxRetries) throw err;
                    await new Promise(r => setTimeout(r, Math.min(20000, 3000 * attempt)));
                    continue;
                }
            }
            if (!attemptSuccess) break;
        }

        if (!isFinished) return null;
        const rawCode = stripCodeMarkers(fullCode);
        const bgMatch = rawCode.match(/\[BG:\s*([^\]]+)\]/i);
        return {
            code: rawCode.replace(/\[BG:\s*([^\]]+)\]/i, '').trim(),
            bgKeyword: bgMatch && bgMatch[1] ? sanitizeText(bgMatch[1], 60) : null,
            inputTokens,
            outputTokens,
            model: usedModel || gemini.PRIMARY_MODEL,
            fallbackUsed
        };
    } catch (e) {
        console.error('[Генерация] Ошибка:', e.message);
        return null;
    }
}

async function improveAIGame(currentCode, instruction, platform = 'pc', maxRetries = 3) {
    if (!process.env.GEMINI_API_KEY) throw new Error('Ключ Gemini не настроен');
    const controlsPrompt = platform === 'mobile' ? CONTROLS_MOBILE : CONTROLS_PC;
    const prompt = [
        'Ниже — рабочая HTML5 Canvas-игра. Улучши её по инструкции пользователя.',
        'ИНСТРУКЦИЯ: ' + instruction,
        '',
        'Требования:',
        '- Верни ПОЛНЫЙ файл от <!DOCTYPE html> до </html>, без markdown и пояснений.',
        '- Сохрани всё, что не просили менять: управление, механику, стиль и фон.',
        '- Не ломай текущую игру и не добавляй внешние ресурсы.',
        '- Не используй {{AI_BG_IMAGE}}, не добавляй [BG: ...], localStorage, YaGames, i18n и HTML <button>.',
        '- Управление: ' + controlsPrompt,
        '',
        'ТЕКУЩИЙ КОД:',
        currentCode
    ].join('\n');
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await gemini.generate({
                systemInstruction: IMPROVE_SYSTEM_INSTRUCTION,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                safetySettings: SAFETY_SETTINGS,
                generationConfig: { temperature: 0.4, topK: 40, topP: 0.9, maxOutputTokens: 65536 },
                timeout: 300000
            });
            inputTokens += result.usage.inputTokens;
            outputTokens += result.usage.outputTokens;
            const code = stripCodeMarkers(result.text);
            if (!code || !/<\/html>/i.test(code)) throw new Error('Модель вернула неполный файл');
            return { code, inputTokens, outputTokens, model: result.model, fallbackUsed: result.fallbackUsed };
        } catch (err) {
            const status = err.response ? err.response.status : null;
            const retryable = !status || status === 429 || status >= 500;
            if (!retryable || attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, Math.min(20000, 3000 * attempt)));
        }
    }
    throw new Error('Не удалось улучшить игру');
}

const app = express();
app.disable('x-powered-by');
const PORT = envInt('PORT', 3000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const uploadsDir = path.join(DATA_DIR, 'uploads');
const aiGamesDir = path.join(DATA_DIR, 'ai_games');
const referencesDir = path.join(__dirname, 'references');
const legalDir = path.join(__dirname, 'legal');
const ENGINE_NAMES = ['arkanoid', 'bubble', 'platformer', 'shooter', 'tetris'];

for (const dir of [uploadsDir, aiGamesDir, referencesDir, legalDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function publicGameUrl(gameId) {
    const base = GAMES_PUBLIC_URL || '';
    return `${base}/play/${encodeURIComponent(gameId)}`;
}

function sandboxGameUrl(gameId) {
    const base = GAMES_PUBLIC_URL || '';
    return `${base}/sandbox/${encodeURIComponent(gameId)}`;
}

function injectDprGuard(html) {
    const guard = `<script>(function(){var cap=${MAX_DEVICE_PIXEL_RATIO};try{if((window.devicePixelRatio||1)>cap){Object.defineProperty(window,'devicePixelRatio',{get:function(){return cap;},configurable:true});}}catch(e){}})();</script>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => match + guard);
    if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => match + guard);
    return guard + html;
}

function applySandboxHeaders(res) {
    res.setHeader('Content-Security-Policy', [
        'sandbox allow-scripts allow-pointer-lock allow-orientation-lock',
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval'",
        "style-src 'unsafe-inline'",
        "img-src data: https: http:",
        "media-src data:",
        "font-src data:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

app.get('/', (req, res) => res.type('text').send('Фабрика Игр: Статус OK'));
app.get('/sdk.js', (req, res) => res.type('application/javascript').send('console.log("Mock SDK loaded");'));

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        uptime: Math.round(process.uptime()),
        version: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'dev'
    });
});

app.get('/readyz', (req, res) => {
    try {
        getStats();
        res.json({ ok: true });
    } catch (error) {
        res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
});

app.use('/uploads', express.static(uploadsDir, {
    fallthrough: false,
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));

app.get('/legal', (req, res) => {
    const files = fs.readdirSync(legalDir).filter((file) => file.endsWith('.md')).sort();
    const items = files.map((file) => {
        const title = file.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
        return `<li><a href="/legal/${encodeURIComponent(file)}">${escapeHtml(title)}</a></li>`;
    }).join('');
    res.type('html').send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Правила и документы</title></head><body><h1>Правила и документы</h1><ul>${items}</ul></body></html>`);
});

app.use('/legal', express.static(legalDir, {
    fallthrough: false,
    setHeaders: (res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

app.get('/play/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    if (!isSafeGameId(gameId)) return res.status(404).send('Игра не найдена');

    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    if (!fs.existsSync(gamePath)) return res.status(404).send('Игра не найдена');

    const game = getGame(gameId);
    if (game && game.status === 'hidden') return res.status(404).send('Игра не найдена');
    const title = escapeHtml(sanitizeGameTitle(game && game.title, 'Игра'));
    const iframeSrc = escapeHtml(sandboxGameUrl(gameId));

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${title}</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<iframe src="${iframeSrc}" title="${title}" sandbox="allow-scripts allow-pointer-lock allow-orientation-lock" allow="fullscreen" referrerpolicy="no-referrer"></iframe>
</body>
</html>`);
});

app.get('/sandbox/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    if (!isSafeGameId(gameId)) return res.status(404).type('text').send('Игра не найдена');

    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    if (!fs.existsSync(gamePath)) return res.status(404).type('text').send('Игра не найдена');

    const game = getGame(gameId);
    if (game && game.status === 'hidden') return res.status(404).type('text').send('Игра не найдена');

    let html;
    try {
        html = fs.readFileSync(gamePath, 'utf8');
    } catch (error) {
        return res.status(500).type('text').send('Не удалось открыть игру');
    }

    html = injectDprGuard(html);
    applySandboxHeaders(res);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('html').send(html);
});

app.get('/test-games/', (req, res) => {
    const dir = path.join(__dirname, 'test-games');
    const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((file) => /^[a-z0-9-]+\.html$/i.test(file)).sort()
        : [];
    const links = files.map((file) =>
        `<li><a href="/test-games/${encodeURIComponent(file)}">${escapeHtml(file)}</a></li>`).join('');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тестовые игры</title></head><body><h1>Тестовые игры</h1><p>Проверка мобильной производительности.</p><ul>${links || '<li>Пока нет игр</li>'}</ul></body></html>`);
});

app.get('/test-games/:file', (req, res) => {
    const file = String(req.params.file || '');
    if (!/^[a-z0-9-]+\.html$/i.test(file)) return res.status(404).type('text').send('Игра не найдена');

    const gamePath = path.join(__dirname, 'test-games', file);
    if (!fs.existsSync(gamePath)) return res.status(404).type('text').send('Игра не найдена');

    let html;
    try {
        html = fs.readFileSync(gamePath, 'utf8');
    } catch (error) {
        return res.status(500).type('text').send('Не удалось открыть игру');
    }

    html = injectDprGuard(html);
    applySandboxHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(html);
});

app.get('/ai_games/:file', (req, res) => {
    const match = String(req.params.file || '').match(/^(ai_[0-9]{10,20})\.html$/);
    if (!match) return res.status(404).send('Игра не найдена');
    const gamePath = path.join(aiGamesDir, `${match[1]}.html`);
    if (!fs.existsSync(gamePath)) return res.status(404).send('Игра не найдена');
    const game = getGame(match[1]);
    if (game && game.status === 'hidden') return res.status(404).send('Игра не найдена');
    return res.redirect(301, publicGameUrl(match[1]));
});

app.get('/:engine/', (req, res, next) => {
    const engine = sanitizeEngine(req.params.engine, ENGINE_NAMES);
    if (!engine) return next();

    const biomeKey = sanitizeBiome(req.query.biome, Object.keys(styles));
    const s = styles[biomeKey];
    const platform = sanitizePlatform(req.query.platform);
    const bgFile = sanitizeBgFilename(req.query.bg);
    const indexPath = path.join(__dirname, 'templates', `${engine}_core`, 'index.html');

    if (!fs.existsSync(indexPath)) return res.status(404).send('<h2>Движок в разработке.</h2>');

    let html = fs.readFileSync(indexPath, 'utf8');
    const customBg = safeCssUrl(bgFile ? `/uploads/${bgFile}` : s.img, s.img);
    const gameName = sanitizeGameTitle(req.query.name, s.name);
    const safeTitle = escapeHtmlText(gameName);

    html = html.replace(/{{GAME_TITLE}}/g, () => safeTitle)
               .replace(/{{BG_IMAGE}}/g, () => customBg)
               .replace(/{{BG_COLOR}}/g, s.bg)
               .replace(/{{BLOCK_COLOR}}/g, s.block)
               .replace(/{{FONT_FAMILY}}/g, s.font)
               .replace(/{{SHADOW}}/g, s.shadow)
               .replace(/{{LIFE_ICON}}/g, s.life)
               .replace(/{{SCORE_ICON}}/g, s.score)
               .replace(/{{BOOSTER_WIDE}}/g, s.b_wide)
               .replace(/{{BOOSTER_TRIPLE}}/g, s.b_triple)
               .replace(/{{BOOSTER_FIRE}}/g, s.b_fire)
               .replace(/{{BOOSTER_LIGHTNING}}/g, s.b_lightning)
               .replace(/{{PLATFORM}}/g, platform);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(html);
});

app.use('/:engine', (req, res, next) => {
    const engine = sanitizeEngine(req.params.engine, ENGINE_NAMES);
    if (!engine) return next();
    const dir = path.join(__dirname, 'templates', `${engine}_core`);
    if (fs.existsSync(dir)) express.static(dir)(req, res, next); else next();
});

app.use((err, req, res, next) => {
    console.error('[HTTP] Ошибка:', err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).type('text').send('Ошибка сервера');
});

const UI_DIVIDER = '━━━━━━━━━━━━━━';
const WELCOME_IMAGE_URL = safeHttpsUrl(process.env.WELCOME_IMAGE_URL || styles.silent_stars.img, null);
const PLAN_META = {
    pack3: { emoji: '🧪', label: 'Попробовать', short: '3 игры' },
    starter: { emoji: '🌱', label: 'Starter', short: '15 игр/мес' },
    creator: { emoji: '🚀', label: 'Creator', short: '50 игр/мес' },
    studio: { emoji: '🏆', label: 'Studio', short: '150 игр/мес' },
    campaign: { emoji: '🎯', label: 'Кампания', short: '15 игр' }
};
const ENGINE_LABELS = {
    arkanoid: 'Арканоид',
    bubble: 'Бабл Шутер',
    platformer: 'Платформер',
    shooter: 'Шутер',
    tetris: 'Тетрис'
};
const AI_IDEAS = [
    'аркада, где кот-космонавт собирает звёзды и уворачивается от астероидов',
    'платформер, где робот-садовник оживляет растения и убегает от токсичного тумана',
    'шутер, где пиксельный самурай отражает волны духов в неоновом Токио',
    'бабл-шутер с драконами и кристаллами в подземелье',
    'арканоид, где ты разрушаешь астероиды и собираешь редкие минералы',
    'тетрис с инопланетными блоками и гравитационными аномалиями'
];
const COMPLAINT_REASONS = {
    sexual: '🔞 Сексуальный контент',
    violence: '🩸 Насилие',
    hate: '💢 Оскорбления',
    illegal: '⚠️ Опасный контент',
    broken: '🛠 Не работает',
    other: '✍️ Другое'
};

function complaintReasonLabel(reason) {
    return Object.prototype.hasOwnProperty.call(COMPLAINT_REASONS, reason)
        ? COMPLAINT_REASONS[reason]
        : String(reason);
}

function complaintStatusLabel(complaint) {
    if (complaint.status === 'open') return 'на рассмотрении';
    if (complaint.status === 'dismissed') return 'отклонена';
    if (complaint.action === 'hide_game') return 'игра скрыта';
    return 'закрыта';
}

function complaintCard(complaint, { note = null, status = null } = {}) {
    const lines = [
        `🚩 <b>Жалоба #${complaint.id}</b>`,
        UI_DIVIDER,
        `🎮 <b>${escapeHtml(sanitizeGameTitle(complaint.game_title, 'Игра'))}</b>`,
        `<code>${escapeHtml(complaint.game_id)}</code>`,
        `👤 Автор игры: <code>${complaint.owner_id || '—'}</code>`,
        `🙋 Жалобщик: <code>${complaint.reporter_id}</code>`,
        `📌 Причина: <b>${escapeHtml(complaintReasonLabel(complaint.reason))}</b>`,
        `🗓 ${escapeHtml(complaint.created_at)}`,
        `📊 Статус: <b>${status || complaintStatusLabel(complaint)}</b>`
    ];
    if (complaint.details) lines.push('', `💬 ${escapeHtml(complaint.details)}`);
    if (note) lines.push('', note);
    return lines.join('\n');
}

function complaintKeyboard(complaint) {
    if (complaint.status === 'open') {
        return Markup.inlineKeyboard([[
            Markup.button.callback('🙈 Скрыть игру', `mod_hide_${complaint.id}`),
            Markup.button.callback('✅ Отклонить', `mod_dismiss_${complaint.id}`)
        ]]);
    }
    if (complaint.status === 'resolved' && complaint.action === 'hide_game') {
        return Markup.inlineKeyboard([[
            Markup.button.callback('↩️ Вернуть игру', `mod_restore_${complaint.id}_${complaint.game_id}`)
        ]]);
    }
    return Markup.inlineKeyboard([]);
}

async function notifyAdminsWithKeyboard(text, keyboard) {
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML', ...keyboard });
        } catch (error) {
            // Админ мог не начать диалог с ботом.
        }
    }
}

async function submitComplaint(ctx, { gameId, reason, details = null, edit = false }) {
    const reply = async (text) => {
        if (edit && ctx.callbackQuery) {
            return ctx.editMessageText(text).catch(() => ctx.reply(text));
        }
        return ctx.reply(text);
    };

    const game = getGame(gameId);
    if (!game) return reply('❌ Игра не найдена.');
    if (game.status === 'hidden') return reply('❌ Игра уже скрыта модератором.');
    if (!tryConsumeRateLimit(`complaint:${ctx.from.id}`, 5, 24 * 60 * 60 * 1000)) {
        return reply('❌ Слишком много жалоб за сутки. Попробуй позже.');
    }

    const result = createComplaint({ gameId, reporterId: ctx.from.id, reason, details });
    if (!result.created) {
        return reply(result.reason === 'duplicate'
            ? 'Ты уже жаловался на эту игру. Жалоба ещё на рассмотрении.'
            : '❌ Не удалось отправить жалобу.');
    }

    logEvent('complaint_created', ctx.from.id, {
        gameId,
        complaintId: result.complaint.id,
        reason
    });
    await notifyAdminsWithKeyboard(complaintCard(result.complaint), complaintKeyboard(result.complaint));
    return reply(`✅ Жалоба #${result.complaint.id} принята. Мы проверим игру.`);
}

function planMeta(plan) {
    return PLAN_META[plan.id] || { emoji: '💎', label: plan.title, short: gamesLabel(plan.games) };
}

function planButton(plan) {
    const meta = planMeta(plan);
    return Markup.button.callback(`${meta.emoji} ${meta.label} · ${plan.stars} ⭐`, `plan_${plan.id}`);
}

function subscriptionLine(user) {
    const until = user.subscriptionUntil ? new Date(user.subscriptionUntil) : null;
    if (!until || !Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) return '';
    const plan = user.subscriptionPlan ? getPlan(user.subscriptionPlan) : null;
    const title = plan ? plan.title : 'активна';
    return `💎 Подписка: <b>${escapeHtml(title)}</b> до ${until.toLocaleDateString('ru-RU')}`;
}

function getMainMenuText(user) {
    const sub = subscriptionLine(user);
    const lines = [
        '🌌 <b>Фабрика Игр</b>',
        '<i>Твоя идея — игра за пару минут</i>',
        UI_DIVIDER,
        `🎮 Доступно: <b>${gamesLabel(userGames(user))}</b>`
    ];
    if (sub) lines.push(sub);
    lines.push('', 'Выбери действие:');
    return lines.join('\n');
}

function getMainMenuKeyboard() {
    const rows = [
        [Markup.button.callback('✨ Создать игру', 'start_creation')],
        [Markup.button.callback('💎 Тарифы', 'show_plans'), Markup.button.callback('👤 Профиль', 'show_profile')],
        [Markup.button.callback('🎁 Пригласить друга', 'show_referral'), Markup.button.callback('❓ Как это работает', 'show_howto')],
        [Markup.button.callback('📜 Правила и оферта', 'show_legal')]
    ];
    const communityUrl = safeHttpsUrl(process.env.COMMUNITY_URL || '', null);
    if (communityUrl) rows.push([Markup.button.url('🌐 Наше сообщество', communityUrl)]);
    return Markup.inlineKeyboard(rows);
}

bot.start(async (ctx) => {
    ctx.session.gameData = {};
    ctx.session.step = null;
    const userId = ctx.from.id;
    const refId = Number.parseInt(ctx.payload, 10);
    const existing = findUser(userId);
    const user = tgUser(ctx);

    if (!existing && Number.isSafeInteger(refId) && refId !== userId) {
        const referrer = findUser(refId);
        if (referrer && !referrer.banned) {
            const attached = attachReferral(userId, refId);
            if (attached) {
                try {
                    await bot.telegram.sendMessage(refId, '🎉 По твоей ссылке пришёл новый игрок. Награда придёт после его первой игры.');
                } catch (e) { /* пользователь мог заблокировать бота */ }
            }
        }
    }

    logEvent('start', userId, { newUser: !existing, refId: Number.isSafeInteger(refId) ? refId : null });
    const text = getMainMenuText(user);
    const options = { parse_mode: 'HTML', ...getMainMenuKeyboard() };
    if (WELCOME_IMAGE_URL) {
        try {
            await ctx.replyWithPhoto(WELCOME_IMAGE_URL, {
                caption: '✨ <b>Добро пожаловать в Фабрику Игр!</b>\n<i>Собери свою игру за пару минут</i>',
                parse_mode: 'HTML'
            });
        } catch (e) {
            console.warn('[Старт] Не удалось отправить баннер:', e.message);
        }
    }
    return ctx.reply(text, options);
});

bot.action('main_menu', async (ctx) => {
    ctx.session.gameData = {};
    ctx.session.step = null;
    const user = tgUser(ctx);
    const text = getMainMenuText(user);
    const options = { parse_mode: 'HTML', ...getMainMenuKeyboard() };
    try {
        await ctx.editMessageText(text, options);
    } catch (e) {
        await ctx.reply(text, options);
    }
});

bot.action('show_howto', async (ctx) => {
    const txt = [
        '🚀 <b>Как это работает</b>',
        UI_DIVIDER,
        '1️⃣ Опиши идею в 1–2 предложениях',
        '2️⃣ Нейросеть проектирует механику и собирает игру',
        '3️⃣ Играй прямо в Telegram и улучшай результат',
        '',
        '✨ <b>Совет:</b> чем конкретнее идея, тем интереснее игра.',
        '<i>Пример: «кот-космонавт собирает звёзды и уворачивается от астероидов»</i>'
    ].join('\n');
    const kb = [
        [Markup.button.callback('✨ Создать игру', 'start_creation')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText(txt, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action('show_profile', async (ctx) => {
    const user = tgUser(ctx);
    const lines = [
        '👤 <b>Профиль</b>',
        UI_DIVIDER,
        `🆔 ID: <code>${ctx.from.id}</code>`,
        `🎮 Доступно: <b>${gamesLabel(userGames(user))}</b>`,
        `👥 Друзей: <b>${user.referrals}</b>`
    ];
    const sub = subscriptionLine(user);
    if (sub) lines.push(sub);
    if (user.isAdmin) lines.push('👑 <b>Администратор</b>');

    const kb = [
        [Markup.button.callback('✨ Создать игру', 'start_creation'), Markup.button.callback('💎 Пополнить', 'show_plans')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action('show_referral', async (ctx) => {
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Собери свою игру в «Фабрике Игр» за пару минут 🎮')}`;
    const reward = gamesLabel(gamesFromBalance(REWARD_PER_REF));
    const txt = [
        '🎁 <b>Приглашай друзей</b>',
        UI_DIVIDER,
        `За друга, который создаст первую игру: <b>+${reward}</b>`,
        '',
        '🔗 <b>Твоя ссылка:</b>',
        `<code>${escapeHtml(link)}</code>`,
        '',
        '<i>Награда начисляется один раз после первой игры приглашённого.</i>'
    ].join('\n');

    const kb = [
        [Markup.button.url('📤 Поделиться', shareUrl)],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText(txt, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action('show_plans', async (ctx) => {
    const order = ['starter', 'creator', 'studio', 'pack3', 'campaign'];
    const rows = [
        [planButton(PLANS.starter), planButton(PLANS.creator)],
        [planButton(PLANS.studio)],
        [planButton(PLANS.pack3), planButton(PLANS.campaign)],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    const lines = [
        '💎 <b>Тарифы</b>',
        '<i>Оплата в Telegram Stars · игры начисляются сразу</i>',
        UI_DIVIDER
    ];
    for (const id of order) {
        const plan = PLANS[id];
        if (!plan) continue;
        const meta = planMeta(plan);
        const period = plan.periodDays > 0 ? ' / мес' : '';
        lines.push(`${meta.emoji} <b>${escapeHtml(meta.label)}</b> — ${meta.short} · ${plan.stars} ⭐${period}`);
    }
    lines.push(
        '',
        '<i>Starter, Creator и Studio продлеваются каждые 30 дней. Отменить автопродление можно в Telegram Stars → Подписки.</i>',
        'Нужен счёт для компании? Напиши администратору.'
    );
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
});

bot.action(/^plan_([a-z0-9_]+)$/, async (ctx) => {
    const plan = getPlan(ctx.match[1]);
    if (!plan) return ctx.answerCbQuery('Тариф не найден.', { show_alert: true });
    const meta = planMeta(plan);
    const features = plan.periodDays > 0
        ? [
            '✅ Игры начисляются сразу после оплаты',
            `✅ ${gamesLabel(plan.games)} каждый месяц`,
            '✅ Автопродление каждые 30 дней',
            '✅ Отмена в Telegram Stars → Подписки'
        ]
        : [
            '✅ Игры начисляются сразу после оплаты',
            `✅ ${gamesLabel(plan.games)} на баланс`,
            '✅ Без подписки и автосписаний'
        ];
    const txt = [
        `${meta.emoji} <b>${escapeHtml(plan.title)}</b>`,
        `<i>${escapeHtml(plan.description)}</i>`,
        UI_DIVIDER,
        ...features,
        '',
        `💰 <b>${plan.stars} ⭐</b>${plan.periodDays > 0 ? ' / 30 дней' : ''}`
    ].join('\n');
    const kb = [
        [Markup.button.callback(`💳 Оформить · ${plan.stars} ⭐`, `buy_${plan.id}`)],
        [Markup.button.callback('⬅️ Назад', 'show_plans')]
    ];
    await ctx.editMessageText(txt, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action(/^buy_(.+)$/, async (ctx) => {
    const plan = getPlan(ctx.match[1]);
    if (!plan) return ctx.answerCbQuery('Пакет не найден.', { show_alert: true });

    const user = tgUser(ctx);
    if (user.banned) return ctx.answerCbQuery('Аккаунт заблокирован.', { show_alert: true });

    const subscription = plan.periodDays > 0;
    const payload = JSON.stringify({
        planId: plan.id,
        userId: ctx.from.id,
        stars: plan.stars,
        games: plan.games,
        subscription,
        periodDays: plan.periodDays,
        ts: Date.now()
    });
    const title = `Game Factory: ${plan.title}`.slice(0, 32);
    const description = `${plan.description}. Игры начисляются сразу.`.slice(0, 255);
    const prices = [{ label: gamesLabel(plan.games), amount: plan.stars }];

    try {
        if (subscription) {
            const link = await bot.telegram.createInvoiceLink({
                title,
                description,
                payload,
                provider_token: '',
                currency: 'XTR',
                prices,
                subscription_period: plan.periodDays * 24 * 60 * 60
            });
            await ctx.editMessageText([
                `📅 <b>${escapeHtml(plan.title)}</b>`,
                `<i>${escapeHtml(plan.description)}</i>`,
                UI_DIVIDER,
                `✅ ${gamesLabel(plan.games)} начисляются сразу`,
                '✅ Автопродление каждые 30 дней',
                '✅ Отмена в Telegram Stars → Подписки',
                '',
                `💰 <b>${plan.stars} ⭐ / 30 дней</b>`
            ].join('\n'), {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('💳 Оформить подписку', link)],
                    [Markup.button.callback('⬅️ Назад', 'show_plans')]
                ])
            });
        } else {
            await ctx.replyWithInvoice({
                title,
                description,
                payload,
                provider_token: '',
                currency: 'XTR',
                prices
            }, { start_parameter: `buy_${plan.id}` });
        }
        logEvent('checkout_started', ctx.from.id, {
            planId: plan.id,
            stars: plan.stars,
            subscription
        });
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('[Платёж] Не удалось создать счёт:', error.message);
        await ctx.answerCbQuery('Не удалось создать счёт. Попробуй позже.', { show_alert: true });
    }
});

bot.on('pre_checkout_query', async (ctx) => {
    try {
        const query = ctx.preCheckoutQuery;
        const payload = JSON.parse(query.invoice_payload || '{}');
        const plan = getPlan(payload.planId);
        const buyerId = query.from ? query.from.id : ctx.from.id;
        const expectedStars = Number.isFinite(Number(payload.stars)) ? Number(payload.stars) : Number(plan && plan.stars);
        const expectedSubscription = Boolean(plan && plan.periodDays > 0);
        const valid = plan
            && Number(payload.userId) === Number(buyerId)
            && query.currency === 'XTR'
            && Number(query.total_amount) === expectedStars
            && Boolean(payload.subscription) === expectedSubscription;

        if (!valid) return ctx.answerPreCheckoutQuery(false, 'Счёт устарел. Создай новый.');
        const user = findUser(buyerId);
        if (!user || user.banned) return ctx.answerPreCheckoutQuery(false, 'Аккаунт недоступен.');
        return ctx.answerPreCheckoutQuery(true);
    } catch (error) {
        console.error('[Платёж] Ошибка pre_checkout:', error.message);
        return ctx.answerPreCheckoutQuery(false, 'Не удалось проверить платёж.');
    }
});

async function handleSuccessfulPayment(ctx, payment) {
    const chargeId = payment.telegram_payment_charge_id;
    if (!chargeId) return;

    let payload = {};
    try {
        payload = JSON.parse(payment.invoice_payload || '{}');
    } catch (error) {
        payload = {};
    }
    const plan = getPlan(payload.planId);
    const expectedStars = Number.isFinite(Number(payload.stars)) ? Number(payload.stars) : Number(plan && plan.stars);
    const expectedGames = Number.isFinite(Number(payload.games)) && Number(payload.games) > 0
        ? Math.trunc(Number(payload.games))
        : Number(plan && plan.games);
    const subscription = Boolean(plan && plan.periodDays > 0);
    const valid = plan
        && Number(payload.userId) === Number(ctx.from.id)
        && payment.currency === 'XTR'
        && Number(payment.total_amount) === expectedStars
        && Number.isSafeInteger(expectedGames) && expectedGames > 0
        && Boolean(payload.subscription) === subscription;

    if (!valid) {
        console.error('[Платёж] Несоответствие платежа:', { chargeId, payload, amount: payment.total_amount });
        logEvent('payment_failed', ctx.from.id, { chargeId, reason: 'payload_mismatch' });
        await notifyAdmins(`⚠️ Платёж не распознан: пользователь ${ctx.from.id}, charge ${chargeId}, сумма ${payment.total_amount}, payload ${payment.invoice_payload}`);
        return ctx.reply('Платёж получен, но пакет не распознан. Напиши в поддержку и приложи это сообщение.');
    }

    const expiration = Number(payment.subscription_expiration_date);
    const subscriptionUntil = Number.isFinite(expiration) && expiration > 0
        ? new Date(expiration * 1000).toISOString()
        : null;

    const result = recordPayment({
        telegramId: ctx.from.id,
        provider: 'telegram_stars',
        chargeId,
        payload: payment.invoice_payload,
        amount: payment.total_amount,
        currency: payment.currency,
        planId: plan.id,
        gamesGranted: gamesGranted({ games: expectedGames }),
        subscriptionUntil,
        subscriptionDays: subscriptionUntil ? 0 : (plan.periodDays || 0),
        raw: payment
    });

    if (result.duplicate) {
        return ctx.reply('ℹ️ Этот платёж уже учтён. Игры начислены ранее.');
    }
    if (!result.credited) {
        console.error('[Платёж] Не удалось начислить игры:', chargeId);
        logEvent('payment_failed', ctx.from.id, { chargeId, reason: 'credit_failed' });
        await notifyAdmins(`🚨 Платёж без начисления: пользователь ${ctx.from.id}, charge ${chargeId}, сумма ${payment.total_amount}`);
        return ctx.reply('Платёж получен, но игры не начислены. Напиши в поддержку, мы всё исправим.');
    }

    const user = tgUser(ctx);
    const renewal = subscription && payment.is_recurring && !payment.is_first_recurring;
    logEvent('payment_succeeded', ctx.from.id, {
        chargeId,
        planId: plan.id,
        amount: payment.total_amount,
        subscription,
        renewal
    });
    const until = user.subscriptionUntil ? new Date(user.subscriptionUntil) : null;
    const lines = [
        renewal ? '🎉 <b>Подписка продлена!</b>' : '✨ <b>Оплата получена!</b>',
        UI_DIVIDER,
        `💎 ${subscription ? 'Подписка' : 'Пакет'}: <b>${escapeHtml(plan.title)}</b>`,
        `🎮 Начислено: <b>${gamesLabel(expectedGames)}</b>`,
        `💰 Доступно: <b>${gamesLabel(userGames(user))}</b>`
    ];
    if (subscription && until && Number.isFinite(until.getTime())) {
        lines.push(`📅 Активна до <b>${until.toLocaleDateString('ru-RU')}</b>`);
    }
    const msg = lines.join('\n');

    await ctx.reply(msg, { parse_mode: 'HTML', ...getMainMenuKeyboard() });

    const paymentKind = renewal ? 'Продление подписки' : (subscription ? 'Новая подписка' : 'Новый пакет');
    await notifyAdmins(`💰 ${paymentKind}: ${plan.title}, ${payment.total_amount} Stars, пользователь ${ctx.from.id}`);
}

bot.on('message', async (ctx, next) => {
    const payment = ctx.message && ctx.message.successful_payment;
    if (!payment) return next();
    await handleSuccessfulPayment(ctx, payment);
});

bot.action('show_legal', async (ctx) => {
    const base = (WEBAPP_URL && /^https:\/\//i.test(WEBAPP_URL)) ? WEBAPP_URL : '';
    const docs = [
        ['📄 Публичная оферта', 'offer.md'],
        ['🔒 Политика конфиденциальности', 'privacy.md'],
        ['📜 Правила использования', 'rules.md'],
        ['↩️ Возвраты', 'refunds.md'],
        ['🎨 Лицензия на игры', 'license.md']
    ];
    if (!base) {
        return ctx.editMessageText(
            '📄 Документы появятся после настройки публичного HTTPS-домена (WEBAPP_URL).',
            Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'main_menu')]])
        );
    }
    const rows = docs.map(([title, file]) => [Markup.button.url(title, `${base}/legal/${file}`)]);
    rows.push([Markup.button.callback('⬅️ Назад', 'main_menu')]);
    await ctx.editMessageText([
        '📜 <b>Правила и документы</b>',
        '<i>Перед покупкой ознакомься с офертой и правилами возврата.</i>'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
});

bot.command('legal', async (ctx) => {
    const base = (WEBAPP_URL && /^https:\/\//i.test(WEBAPP_URL)) ? WEBAPP_URL : '';
    if (!base) return ctx.reply('Документы появятся после настройки публичного домена.');
    await ctx.reply(`Оферта: ${base}/legal/offer.md\nПолитика: ${base}/legal/privacy.md\nПравила: ${base}/legal/rules.md\nВозвраты: ${base}/legal/refunds.md\nЛицензия: ${base}/legal/license.md`);
});

bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const stats = getStats();
    const quality = stats.quality;
    const qualityLines = quality && quality.count
        ? [
            '',
            `Качество за ${quality.days} дней: ${quality.avgScore}/100 по ${quality.count} генерациям`,
            `Ниже 80: ${quality.lowQuality}`,
            quality.topIssues.length
                ? 'Частые замечания: ' + quality.topIssues.map((item) => `${item.code}×${item.occurrences}`).join(', ')
                : 'Частых замечаний нет',
            ...(quality.byVersion.length > 1
                ? ['Версии: ' + quality.byVersion.map((item) => `${item.version} ${item.avgScore}/100 (${item.count})`).join(', ')]
                : [])
        ]
        : ['', 'Качество: пока нет данных'];
    const ratings = stats.ratings;
    const ratingLines = ratings && ratings.votes
        ? [
            '',
            `Оценки за ${ratings.days} дней: ${ratings.votes} голосов, средняя ${ratings.avg}/5 (${ratings.ratedGames} игр)`,
            ...ratings.byGenre.slice(0, 5).map((item) => `  ${item.genre}: ${item.avg}/5 (${item.votes})`),
            ratings.bottom.length && ratings.bottom[0].avg < 4
                ? 'Худшие: ' + ratings.bottom.slice(0, 3).map((item) => `${item.title} ${item.avg}`).join(', ')
                : ''
        ].filter(Boolean)
        : [];
    await ctx.reply([
        '👑 Статистика',
        '',
        `Пользователей: ${stats.users}`,
        `Игр: ${stats.games}`,
        `Генераций: ${stats.generations}`,
        `Платежей: ${stats.payments}`,
        `Открытых жалоб: ${stats.openComplaints}`,
        ...qualityLines,
        ...ratingLines
    ].join('\n'));
});

bot.command('ratings', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const stats = getRatingStats(30);
    if (!stats.votes) return ctx.reply('👑 Оценок пока нет.');
    const lines = [
        '👑 <b>Оценки игр за 30 дней</b>',
        '',
        `Голосов: ${stats.votes}, средняя ${stats.avg}/5, игр с оценками: ${stats.ratedGames}`
    ];
    if (stats.byGenre.length) {
        lines.push('', '<b>По жанрам:</b>');
        for (const item of stats.byGenre) lines.push(`• ${item.genre}: ${item.avg}/5 (${item.votes})`);
    }
    if (stats.top.length) {
        lines.push('', '<b>Лучшие:</b>');
        for (const item of stats.top) lines.push(`• ${item.title} — ${item.avg}/5 (${item.votes})`);
    }
    if (stats.bottom.length) {
        lines.push('', '<b>Слабые места:</b>');
        for (const item of stats.bottom) lines.push(`• ${item.title} — ${item.avg}/5 (${item.votes})`);
        const weakWithPrompt = stats.bottom.filter((item) => item.prompt && Number(item.avg) < 4);
        if (weakWithPrompt.length) {
            lines.push('', '<b>Что просил игрок (связка с промптом):</b>');
            for (const item of weakWithPrompt.slice(0, 3)) {
                lines.push(`• ${escapeHtml(item.prompt.slice(0, 120))}`);
            }
        }
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

bot.command('quality', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const gameId = String(ctx.message.text || '').trim().split(/\s+/)[1];
    if (!gameId || !isSafeGameId(gameId) || !gameId.startsWith('ai_')) {
        return ctx.reply('Использование: /quality <ai_...>');
    }
    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    if (!fs.existsSync(gamePath)) return ctx.reply('Файл игры не найден.');
    let code;
    try {
        code = fs.readFileSync(gamePath, 'utf8');
    } catch (error) {
        return ctx.reply('Не удалось прочитать файл игры.');
    }
    const platform = detectPlatform(code);
    const validation = validateGameCode(code, platform);
    const audit = auditGame(code, platform);
    const criticals = validation.filter((item) => item.level === 'critical')
        .concat(audit.issues.filter((item) => item.level === 'critical'));
    const warnings = validation.filter((item) => item.level === 'warning')
        .concat(audit.issues.filter((item) => item.level === 'warning'));
    const lines = [
        `🧪 Качество ${gameId}`,
        `Технический балл: ${audit.score}/100 · платформа: ${platform}`,
        `Критично: ${criticals.length} · предупреждений: ${warnings.length}`
    ];
    if (criticals.length) {
        lines.push('', 'Критичные проблемы:');
        criticals.slice(0, 5).forEach((item) => lines.push('• ' + item.msg));
    } else {
        lines.push('', 'Критичных проблем не найдено.');
    }
    if (warnings.length) {
        lines.push('', 'Предупреждения:');
        warnings.slice(0, 5).forEach((item) => lines.push('• ' + item.msg));
    }
    await ctx.reply(lines.join('\n').slice(0, 4000));
});

bot.command('reports', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const complaints = listOpenComplaints(10);
    if (!complaints.length) return ctx.reply('✅ Открытых жалоб нет.');
    const rows = complaints.map((complaint) => {
        const title = sanitizeGameTitle(complaint.game_title, 'Игра').slice(0, 30);
        return [Markup.button.callback(`#${complaint.id} · ${title}`, `mod_view_${complaint.id}`)];
    });
    await ctx.reply(
        `🚩 <b>Открытые жалобы: ${complaints.length}</b>\nВыбери жалобу, чтобы посмотреть детали.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
    );
});

bot.command('grant', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const [, targetRaw, gamesRaw] = String(ctx.message.text || '').trim().split(/\s+/);
    const target = Number.parseInt(targetRaw, 10);
    const games = Number.parseInt(gamesRaw, 10);
    if (!Number.isSafeInteger(target) || target <= 0 || !Number.isSafeInteger(games) || games <= 0) {
        return ctx.reply('Использование: /grant <telegram_id> <количество игр>');
    }
    ensureUser(target);
    const ok = credit(target, games * COST_PER_GAME, 'admin_grant', `admin-manual:${Date.now()}:${target}`);
    await ctx.reply(ok ? `Начислено: ${gamesLabel(games)} пользователю ${target}.` : 'Не удалось начислить.');
});

bot.command('refund', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const chargeId = String(ctx.message.text || '').trim().split(/\s+/)[1];
    if (!chargeId) return ctx.reply('Использование: /refund <telegram_payment_charge_id>');
    const payment = getPaymentByChargeId(chargeId);
    if (!payment) return ctx.reply('Платёж не найден.');
    if (payment.status === 'refunded') return ctx.reply('Этот платёж уже возвращён.');

    try {
        await bot.telegram.callApi('refundStarPayment', {
            user_id: Number(payment.telegram_id),
            telegram_payment_charge_id: chargeId
        });
        const user = findUser(payment.telegram_id);
        const remove = Math.min(user ? user.balance : 0, Number(payment.games_granted) || 0);
        if (remove > 0) debit(payment.telegram_id, remove, 'refund_reversal', `refund-reversal:${chargeId}`);
        markPaymentRefunded(chargeId);
        logEvent('payment_refunded', payment.telegram_id, { chargeId, remove });
        await ctx.reply(`Возврат выполнен. Списано игр: ${gamesFromBalance(remove)}.`);
    } catch (error) {
        console.error('[Возврат] Ошибка:', error.message);
        await notifyAdmins(`🚨 Ошибка возврата ${chargeId}: ${error.message}`);
        await ctx.reply(`Не удалось выполнить возврат: ${error.message}`);
    }
});

bot.action(/^report_(ai_[0-9]{10,20})$/, async (ctx) => {
    const gameId = ctx.match[1];
    const game = getGame(gameId);
    if (!game) return ctx.answerCbQuery('❌ Игра не найдена', { show_alert: true });
    if (game.status === 'hidden') return ctx.answerCbQuery('❌ Игра уже скрыта', { show_alert: true });

    const entries = Object.entries(COMPLAINT_REASONS);
    const rows = [];
    for (let i = 0; i < entries.length; i += 2) {
        rows.push(entries.slice(i, i + 2).map(([code, label]) =>
            Markup.button.callback(label, `rr_${code}_${gameId}`)));
    }
    rows.push([Markup.button.callback('⬅️ Отмена', 'main_menu')]);

    await ctx.reply([
        '🚩 <b>Пожаловаться на игру</b>',
        UI_DIVIDER,
        'Выбери причину. Жалоба уйдёт модераторам.',
        '<i>Ложные жалобы замедляют проверку реальных нарушений.</i>'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
});

bot.action(/^rr_([a-z]+)_(ai_[0-9]{10,20})$/, async (ctx) => {
    const [, reason, gameId] = ctx.match;
    if (!Object.prototype.hasOwnProperty.call(COMPLAINT_REASONS, reason)) {
        return ctx.answerCbQuery('❌ Неизвестная причина', { show_alert: true });
    }

    if (reason === 'other') {
        const game = getGame(gameId);
        if (!game) return ctx.answerCbQuery('❌ Игра не найдена', { show_alert: true });
        if (game.status === 'hidden') return ctx.answerCbQuery('❌ Игра уже скрыта', { show_alert: true });
        ctx.session.step = 'report_details';
        ctx.session.gameData.reportGameId = gameId;
        return ctx.editMessageText([
            '✍️ <b>Опиши проблему</b>',
            UI_DIVIDER,
            'Отправь одним сообщением, что не так с игрой (до 500 символов).'
        ].join('\n'), {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Отмена', 'main_menu')]])
        });
    }

    await ctx.answerCbQuery();
    await submitComplaint(ctx, { gameId, reason, edit: true });
});

bot.action(/^mod_view_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа', { show_alert: true });
    const complaint = getComplaint(Number(ctx.match[1]));
    if (!complaint) return ctx.answerCbQuery('Жалоба не найдена', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.reply(complaintCard(complaint), {
        parse_mode: 'HTML',
        ...complaintKeyboard(complaint)
    });
});

bot.action(/^mod_hide_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа', { show_alert: true });
    const complaint = getComplaint(Number(ctx.match[1]));
    if (!complaint) return ctx.answerCbQuery('Жалоба не найдена', { show_alert: true });
    if (complaint.status !== 'open') return ctx.answerCbQuery('Жалоба уже обработана', { show_alert: true });
    if (!hideGame(complaint.game_id, ctx.from.id)) {
        return ctx.answerCbQuery('Игра уже скрыта', { show_alert: true });
    }

    logEvent('game_hidden', ctx.from.id, { gameId: complaint.game_id, complaintId: complaint.id });
    await ctx.answerCbQuery('Игра скрыта');
    const updated = getComplaint(complaint.id);
    await ctx.editMessageText(complaintCard(updated), {
        parse_mode: 'HTML',
        ...complaintKeyboard(updated)
    }).catch(() => {});

    if (updated.owner_id) {
        try {
            await bot.telegram.sendMessage(
                Number(updated.owner_id),
                '⚠️ Твоя игра скрыта модератором после жалобы. Если считаешь это ошибкой, напиши в поддержку.'
            );
        } catch (error) {}
    }
});

bot.action(/^mod_dismiss_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа', { show_alert: true });
    const complaint = getComplaint(Number(ctx.match[1]));
    if (!complaint) return ctx.answerCbQuery('Жалоба не найдена', { show_alert: true });
    if (!dismissComplaint(complaint.id, ctx.from.id)) {
        return ctx.answerCbQuery('Жалоба уже обработана', { show_alert: true });
    }

    logEvent('complaint_dismissed', ctx.from.id, { gameId: complaint.game_id, complaintId: complaint.id });
    await ctx.answerCbQuery('Жалоба отклонена');
    const updated = getComplaint(complaint.id);
    await ctx.editMessageText(complaintCard(updated), {
        parse_mode: 'HTML',
        ...complaintKeyboard(updated)
    }).catch(() => {});
});

bot.action(/^mod_restore_(\d+)_(ai_[0-9]{10,20})$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа', { show_alert: true });
    const complaint = getComplaint(Number(ctx.match[1]));
    const gameId = ctx.match[2];
    if (!complaint) return ctx.answerCbQuery('Жалоба не найдена', { show_alert: true });
    if (!restoreGame(gameId)) return ctx.answerCbQuery('Игра уже доступна', { show_alert: true });

    logEvent('game_restored', ctx.from.id, { gameId, complaintId: complaint.id });
    await ctx.answerCbQuery('Игра возвращена');
    const updated = getComplaint(complaint.id);
    await ctx.editMessageText(complaintCard(updated, {
        status: 'игра возвращена',
        note: '↩️ <b>Игра снова доступна.</b>'
    }), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([])
    }).catch(() => {});
});

bot.action('start_creation', async (ctx) => {
    ctx.session.step = 'platform';
    const kb = [
        [Markup.button.callback('📱 Мобильная', 'platform_mobile'), Markup.button.callback('💻 ПК', 'platform_pc')],
        [Markup.button.callback('⬅️ Отмена', 'main_menu')]
    ];
    await ctx.editMessageText([
        '🎮 <b>Создание игры</b>',
        `<i>Стоимость: ${gamesLabel(1)} за генерацию</i>`,
        UI_DIVIDER,
        '1️⃣ <b>Выбери платформу</b>'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action(/^platform_(mobile|pc)$/, async (ctx) => {
    ctx.session.gameData.platform = sanitizePlatform(ctx.match[1]);
    const kb = [
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble'), Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')],
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris'), Markup.button.callback('🚀 Платформер', 'engine_platformer')],
        [Markup.button.callback('🔫 Шутер', 'engine_shooter'), Markup.button.callback('✨ ИИ-Генератор', 'engine_ai')],
        [Markup.button.callback('⚡ Движок + ИИ', 'engine_hybrid'), Markup.button.callback('⬅️ Назад', 'start_creation')]
    ];
    await ctx.editMessageText([
        '2️⃣ <b>Выбери движок</b>',
        '<i>Шаблоны собираются мгновенно. ИИ — по твоему описанию.</i>',
        '',
        '⚡ <b>Движок + ИИ</b> — нейросеть придумывает мир и героев, а проверенный движок отвечает за физику и 60 FPS. Быстрее и стабильнее.'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action('engine_hybrid', async (ctx) => {
    const user = tgUser(ctx);
    if (user.banned) {
        return ctx.answerCbQuery('Аккаунт заблокирован.', { show_alert: true });
    }
    if (userGames(user) < 1) {
        return ctx.editMessageText([
            '💎 <b>Игры закончились</b>',
            UI_DIVIDER,
            'Купи пакет или пригласи друга — и продолжай создавать.'
        ].join('\n'), { parse_mode: 'HTML', ...paywallKeyboard() });
    }
    ctx.session.gameData.engine = 'hybrid';
    ctx.session.step = 'awaiting_ai_prompt';

    const kb = [
        [Markup.button.callback('🎲 Случайная идея', 'random_ai_idea')],
        [Markup.button.callback('⬅️ Назад', 'start_creation')]
    ];
    await ctx.editMessageText([
        '⚡ <b>Движок + ИИ</b>',
        `<i>Стоимость: ${gamesLabel(1)}</i>`,
        UI_DIVIDER,
        'Опиши игру — я подберу движок по жанру.',
        '',
        '<b>Пример:</b>',
        '<i>«платформер про лесного духа, который собирает светлячков»</i>',
        '',
        '<i>Сейчас движок есть для платформера; для остальных жанров соберём игру обычным ИИ-генератором.</i>'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action('engine_ai', async (ctx) => {
    const user = tgUser(ctx);
    if (user.banned) {
        return ctx.answerCbQuery('Аккаунт заблокирован.', { show_alert: true });
    }
    if (userGames(user) < 1) {
        return ctx.editMessageText([
            '💎 <b>Игры закончились</b>',
            UI_DIVIDER,
            'Купи пакет или пригласи друга — за первую игру приглашённого начислим ' +
                `<b>${gamesLabel(gamesFromBalance(REWARD_PER_REF))}</b>.`
        ].join('\n'), { parse_mode: 'HTML', ...paywallKeyboard() });
    }
    ctx.session.gameData.engine = 'ai';
    ctx.session.step = 'awaiting_ai_prompt';

    const kb = [
        [Markup.button.callback('🎲 Случайная идея', 'random_ai_idea')],
        [Markup.button.callback('⬅️ Назад', 'start_creation')]
    ];
    await ctx.editMessageText([
        '✨ <b>ИИ-Генератор</b>',
        `<i>Стоимость: ${gamesLabel(1)}</i>`,
        UI_DIVIDER,
        'Опиши игру в 1–2 предложениях.',
        '',
        '<b>Пример:</b>',
        '<i>«кот-космонавт собирает звёзды и уворачивается от астероидов»</i>'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action('random_ai_idea', async (ctx) => {
    if (ctx.session?.step !== 'awaiting_ai_prompt') {
        return ctx.answerCbQuery('Сначала выбери ИИ-Генератор.', { show_alert: true });
    }
    const idea = AI_IDEAS[Math.floor(Math.random() * AI_IDEAS.length)];
    ctx.session.step = null;
    ctx.session.gameData.lastPrompt = idea;
    await ctx.answerCbQuery('🎲 Идея выбрана').catch(() => {});
    await handleAIGeneration(ctx.chat.id, ctx.callbackQuery.message.message_id, idea, ctx);
});

bot.action(/^engine_(?!ai$|hybrid$)([a-z_]+)$/, async (ctx) => {
    const engine = sanitizeEngine(ctx.match[1], ENGINE_NAMES);
    if (!engine) return ctx.answerCbQuery('❌ Движок не найден.', { show_alert: true });
    const user = tgUser(ctx);
    if (userGames(user) < 1) {
        return ctx.editMessageText([
            '💎 <b>Игры закончились</b>',
            UI_DIVIDER,
            'Купи пакет или пригласи друга — и продолжай создавать.'
        ].join('\n'), { parse_mode: 'HTML', ...paywallKeyboard() });
    }
    ctx.session.gameData.engine = engine;
    const kb = [
        [Markup.button.callback('🌌 Звёзды', 'biome_silent_stars'), Markup.button.callback('🩸 Фэнтези', 'biome_credo_fantasy')],
        [Markup.button.callback('🍃 Лес', 'biome_ghibli_forest'), Markup.button.callback('🌃 Токио', 'biome_neon_tokyo')],
        [Markup.button.callback('⚙️ Пустошь', 'biome_wasteland')],
        [Markup.button.callback('⬅️ Назад', 'start_creation')]
    ];
    await ctx.editMessageText([
        `3️⃣ <b>Выбери стиль</b>`,
        `<i>Движок: ${escapeHtml(ENGINE_LABELS[engine] || engine)}</i>`,
        UI_DIVIDER,
        'Стиль задаёт фон, цвета и атмосферу игры.'
    ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
});

bot.action(/^biome_([a-z_]+)$/, async (ctx) => {
    const biome = sanitizeBiome(ctx.match[1], Object.keys(styles));
    if (!biome || biome !== ctx.match[1]) {
        return ctx.answerCbQuery('❌ Стиль не найден.', { show_alert: true });
    }
    ctx.session.gameData.biome = biome;
    ctx.session.step = 'awaiting_name';
    await ctx.editMessageText([
        '4️⃣ <b>Название игры</b>',
        UI_DIVIDER,
        'Напиши короткое название — оно появится в самой игре.'
    ].join('\n'), { parse_mode: 'HTML' });
});

function paywallKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('💎 Купить игры', 'show_plans')],
        [Markup.button.callback('🎁 Бесплатно за друга', 'show_referral')],
        [Markup.button.callback('🏠 Меню', 'main_menu')]
    ]);
}

async function notifyReferralReward(result) {
    if (!result || !result.rewarded) return;
    try {
        await bot.telegram.sendMessage(
            result.referrerId,
            `🎉 Твой друг создал первую игру!\n+${gamesLabel(gamesFromBalance(result.amount))} начислено.`
        );
    } catch (e) { /* пользователь мог заблокировать бота */ }
}

async function handleAIGeneration(chatId, msgId, prompt, ctx) {
    const userId = ctx.from.id;
    let completed = false;
    let createdGameId = null;
    const validation = validatePrompt(prompt);
    if (!validation.ok) {
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            `❌ ${validation.error}`,
            paywallKeyboard()
        ).catch(() => {});
    }
    const cleanPrompt = validation.value;
    ctx.session.gameData.lastPrompt = cleanPrompt;

    const user = tgUser(ctx);
    if (user.banned) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Аккаунт заблокирован.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])).catch(() => {});
    }
    if (userGames(user) < 1) {
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            `❌ Игры закончились.\n\nКупи пакет или пригласи друга — за первую игру приглашённого начислим ${gamesLabel(gamesFromBalance(REWARD_PER_REF))}.`,
            paywallKeyboard()
        ).catch(() => {});
    }
    if (!tryConsumeRateLimit(`generation:${userId}`, 1, GENERATION_COOLDOWN_MS)) {
        const seconds = Math.max(1, Math.ceil(GENERATION_COOLDOWN_MS / 1000));
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            `⏳ Подожди ${seconds} сек. перед следующей генерацией.`,
            Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])
        ).catch(() => {});
    }
    if (!tryConsumeRateLimit(`generation-day:${userId}`, MAX_GENERATIONS_PER_DAY, 24 * 60 * 60 * 1000)) {
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            '⏳ На сегодня лимит генераций исчерпан. Возвращайся завтра.',
            Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])
        ).catch(() => {});
    }

    const generationId = crypto.randomUUID();
    const platform = sanitizePlatform(ctx.session.gameData.platform);
    const charged = debit(userId, COST_PER_GAME, 'generation', `gen:${generationId}`);
    if (!charged) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Недостаточно игр на балансе.', paywallKeyboard()).catch(() => {});
    }

    const progressStates = [
        { percent: 15, text: 'Проектирование игровой архитектуры...', bar: '██░░░░░░░░' },
        { percent: 35, text: 'Генерация логики и физики...', bar: '████░░░░░░' },
        { percent: 65, text: 'Отрисовка графических элементов...', bar: '███████░░░' },
        { percent: 85, text: 'Сборка Canvas и интерфейса...', bar: '████████░░' },
        { percent: 95, text: 'Подбор атмосферного фона...', bar: '█████████░' }
    ];

    let stepIndex = 0;
    let pulse = 0;
    const progressInterval = setInterval(async () => {
        let state;
        if (stepIndex < progressStates.length) {
            state = progressStates[stepIndex];
            stepIndex++;
        } else {
            pulse++;
            state = { percent: 95, text: 'Генерация объёмного кода ' + '·'.repeat(1 + (pulse % 3)), bar: '█████████░' };
        }
        const text = [
            '⚒️ <b>Гримуар кода в работе...</b>',
            UI_DIVIDER,
            `<code>[${state.bar}]</code> <b>${state.percent}%</b>`,
            `⏳ <i>${state.text}</i>`
        ].join('\n');
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, text, { parse_mode: 'HTML' });
        } catch (e) {}
    }, 3500);

    try {
        const genre = detectGenre(cleanPrompt);
        const hybridRequested = ctx.session?.gameData?.engine === 'hybrid';
        const hybridEngine = hybrid.getEngine(genre);

        recordGeneration({
            id: generationId,
            telegramId: userId,
            prompt: cleanPrompt,
            platform,
            engine: hybridRequested && hybridEngine ? 'hybrid' : 'ai',
            status: 'running',
            model: 'gemini-2.5-flash',
            genre
        });
        logEvent('generation_started', userId, { generationId, platform, promptVersion: PROMPT_VERSION, genre });

        let planResult = { plan: '', inputTokens: 0, outputTokens: 0 };
        let gameCode = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let generatedModel = gemini.PRIMARY_MODEL;
        let generatedBgKeyword = '';
        let gameTitle = cleanPrompt;
        let usedHybrid = false;

        if (hybridRequested && hybridEngine) {
            usedHybrid = true;
            try {
                await bot.telegram.editMessageText(chatId, msgId, null, [
                    '⚙️ <b>Собираю игру на движке...</b>',
                    UI_DIVIDER,
                    '<i>Нейросеть придумывает мир, персонажей и врагов, движок отвечает за физику и 60 FPS.</i>'
                ].join('\n'), { parse_mode: 'HTML' });
            } catch (e) {}
            const specResult = await hybrid.generateSpec(cleanPrompt);
            gameCode = hybridEngine.render(specResult.spec, {});
            gameTitle = specResult.spec.title || cleanPrompt;
            totalInputTokens = specResult.usage.inputTokens;
            totalOutputTokens = specResult.usage.outputTokens;
            generatedModel = specResult.model;
            logEvent('hybrid_generated', userId, { generationId, genre, title: gameTitle });
        } else {
            planResult = await generateGamePlan(cleanPrompt, platform);
            const generated = await generateAIGame(cleanPrompt, platform, { plan: planResult.plan });
            if (!generated || !generated.code) throw new Error('Генерация оборвалась: модель не вернула полный файл');
            totalInputTokens = generated.inputTokens + planResult.inputTokens;
            totalOutputTokens = generated.outputTokens + planResult.outputTokens;
            generatedModel = generated.model;
            generatedBgKeyword = generated.bgKeyword || '';
            gameCode = generated.code;
        }

        clearInterval(progressInterval);
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, [
                '⚒️ <b>Гримуар кода в работе...</b>',
                UI_DIVIDER,
                '<code>[██████████]</code> <b>100%</b>',
                '🔍 <i>Проверяю качество кода...</i>'
            ].join('\n'), { parse_mode: 'HTML' });
        } catch (e) {}

        let quality = null;
        if (usedHybrid) {
            const audit = auditGame(gameCode, platform);
            const validation = validateGameCode(gameCode, platform).filter((issue) => !/клавиатура/i.test(issue.msg));
            quality = {
                code: gameCode,
                technicalScore: audit.score,
                criticScore: null,
                score: audit.score,
                patched: false,
                polished: false,
                issues: validation.concat(audit.issues).map((issue) => ({ level: issue.level, code: issue.code || null, msg: issue.msg })),
                issueCodes: validation.concat(audit.issues).map((issue) => issue.code || issue.msg).slice(0, 12)
            };
        } else {
            quality = await runQualityPipeline(gameCode, {
                platform,
                brief: cleanPrompt,
                plan: planResult.plan
            });
            gameCode = quality.code;
        }

        const stillCritical = quality.issues.filter((issue) => issue.level === 'critical');
        if (stillCritical.length) {
            console.error('[Валидация] Критично:', stillCritical.map((issue) => issue.msg).join(' | '));
            throw new Error('Игра не прошла валидацию: ' + stillCritical[0].msg);
        }
        if (quality.issues.length) {
            console.warn('[Качество] Замечания:', quality.issues.map((issue) => issue.msg).join(' | '));
        }
        logEvent('generation_quality', userId, {
            generationId,
            promptVersion: PROMPT_VERSION,
            score: quality.score,
            technicalScore: quality.technicalScore,
            criticScore: quality.criticScore,
            patched: quality.patched,
            polished: quality.polished,
            issues: quality.issueCodes
        });

        try {
            await bot.telegram.editMessageText(chatId, msgId, null, [
                '🎨 <b>Подбор атмосферного фона...</b>',
                UI_DIVIDER,
                '<i>Ищу подходящую атмосферу для твоего мира...</i>'
            ].join('\n'), { parse_mode: 'HTML' });
        } catch (e) {}

        let bgKeyword = generatedBgKeyword || 'fantasy landscape';
        const bgMatch = gameCode.match(/\[BG:\s*([^\]]+)\]/i);
        if (bgMatch && bgMatch[1]) {
            bgKeyword = sanitizeText(bgMatch[1], 60) || bgKeyword;
        }
        gameCode = gameCode.replace(/\[BG:\s*([^\]]+)\]/i, '').trim();

        let customBgUrl = 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop';
        customBgUrl = safeCssUrl(customBgUrl, 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop');

        try {
            const query = encodeURIComponent(bgKeyword);
            const apiKey = process.env.UNSPLASH_ACCESS_KEY || '';
            if (apiKey) {
                const unUrl = `https://api.unsplash.com/photos/random?query=${query}&orientation=landscape&client_id=${apiKey}`;
                const unRes = await axios.get(unUrl, { timeout: 15000 });
                const imgUrl = (unRes.data && unRes.data.urls) ? unRes.data.urls.regular : null;
                if (imgUrl) {
                    const fileName = `bg_ai_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
                    const filePath = path.join(uploadsDir, fileName);
                    const writer = fs.createWriteStream(filePath);
                    const imgStream = await axios({ url: imgUrl, method: 'GET', responseType: 'stream', timeout: 30000 });

                    imgStream.data.pipe(writer);
                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    customBgUrl = safeCssUrl(`/uploads/${fileName}`, customBgUrl);
                }
            }
        } catch (e) {
            console.error('Unsplash skipped:', e.message);
        }

        gameCode = gameCode.replace(/\{\{AI_BG_IMAGE\}\}/g, () => customBgUrl);

        if (!gameCode.includes(customBgUrl)) {
            const styleTag = `<style>body { background: url('${customBgUrl}') center/cover no-repeat !important; }</style>`;
            if (gameCode.includes('</head>')) {
                gameCode = gameCode.replace('</head>', '\n' + styleTag + '\n</head>');
            } else {
                gameCode = gameCode.replace(/<body/i, styleTag + '<body');
            }
        }

        const gameId = `ai_${Date.now()}${crypto.randomInt(0, 1000000)}`;
        fs.writeFileSync(path.join(aiGamesDir, `${gameId}.html`), gameCode);

        recordGame({
            id: gameId,
            telegramId: userId,
            generationId,
            title: sanitizeGameTitle(usedHybrid ? gameTitle : cleanPrompt, 'Игра'),
            source: usedHybrid ? 'hybrid' : 'ai',
            htmlPath: `${gameId}.html`
        });
        recordGeneration({
            id: generationId,
            telegramId: userId,
            prompt: cleanPrompt,
            platform,
            engine: usedHybrid ? 'hybrid' : 'ai',
            status: 'completed',
            model: generatedModel,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd: estimateCostUsd(totalInputTokens, totalOutputTokens),
            attempts: 1,
            gameId,
            genre
        });
        logEvent('generation_succeeded', userId, {
            generationId,
            gameId,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            planTokens: planResult.inputTokens + planResult.outputTokens,
            mode: usedHybrid ? 'hybrid' : 'ai',
            score: quality.score
        });
        completed = true;
        createdGameId = gameId;

        const referral = qualifyReferral(userId);
        await notifyReferralReward(referral);

        clearInterval(progressInterval);
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, [
                '⚒️ <b>Гримуар кода в работе...</b>',
                UI_DIVIDER,
                '<code>[██████████]</code> <b>100%</b>',
                '🚀 <i>Финальная компиляция...</i>'
            ].join('\n'), { parse_mode: 'HTML' });
        } catch (e) {}

        const url = publicGameUrl(gameId);
        const kb = [
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('👍 Хорошо', `rate_ai_${gameId}_5`), Markup.button.callback('👎 Плохо', `rate_ai_${gameId}_1`)]
        ];
        if (!usedHybrid) {
            kb.push([Markup.button.callback('✏️ Улучшить', `improve_ai_${gameId}`)]);
        }
        kb.push(
            [Markup.button.callback('📦 Архив', `dl_ai_${gameId}`), Markup.button.callback('🚩 Пожаловаться', `report_${gameId}`)],
            [Markup.button.callback('🔁 Перегенерировать', 'regen_ai')],
            [Markup.button.callback('💳 Купить ещё', 'show_plans')],
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        );

        const fresh = findUser(userId) || user;
        const msg = [
            '🎉 <b>Игра готова!</b>',
            UI_DIVIDER,
            `🎮 Доступно: <b>${gamesLabel(userGames(fresh))}</b>`,
            '',
            'Сыграй и нажми «✏️ Улучшить», чтобы изменить механику или сложность.'
        ].join('\n');
        await bot.telegram.editMessageText(chatId, msgId, null, msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
    } catch (err) {
        clearInterval(progressInterval);
        console.error('[Генерация]', err);
        if (completed && createdGameId) {
            try {
                const url = publicGameUrl(createdGameId);
                await bot.telegram.sendMessage(
                    chatId,
                    `✅ Игра готова: ${url}`,
                    Markup.inlineKeyboard([[Markup.button.webApp('🎮 ИГРАТЬ', url)]])
                );
            } catch (e) {}
            return;
        }
        let refunded = false;
        try {
            refunded = credit(userId, COST_PER_GAME, 'refund', `refund:${generationId}`);
        } catch (refundError) {
            console.error('[Генерация] Не удалось вернуть игру:', refundError.message);
        }
        try {
            recordGeneration({
                id: generationId,
                telegramId: userId,
                prompt: cleanPrompt,
                platform,
                engine: 'ai',
                status: 'failed',
                model: 'gemini-2.5-flash',
                error: String(err.message || 'unknown').slice(0, 500)
            });
        } catch (recordError) {
            console.error('[Генерация] Не удалось записать ошибку:', recordError.message);
        }
        logEvent('generation_failed', userId, { generationId, error: String(err.message || 'unknown').slice(0, 200) });

        const kb = [
            [Markup.button.callback('🔄 Повторить', 'regen_ai')],
            [Markup.button.callback('💳 Купить игры', 'show_plans')],
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        const refundLine = refunded ? '\nИгра не списана — баланс восстановлен.' : '';
        await bot.telegram.editMessageText(
            chatId, msgId, null,
            `❌ Не получилось собрать игру. Попробуй ещё раз или измени описание.${refundLine}`,
            Markup.inlineKeyboard(kb)
        ).catch(() => {});
    }
}

bot.action(/^improve_ai_(ai_[0-9]{10,20})$/, async (ctx) => {
    const gameId = ctx.match[1];
    if (!isSafeGameId(gameId)) return ctx.answerCbQuery('❌ Игра не найдена.', { show_alert: true });

    const game = getGame(gameId);
    if (!game || Number(game.telegram_id) !== Number(ctx.from.id)) {
        return ctx.answerCbQuery('❌ Это не твоя игра.', { show_alert: true });
    }
    if (game.status === 'hidden') {
        return ctx.answerCbQuery('❌ Игра скрыта модератором.', { show_alert: true });
    }
    if (!fs.existsSync(path.join(aiGamesDir, `${gameId}.html`))) {
        return ctx.answerCbQuery('❌ Файл игры не найден.', { show_alert: true });
    }

    const user = tgUser(ctx);
    if (user.banned) return ctx.answerCbQuery('Аккаунт заблокирован.', { show_alert: true });
    if (userGames(user) < 1) {
        return ctx.editMessageText(
            '❌ Игры закончились. Купи пакет или пригласи друга.',
            paywallKeyboard()
        ).catch(() => {});
    }

    ctx.session.step = 'awaiting_improve_prompt';
    ctx.session.gameData.improveGameId = gameId;
    await ctx.editMessageText(
        '✏️ Что улучшить в игре?\n\nНапиши одной фразой: «добавь бонусы», «сделай сложнее», «ускорь персонажа».\n\nСтоимость: 1 игра.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Отмена', 'main_menu')]])
    ).catch(() => {});
});

bot.action(/^rate_ai_(ai_[0-9]{10,20})_([1-5])$/, async (ctx) => {
    const gameId = ctx.match[1];
    const score = Number(ctx.match[2]);
    if (!isSafeGameId(gameId)) return ctx.answerCbQuery('❌ Игра не найдена.', { show_alert: true });
    const game = getGame(gameId);
    if (!game) return ctx.answerCbQuery('❌ Игра не найдена.', { show_alert: true });
    try {
        const rating = rateGame(gameId, ctx.from.id, score);
        const average = rating.avg ? ` Средняя оценка: ${rating.avg}.` : '';
        logEvent('game_rated', ctx.from.id, { gameId, rating: score });
        await ctx.answerCbQuery(score >= 4 ? `👍 Спасибо за оценку!${average}` : `👎 Учтём, сделаем лучше.${average}`);
    } catch (error) {
        console.error('[Оценка]', error.message);
        await ctx.answerCbQuery('❌ Не удалось сохранить оценку.');
    }
});

async function handleAIImprove(chatId, msgId, instruction, gameId, ctx) {
    const userId = ctx.from.id;
    const validation = validatePrompt(instruction);
    if (!validation.ok) {
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            `❌ ${validation.error}`,
            Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])
        ).catch(() => {});
    }
    const cleanInstruction = validation.value;

    const user = tgUser(ctx);
    if (user.banned) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Аккаунт заблокирован.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])).catch(() => {});
    }
    if (userGames(user) < 1) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Игры закончились. Купи пакет или пригласи друга.', paywallKeyboard()).catch(() => {});
    }
    if (!tryConsumeRateLimit(`improve:${userId}`, 1, GENERATION_COOLDOWN_MS)) {
        const seconds = Math.max(1, Math.ceil(GENERATION_COOLDOWN_MS / 1000));
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            `⏳ Подожди ${seconds} сек. перед следующим улучшением.`,
            Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])
        ).catch(() => {});
    }
    if (!tryConsumeRateLimit(`generation-day:${userId}`, MAX_GENERATIONS_PER_DAY, 24 * 60 * 60 * 1000)) {
        return bot.telegram.editMessageText(
            chatId, msgId, null,
            '⏳ На сегодня лимит генераций исчерпан. Возвращайся завтра.',
            Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])
        ).catch(() => {});
    }

    const game = getGame(gameId);
    if (!game || Number(game.telegram_id) !== Number(userId)) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Игра не найдена.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])).catch(() => {});
    }
    if (game.status === 'hidden') {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Игра скрыта модератором.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])).catch(() => {});
    }
    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    if (!fs.existsSync(gamePath)) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Файл игры не найден.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])).catch(() => {});
    }
    const originalCode = fs.readFileSync(gamePath, 'utf8');
    const platform = ctx.session?.gameData?.platform === 'mobile' ? 'mobile' : detectPlatform(originalCode);

    const generationId = crypto.randomUUID();
    const charged = debit(userId, COST_PER_GAME, 'improvement', `improve:${generationId}`);
    if (!charged) {
        return bot.telegram.editMessageText(chatId, msgId, null, '❌ Недостаточно игр на балансе.', paywallKeyboard()).catch(() => {});
    }

    const progressStates = [
        { percent: 25, text: 'Разбираю текущую механику...', bar: '███░░░░░░░' },
        { percent: 50, text: 'Вношу изменения в код...', bar: '█████░░░░░' },
        { percent: 75, text: 'Проверяю физику и управление...', bar: '███████░░░' },
        { percent: 90, text: 'Собираю обновлённую версию...', bar: '█████████░' }
    ];
    let stepIndex = 0;
    let pulse = 0;
    const progressInterval = setInterval(async () => {
        let state;
        if (stepIndex < progressStates.length) {
            state = progressStates[stepIndex];
            stepIndex++;
        } else {
            pulse++;
            state = { percent: 90, text: 'Дорабатываю детали ' + '·'.repeat(1 + (pulse % 3)), bar: '█████████░' };
        }
        const text = [
            '✏️ <b>Улучшаю игру...</b>',
            UI_DIVIDER,
            `<code>[${state.bar}]</code> <b>${state.percent}%</b>`,
            `⏳ <i>${state.text}</i>`
        ].join('\n');
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, text, { parse_mode: 'HTML' });
        } catch (e) {}
    }, 3500);

    let committed = false;
    let tmpPath = null;
    try {
        recordGeneration({
            id: generationId,
            telegramId: userId,
            prompt: `Улучшение: ${cleanInstruction}`,
            platform,
            engine: 'ai',
            status: 'running',
            model: 'gemini-2.5-flash'
        });
        logEvent('generation_started', userId, { generationId, gameId, kind: 'improve', promptVersion: PROMPT_VERSION });

        const improved = await improveAIGame(originalCode, cleanInstruction, platform);
        if (!improved || !improved.code) throw new Error('Модель не вернула полный файл');
        let gameCode = normalizeImprovedCode(improved.code, originalCode);

        clearInterval(progressInterval);
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, [
                '✏️ <b>Улучшаю игру...</b>',
                UI_DIVIDER,
                '<code>[██████████]</code> <b>100%</b>',
                '🔍 <i>Проверяю обновлённый код...</i>'
            ].join('\n'), { parse_mode: 'HTML' });
        } catch (e) {}

        let issues = validateGameCode(gameCode, platform);
        const audit = auditGame(gameCode, platform);
        const auditCriticals = audit.issues.filter(i => i.level === 'critical');
        if (auditCriticals.length) issues = issues.concat(auditCriticals);
        const criticals = issues.filter(i => i.level === 'critical');
        if (criticals.length) {
            console.error('[Улучшение] Критично:', criticals.map(i => i.msg).join(' | '));
            try {
                await bot.telegram.editMessageText(chatId, msgId, null, [
                    '🔧 <b>Автопочинка...</b>',
                    UI_DIVIDER,
                    `<i>Устраняю замечания проверки (${criticals.length})...</i>`
                ].join('\n'), { parse_mode: 'HTML' });
            } catch (e) {}
            const repaired = await repairGameCode(gameCode, issues, platform, { preserveBackground: true, originalCode });
            gameCode = normalizeImprovedCode(repaired.code, originalCode);
            issues = validateGameCode(gameCode, platform);
            const stillCritical = issues.filter(i => i.level === 'critical');
            if (stillCritical.length) throw new Error('Игра не прошла валидацию: ' + stillCritical[0].msg);
        }
        if (issues.length) console.warn('[Улучшение] Замечания:', issues.map(i => i.msg).join(' | '));
        const finalAudit = auditGame(gameCode, platform);
        if (finalAudit.issues.length) {
            console.warn('[Улучшение] Аудит:', finalAudit.issues.map(i => i.msg).join(' | '));
        }
        logEvent('improvement_quality', userId, {
            generationId,
            promptVersion: PROMPT_VERSION,
            score: finalAudit.score,
            issues: finalAudit.issues.map(i => i.code || i.msg).slice(0, 8)
        });

        tmpPath = path.join(aiGamesDir, `.${gameId}.${Date.now()}.tmp`);
        fs.writeFileSync(tmpPath, gameCode);
        fs.renameSync(tmpPath, gamePath);
        tmpPath = null;
        committed = true;

        try {
            recordGeneration({
                id: generationId,
                telegramId: userId,
                prompt: `Улучшение: ${cleanInstruction}`,
                platform,
                engine: 'ai',
                status: 'completed',
                model: improved.model,
                inputTokens: improved.inputTokens,
                outputTokens: improved.outputTokens,
                costUsd: estimateCostUsd(improved.inputTokens, improved.outputTokens),
                attempts: 1,
                gameId
            });
        } catch (recordError) {
            console.error('[Улучшение] Не удалось записать метрики:', recordError.message);
        }
        logEvent('game_improved', userId, {
            generationId,
            gameId,
            inputTokens: improved.inputTokens,
            outputTokens: improved.outputTokens
        });

        clearInterval(progressInterval);
        const url = publicGameUrl(gameId);
        const kb = [
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('✏️ Улучшить ещё', `improve_ai_${gameId}`)],
            [Markup.button.callback('📦 Архив', `dl_ai_${gameId}`), Markup.button.callback('🚩 Пожаловаться', `report_${gameId}`)],
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        const fresh = findUser(userId) || user;
        const msg = [
            '✨ <b>Игра обновлена!</b>',
            UI_DIVIDER,
            `🎮 Доступно: <b>${gamesLabel(userGames(fresh))}</b>`,
            '',
            'Можно улучшать дальше или скачать архив.'
        ].join('\n');
        await bot.telegram.editMessageText(
            chatId, msgId, null,
            msg,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) }
        ).catch(() => {});
    } catch (err) {
        clearInterval(progressInterval);
        if (tmpPath && fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (cleanupError) {}
        }
        console.error('[Улучшение]', err);

        if (committed) {
            return bot.telegram.editMessageText(
                chatId, msgId, null,
                '✅ Изменения сохранены, но не удалось завершить оформление. Открой игру заново.',
                Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'main_menu')]])
            ).catch(() => {});
        }

        let refunded = false;
        try {
            refunded = credit(userId, COST_PER_GAME, 'refund', `refund:${generationId}`);
        } catch (refundError) {
            console.error('[Улучшение] Не удалось вернуть игру:', refundError.message);
        }
        try {
            recordGeneration({
                id: generationId,
                telegramId: userId,
                prompt: `Улучшение: ${cleanInstruction}`,
                platform,
                engine: 'ai',
                status: 'failed',
                model: 'gemini-2.5-flash',
                error: String(err.message || 'unknown').slice(0, 500)
            });
        } catch (recordError) {
            console.error('[Улучшение] Не удалось записать ошибку:', recordError.message);
        }
        logEvent('generation_failed', userId, { generationId, gameId, kind: 'improve', error: String(err.message || 'unknown').slice(0, 200) });

        const kb = [
            [Markup.button.callback('🔄 Попробовать снова', `improve_ai_${gameId}`)],
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        const refundLine = refunded ? '\nИгра не списана — баланс восстановлен.' : '';
        await bot.telegram.editMessageText(
            chatId, msgId, null,
            `❌ Не получилось улучшить игру. Попробуй переформулировать.${refundLine}`,
            Markup.inlineKeyboard(kb)
        ).catch(() => {});
    }
}

bot.action('regen_ai', async (ctx) => {
    const p = ctx.session?.gameData?.lastPrompt;
    if (!p) return ctx.answerCbQuery('❌ Запрос не найден.', { show_alert: true });
    const user = tgUser(ctx);
    if (userGames(user) < 1) return ctx.answerCbQuery('❌ Игры закончились. Купи пакет или пригласи друга.', { show_alert: true });

    try {
        await ctx.editMessageText('⚒️ <b>Гримуар кода в работе...</b>\n━━━━━━━━━━━━━━\n<code>[░░░░░░░░░░]</code> <b>0%</b>\n⏳ <i>Запуск нейронных потоков...</i>', { parse_mode: 'HTML' });
    } catch (e) {}
    await handleAIGeneration(ctx.chat.id, ctx.callbackQuery.message.message_id, p, ctx);
});

bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'report_details') {
        const gameId = ctx.session.gameData.reportGameId;
        if (!gameId || !isSafeGameId(gameId)) {
            ctx.session.step = null;
            return ctx.reply('❌ Игра не найдена. Открой её заново из меню.');
        }
        if (String(ctx.message.text || '').trim().startsWith('/')) {
            return ctx.reply('Опиши проблему обычным текстом. Или нажми «Отмена».');
        }
        const details = sanitizeText(ctx.message.text, 500);
        if (!details) return ctx.reply('❌ Добавь хотя бы короткое описание.');
        ctx.session.step = null;
        ctx.session.gameData.reportGameId = null;
        await submitComplaint(ctx, { gameId, reason: 'other', details });
        return;
    }

    if (ctx.session?.step === 'awaiting_ai_prompt') {
        const validation = validatePrompt(ctx.message.text);
        if (!validation.ok) {
            return ctx.reply(`❌ ${validation.error}`);
        }
        ctx.session.step = null;
        ctx.session.gameData.lastPrompt = validation.value;
        const msg = await ctx.reply('⚒️ <b>Гримуар кода в работе...</b>\n━━━━━━━━━━━━━━\n<code>[░░░░░░░░░░]</code> <b>0%</b>\n⏳ <i>Запуск нейронных потоков...</i>', { parse_mode: 'HTML' });
        await handleAIGeneration(ctx.chat.id, msg.message_id, validation.value, ctx);
    } else if (ctx.session?.step === 'awaiting_improve_prompt') {
        const gameId = ctx.session.gameData.improveGameId;
        const rawInstruction = String(ctx.message.text || '').trim();
        if (rawInstruction.startsWith('/')) {
            return ctx.reply('Напиши, что улучшить, обычным текстом. Или нажми «Отмена» в сообщении выше.');
        }
        const validation = validatePrompt(rawInstruction);
        if (!validation.ok) {
            return ctx.reply(`❌ ${validation.error}`);
        }
        if (!gameId || !isSafeGameId(gameId)) {
            ctx.session.step = null;
            return ctx.reply('❌ Игра не найдена. Открой её заново из меню.');
        }
        ctx.session.step = null;
        ctx.session.gameData.improveGameId = null;
        const msg = await ctx.reply('✏️ <b>Улучшаю игру...</b>\n━━━━━━━━━━━━━━\n<code>[░░░░░░░░░░]</code> <b>0%</b>\n⏳ <i>Запуск нейронных потоков...</i>', { parse_mode: 'HTML' });
        await handleAIImprove(ctx.chat.id, msg.message_id, validation.value, gameId, ctx);
    } else if (ctx.session?.step === 'awaiting_name') {
        const gameName = sanitizeGameTitle(ctx.message.text, '');
        if (!gameName) {
            return ctx.reply('❌ Название не подходит. Используй буквы и цифры, до 60 символов.');
        }
        ctx.session.gameData.gameName = gameName;
        ctx.session.step = 'awaiting_bg_choice';
        const kb = [
            [Markup.button.callback('🏞 Стандартный фон', 'bg_choice_standard'), Markup.button.callback('🖼 Свой фон', 'bg_choice_custom')]
        ];
        await ctx.reply([
            '5️⃣ <b>Фон игры</b>',
            UI_DIVIDER,
            'Можно оставить атмосферный фон стиля или загрузить своё фото.'
        ].join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
    }
});

bot.action('bg_choice_standard', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') {
        ctx.session.gameData.customBgFile = null;
        ctx.session.step = null;
        await ctx.editMessageText('✅ <b>Собираю игру...</b>', { parse_mode: 'HTML' });
        await finishGameGeneration(ctx);
    }
});

bot.action('bg_choice_custom', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') {
        ctx.session.step = 'awaiting_photo';
        await ctx.editMessageText([
            '📷 <b>Отправь фото</b>',
            UI_DIVIDER,
            'Пришли картинку следующим сообщением — она станет фоном игры.'
        ].join('\n'), { parse_mode: 'HTML' });
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.session?.step !== 'awaiting_photo') return;

    const msg = await ctx.reply('⏳ Проверяю...');
    let fileName = null;
    try {
        const photos = Array.isArray(ctx.message.photo) ? ctx.message.photo : [];
        if (!photos.length) return ctx.reply('❌ Не удалось получить изображение.');
        const url = (await ctx.telegram.getFileLink(photos[photos.length - 1].file_id)).href;
        if (!(await checkImageSafety(url))) {
            ctx.session.step = null;
            return ctx.telegram.editMessageText(
                ctx.chat.id,
                msg.message_id,
                null,
                '❌ Изображение не прошло модерацию или проверка недоступна. Выбери стандартный фон.'
            );
        }

        const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
        fileName = `bg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
        const writer = fs.createWriteStream(path.join(uploadsDir, fileName));

        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            response.data.on('error', reject);
        });

        ctx.session.gameData.customBgFile = fileName;
        ctx.session.step = null;
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
        await finishGameGeneration(ctx);
    } catch (e) {
        if (fileName) {
            try { fs.unlinkSync(path.join(uploadsDir, fileName)); } catch (cleanupError) {}
            ctx.session.gameData.customBgFile = null;
        }
        console.error('[Фон] Ошибка:', e.message);
        ctx.session.step = null;
        await ctx.reply('❌ Не удалось загрузить фон. Попробуй ещё раз или выбери стандартный.');
    }
});

async function finishGameGeneration(ctx) {
    const data = ctx.session.gameData || {};
    const engine = sanitizeEngine(data.engine, ENGINE_NAMES);
    if (!engine) return ctx.reply('❌ Движок не найден. Начни создание заново.');

    const biome = sanitizeBiome(data.biome, Object.keys(styles));
    const platform = sanitizePlatform(data.platform);
    const gameName = sanitizeGameTitle(data.gameName, styles[biome].name);
    const customBg = sanitizeBgFilename(data.customBgFile);
    const bgFile = customBg && fs.existsSync(path.join(uploadsDir, customBg)) ? customBg : null;
    const bgParam = bgFile ? `&bg=${encodeURIComponent(bgFile)}` : '';
    const nameEnc = encodeURIComponent(gameName);
    const base = WEBAPP_URL || '';
    const templateGameId = `tpl_${Date.now()}_${crypto.randomInt(0, 1000000)}`;
    const build = { engine, biome, platform, gameName, customBgFile: bgFile };

    const url = `${base}/${engine}/?biome=${encodeURIComponent(biome)}&name=${nameEnc}${bgParam}&platform=${platform}`;
    const kb = [
        [Markup.button.webApp('🎮 ИГРАТЬ', url)],
        [Markup.button.callback('📦 Архив', `dl_tpl_${templateGameId}`)],
        [Markup.button.callback('💳 Купить ещё', 'show_plans')],
        [Markup.button.callback('🏠 Меню', 'main_menu')]
    ];

    const chargeRef = `template:${crypto.randomUUID()}`;
    const charged = debit(ctx.from.id, COST_PER_GAME, 'template', chargeRef);
    if (!charged) {
        return ctx.reply('❌ Игры закончились. Купи пакет или пригласи друга.', paywallKeyboard());
    }

    try {
        recordGame({
            id: templateGameId,
            telegramId: ctx.from.id,
            title: gameName,
            source: 'template',
            htmlPath: null,
            build
        });
    } catch (error) {
        try {
            credit(ctx.from.id, COST_PER_GAME, 'refund', `refund:${chargeRef}`);
        } catch (refundError) {
            console.error('[Шаблон] Не удалось вернуть игру:', refundError.message);
        }
        console.error('[Шаблон] Не удалось сохранить игру:', error.message);
        return ctx.reply('❌ Не удалось сохранить игру. Игра не списана.');
    }

    logEvent('game_created', ctx.from.id, { engine, biome, platform, source: 'template' });
    try {
        const referral = qualifyReferral(ctx.from.id);
        await notifyReferralReward(referral);
    } catch (error) {
        console.error('[Реферал] Ошибка после создания шаблона:', error.message);
    }

    const txt = [
        '🎉 <b>Игра готова!</b>',
        UI_DIVIDER,
        `🎮 <b>${escapeHtml(gameName)}</b>`,
        `🧩 ${escapeHtml(ENGINE_LABELS[engine] || engine)}`,
        `🎨 ${escapeHtml(styles[biome].name)}`,
        `📱 ${platform === 'mobile' ? 'Мобильная' : 'ПК'}`
    ].join('\n');
    await ctx.reply(txt, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
}

function buildZipBuffer(entries) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const chunks = [];
        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('warning', (error) => {
            if (error.code === 'ENOENT') {
                console.warn('[Архив] Предупреждение:', error.message);
                return;
            }
            reject(error);
        });
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        for (const entry of entries) archive.append(entry.data, { name: entry.name });
        archive.finalize().catch(reject);
    });
}

bot.action(/^dl_ai_(ai_[0-9]{10,20})$/, async (ctx) => {
    const gameId = ctx.match[1];
    if (!isSafeGameId(gameId)) return ctx.answerCbQuery('❌ Не найдено!', { show_alert: true });

    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    if (!fs.existsSync(gamePath)) return ctx.answerCbQuery('❌ Не найдено!', { show_alert: true });

    const game = getGame(gameId);
    if (!game || game.status === 'hidden') {
        return ctx.answerCbQuery('❌ Игра недоступна.', { show_alert: true });
    }
    if (Number(game.telegram_id) !== Number(ctx.from.id) && !isAdmin(ctx.from.id)) {
        return ctx.answerCbQuery('❌ Это не твоя игра.', { show_alert: true });
    }

    let html;
    try {
        html = fs.readFileSync(gamePath, 'utf8');
    } catch (error) {
        console.error('[Архив AI] Не удалось прочитать файл:', error.message);
        return ctx.answerCbQuery('❌ Не удалось прочитать игру.', { show_alert: true });
    }

    const bgMatch = html.match(/\/uploads\/(bg_ai_[0-9a-f_]+\.jpg)/);
    const bgPath = bgMatch ? path.join(uploadsDir, bgMatch[1]) : null;
    const hasBg = Boolean(bgPath && fs.existsSync(bgPath));
    const entries = [{
        name: 'index.html',
        data: hasBg ? html.replace(/\/uploads\//g, '') : html
    }];
    if (hasBg) entries.push({ name: bgMatch[1], data: fs.readFileSync(bgPath) });

    let zipBuffer = null;
    try {
        zipBuffer = await buildZipBuffer(entries);
    } catch (error) {
        console.error('[Архив AI] Не удалось собрать ZIP:', error.stack || error.message);
    }

    try {
        if (zipBuffer) {
            await ctx.replyWithDocument({ source: zipBuffer, filename: 'ai_game.zip' });
        } else {
            await ctx.replyWithDocument({ source: Buffer.from(html, 'utf8'), filename: 'index.html' });
        }
        logEvent('game_downloaded', ctx.from.id, { gameId, source: 'ai' });
    } catch (error) {
        console.error('[Архив AI] Не удалось отправить файл:', error.stack || error.message);
        await notifyAdmins(`🚨 Не удалось отправить архив ${gameId}: ${String(error.message || error).slice(0, 300)}`);
        await ctx.reply('❌ Не удалось отправить архив. Мы уже проверяем причину.').catch(() => {});
    }
});

async function sendTemplateArchive(ctx, build) {
    const engine = sanitizeEngine(build && build.engine, ENGINE_NAMES);
    if (!engine) return ctx.answerCbQuery('❌ Игра не найдена. Создай её заново.', { show_alert: true });

    const biome = sanitizeBiome(build.biome, Object.keys(styles));
    const s = styles[biome];
    const platform = sanitizePlatform(build.platform);
    const gameName = sanitizeGameTitle(build.gameName, s.name);
    const customBgFile = sanitizeBgFilename(build.customBgFile);
    const buildId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const tempDir = path.join(os.tmpdir(), `build_${buildId}`);
    const zipPath = path.join(os.tmpdir(), `game_${buildId}.zip`);
    const templateDir = path.join(__dirname, 'templates', `${engine}_core`);

    if (!fs.existsSync(templateDir)) {
        return ctx.answerCbQuery('❌ Шаблон не найден.', { show_alert: true });
    }

    try {
        fse.copySync(templateDir, tempDir);
        let finalBgPath = s.img;

        if (customBgFile) {
            const customBgPath = path.join(uploadsDir, customBgFile);
            if (fs.existsSync(customBgPath)) {
                fse.copySync(customBgPath, path.join(tempDir, 'custom_bg.jpg'));
                finalBgPath = 'custom_bg.jpg';
            }
        }

        const indexPath = path.join(tempDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');

        html = html.replace(/{{GAME_TITLE}}/g, () => gameName)
                   .replace(/{{BG_IMAGE}}/g, () => finalBgPath)
                   .replace(/{{BG_COLOR}}/g, s.bg)
                   .replace(/{{BLOCK_COLOR}}/g, s.block)
                   .replace(/{{FONT_FAMILY}}/g, s.font)
                   .replace(/{{SHADOW}}/g, s.shadow)
                   .replace(/{{LIFE_ICON}}/g, s.life)
                   .replace(/{{SCORE_ICON}}/g, s.score)
                   .replace(/{{BOOSTER_WIDE}}/g, s.b_wide)
                   .replace(/{{BOOSTER_TRIPLE}}/g, s.b_triple)
                   .replace(/{{BOOSTER_FIRE}}/g, s.b_fire)
                   .replace(/{{BOOSTER_LIGHTNING}}/g, s.b_lightning)
                   .replace(/{{PLATFORM}}/g, platform);

        fs.writeFileSync(indexPath, html);

        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(zipPath);
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(tempDir, false);
            archive.finalize();
        });

        const zipName = `${safeFilename(gameName, 'game').replace(/\.zip$/i, '')}.zip`;
        logEvent('game_downloaded', ctx.from.id, { engine, biome, platform, source: 'template' });
        await ctx.replyWithDocument({ source: zipPath, filename: zipName });
    } catch (e) {
        console.error('[Архив шаблона] Ошибка:', e.message);
        await ctx.reply('❌ Не удалось собрать архив.');
    } finally {
        if (fs.existsSync(tempDir)) {
            try { fse.removeSync(tempDir); } catch (e) {}
        }
        if (fs.existsSync(zipPath)) {
            try { fs.unlinkSync(zipPath); } catch (e) {}
        }
    }
}

bot.action(/^dl_tpl_(tpl_[0-9]{10,20}_[0-9]{1,6})$/, async (ctx) => {
    const gameId = ctx.match[1];
    if (!isSafeGameId(gameId)) return ctx.answerCbQuery('❌ Не найдено!', { show_alert: true });

    const game = getGame(gameId);
    if (!game) return ctx.answerCbQuery('❌ Игра не найдена.', { show_alert: true });
    if (Number(game.telegram_id) !== Number(ctx.from.id)) {
        return ctx.answerCbQuery('❌ Это не твоя игра.', { show_alert: true });
    }

    let build = null;
    try {
        build = game.build_json ? JSON.parse(game.build_json) : null;
    } catch (error) {
        console.error('[Архив шаблона] Некорректные данные сборки:', error.message);
    }
    if (!build) return ctx.answerCbQuery('❌ Данные игры потеряны. Создай её заново.', { show_alert: true });

    return sendTemplateArchive(ctx, build);
});

bot.action('download_source', async (ctx) => {
    const data = (ctx.session && ctx.session.gameData) || {};
    return sendTemplateArchive(ctx, data);
});

function validateConfig() {
    const errors = [];
    if (!String(process.env.BOT_TOKEN || '').trim()) errors.push('BOT_TOKEN не задан');
    if (!String(process.env.GEMINI_API_KEY || '').trim()) errors.push('GEMINI_API_KEY не задан');
    if (!/^https:\/\//i.test(WEBAPP_URL)) errors.push('WEBAPP_URL должен быть публичным HTTPS-адресом');
    if (GAMES_PUBLIC_URL && !/^https:\/\//i.test(GAMES_PUBLIC_URL)) {
        errors.push('GAMES_PUBLIC_URL должен быть HTTPS-адресом');
    }
    if (!ADMIN_IDS.length) {
        console.warn('⚠️ ADMIN_IDS не задан: команды /stats, /grant и /refund отключены.');
    }
    return errors;
}

async function start() {
    const errors = validateConfig();
    if (errors.length) {
        console.error('❌ Конфигурация не готова:\n- ' + errors.join('\n- '));
        process.exitCode = 1;
        return;
    }

    if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) {
        if (ALLOW_UNMODERATED_IMAGE_UPLOADS) {
            console.warn('⚠️ Модерация изображений отключена через ALLOW_UNMODERATED_IMAGE_UPLOADS=true');
        } else {
            console.warn('⚠️ Sightengine не настроен: загрузка своих фонов будет отклоняться.');
        }
    }

    initDb({
        file: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(DATA_DIR, 'gamefactory.db'),
        startBalance: START_FREE_GAMES * COST_PER_GAME,
        adminIds: ADMIN_IDS,
        rewardPerRef: REWARD_PER_REF,
        referralsPerMonth: envInt('REFERRALS_PER_MONTH', 10)
    });
    importLegacyUsers(path.join(__dirname, 'users.json'));

    const port = envInt('PORT', 3000);
    const server = app.listen(port, () => {
        console.log(`🌐 HTTP-сервер слушает порт ${port}`);
    });
    server.on('error', (err) => {
        console.error('❌ HTTP-сервер:', err.message);
        process.exit(1);
    });

    bot.launch().catch((err) => {
        console.error('❌ Telegram bot:', err.message);
        process.exit(1);
    });
    console.log('🤖 Бот запущен');

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`\n${signal}: остановка...`);
        try { await bot.stop(signal); } catch (e) {}
        await new Promise((resolve) => server.close(resolve));
        try { closeDb(); } catch (e) {}
        process.exit(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
    start().catch((err) => {
        console.error('❌ Запуск не удался:', err.stack || err.message);
        process.exit(1);
    });
}

module.exports = {
    app,
    bot,
    start,
    generateAIGame,
    generateGamePlan,
    buildGenerationPrompt,
    validateGameCode,
    auditGame,
    repairGameCode,
    runQualityPipeline,
    collectQualityIssues,
    PROMPT_VERSION,
    SYSTEM_INSTRUCTION,
    loadReference,
    sanitizeReference
};
