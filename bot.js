require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const express = require('express');
const fse = require('fs-extra');
const axios = require('axios');
const vm = require('vm');
const { runtimeDryRun } = require('./runtime_check');

process.on('uncaughtException', (err) => console.error('❌ Ошибка:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Ошибка сети:', err.message));

const dbPath = path.join(__dirname, 'users.json');
let usersDb = {};
const ADMIN_ID = 123456789; // Впиши сюда свой ID

if (fs.existsSync(dbPath)) {
    usersDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

function saveDb() {
    fs.writeFileSync(dbPath, JSON.stringify(usersDb, null, 2));
}

function getUser(id) {
    if (!usersDb[id]) {
        usersDb[id] = { balance: 100, referrals: 0, referredBy: null };
        saveDb();
    }
    if (id == ADMIN_ID || (process.env.ADMIN_ID && id == process.env.ADMIN_ID)) {
        if (usersDb[id].balance < 1000000) {
            usersDb[id].balance = 1000000;
            saveDb();
        }
    }
    return usersDb[id];
}

const COST_PER_GAME = 25;
const REWARD_PER_REF = 100;

const bot = new Telegraf(process.env.BOT_TOKEN);
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
    try {
        if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) return true;
        const response = await axios.get('https://api.sightengine.com/1.0/check.json', {
            params: {
                'url': imageUrl,
                'models': 'nudity-2.0',
                'api_user': process.env.SIGHT_USER,
                'api_secret': process.env.SIGHT_SECRET
            }
        });
        return !(response.data.status === 'success' && response.data.nudity.none < 0.8);
    } catch (e) {
        return true;
    }
}

const REFERENCE_BY_GENRE = {
    shooter: 'shooter.html',
    platformer: 'platformer.html',
    breaker: 'breaker.html'
};

function fallbackPlan(userPrompt, platform) {
    const text = String(userPrompt || '').toLowerCase();
    let genre = 'arcade';
    if (/(шутер|стрел|зомб|пул |оружи|выживан|отстрел|снайпер)/.test(text)) genre = 'shooter';
    else if (/(прыж|платформ|паркур|беж|скач)/.test(text)) genre = 'platformer';
    else if (/(арканоид|брейк|кирпич|отскок)/.test(text)) genre = 'breaker';
    else if (/(змейк|snake|червяк)/.test(text)) genre = 'snake';
    else if (/(гонк|авто|машин|рейс|racing)/.test(text)) genre = 'racing';
    else if (/(match|три в ряд|в ряд|матч)/.test(text)) genre = 'match3';
    else if (/(пазл|головолом|логическ)/.test(text)) genre = 'puzzle';
    else if (/(карт|пасьянс|покер|дурак|блэкджек)/.test(text)) genre = 'cards';
    const trimmed = String(userPrompt || '').trim();
    return {
        genre,
        title: trimmed.split(/\s+/).slice(0, 4).join(' ').slice(0, 50) || 'Новая игра',
        coreLoop: trimmed || 'аркада на canvas',
        mechanics: [],
        entities: [],
        controls: platform === 'mobile' ? 'касания (touch)' : 'клавиатура и/или мышь',
        win: 'набрать как можно больше очков',
        lose: 'потерять все жизни или допустить проигрыш',
        theme: 'по описанию пользователя',
        bgKeyword: 'abstract game background',
        reference: REFERENCE_BY_GENRE[genre] || null,
        fallback: true
    };
}

function parsePlanJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    if (t.indexOf('```') !== -1) {
        t = t.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        const obj = JSON.parse(t.slice(start, end + 1));
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
    } catch (e) { return null; }
}

function normalizePlan(raw, userPrompt, platform) {
    const fb = fallbackPlan(userPrompt, platform);
    if (!raw || typeof raw !== 'object') return fb;
    const str = (v, d, max) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max || 300) : d;
    const list = (v) => Array.isArray(v)
        ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 100)).slice(0, 8)
        : [];
    const genre = str(raw.genre, fb.genre, 30).toLowerCase();
    const bg = str(raw.bgKeyword || raw.bg_keyword, fb.bgKeyword, 60).replace(/[^a-zA-Z0-9 \-]/g, '').trim();
    return {
        genre,
        title: str(raw.title, fb.title, 60),
        coreLoop: str(raw.coreLoop || raw.core_loop, fb.coreLoop, 300),
        mechanics: list(raw.mechanics),
        entities: list(raw.entities),
        controls: str(raw.controls, fb.controls, 200),
        win: str(raw.win, fb.win, 200),
        lose: str(raw.lose, fb.lose, 200),
        theme: str(raw.theme, fb.theme, 100),
        bgKeyword: bg || fb.bgKeyword,
        reference: REFERENCE_BY_GENRE[genre] || null,
        fallback: false
    };
}

async function planGameRequest(userPrompt, platform, maxRetries = 2) {
    if (!process.env.GEMINI_API_KEY) return fallbackPlan(userPrompt, platform);
    const controlsHint = platform === 'mobile'
        ? 'мобильная платформа: управление через касания (touch), без клавиатуры и мыши'
        : 'ПК: управление клавиатурой и/или мышью';
    const planPrompt = [
        'Ты — гейм-дизайнер. Составь точное ТЗ для HTML5 Canvas игры по идее пользователя.',
        'Правила:',
        '- Источник истины — описание пользователя. НЕ выдумывай жанры и механики, которых там нет.',
        '- Пропущенные детали (название, условия победы/поражения) заполни минимальными разумными умолчаниями в духе описания.',
        '- Язык полей — язык описания пользователя; кроме bgKeyword — всегда английский.',
        '- Учёт платформы: ' + controlsHint + '.',
        '- genre — одно слово латиницей: shooter, platformer, breaker, snake, match3, racing, puzzle, cards, arcade или other.',
        '',
        'Верни СТРОГО один JSON-объект без пояснений:',
        '{',
        ' "genre": "...",',
        ' "title": "название до 4 слов",',
        ' "coreLoop": "одно предложение: чем игрок занимается постоянно",',
        ' "mechanics": ["механика из описания", "..."],',
        ' "entities": ["игрок", "объекты из описания"],',
        ' "controls": "как управлять по платформе",',
        ' "win": "цель или условие победы",',
        ' "lose": "условие проигрыша",',
        ' "theme": "визуальная тема в 2-3 слова",',
        ' "bgKeyword": "2-3 english words for background"',
        '}',
        '',
        'Описание пользователя:',
        '"""' + String(userPrompt || '') + '"""'
    ].join('\n');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(
                `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`,
                {
                    systemInstruction: { parts: [{ text: 'Отвечай только валидным JSON, без markdown и пояснений.' }] },
                    contents: [{ role: 'user', parts: [{ text: planPrompt }] }],
                    safetySettings: SAFETY_SETTINGS,
                    generationConfig: { temperature: 0.2, topK: 40, topP: 0.9, maxOutputTokens: 2048, responseMimeType: 'application/json' }
                },
                { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
            );
            const text = (response.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
            const parsed = parsePlanJson(text);
            if (parsed) return normalizePlan(parsed, userPrompt, platform);
            throw new Error('невалидный JSON плана');
        } catch (e) {
            console.error(`[План] Попытка ${attempt} не удалась:`, e.message);
        }
    }
    return fallbackPlan(userPrompt, platform);
}

function buildGamePrompt(userPrompt, platform, plan) {
    const controlsPrompt = platform === 'mobile' ? CONTROLS_MOBILE : CONTROLS_PC;
    const p = plan || fallbackPlan(userPrompt, platform);
    const lines = [];

    lines.push('=== ТЗ НА ИГРУ — СТРОГО СЛЕДУЙ ЭТОМУ ===');
    lines.push('Жанр: ' + p.genre);
    lines.push('Название: ' + p.title);
    lines.push('Ядро геймплея: ' + p.coreLoop);
    if (p.mechanics && p.mechanics.length) lines.push('Обязательные механики: ' + p.mechanics.join('; '));
    if (p.entities && p.entities.length) lines.push('Объекты игры: ' + p.entities.join('; '));
    lines.push('Управление: ' + p.controls);
    lines.push('Условие победы/цели: ' + p.win);
    lines.push('Условие поражения: ' + p.lose);
    lines.push('Визуальная тема: ' + p.theme);
    lines.push('=== КОНЕЦ ТЗ ===');
    lines.push('');

    if (p.reference) {
        const referenceCode = loadReference(p.reference);
        if (referenceCode) {
            lines.push(
                `=== ЭТАЛОН КОДА (${p.reference}) — ДЛЯ СПРАВКИ ПО МЕХАНИКЕ КОДА ===`,
                referenceCode,
                '=== КОНЕЦ ЭТАЛОНА ===',
                '',
                '⚠️ ПОСТОРОННИЙ КОД В ЭТАЛОНЕ НЕ ПЕРЕНОСИ: Yandex SDK (YaGames), localStorage, словари i18n, экран загрузки и getElementById("loading-screen"), HTML-элементы <button>.',
                'Копируй из эталона ТОЛЬКО: игровой цикл requestAnimationFrame, физику и коллизии, отрисовку на Canvas и структуру состояний (меню/игра/пауза/game over/рестарт).',
                'ЖАНР И МЕХАНИКИ ОПРЕДЕЛЯЕТ ТЗ, А НЕ ЭТАЛОН — при конфликте делай строго по ТЗ.',
                ''
            );
        }
    } else {
        lines.push('Эталон кода для этого жанра не задан: придумай механику самостоятельно, но СТРОГО по ТЗ выше.', '');
    }

    const styleGuide = loadStyleGuide();
    if (styleGuide) {
        lines.push(
            '=== ГАЙД ВИЗУАЛЬНЫХ ТЕХНИК — ИСПОЛЬЗУЙ ЭТИ ПРИЁМЫ В СВОЕЙ ИГРЕ ===',
            styleGuide,
            '=== КОНЕЦ ГАЙДА ===',
            ''
        );
    }

    lines.push('ПРАВИЛА УПРАВЛЕНИЯ: ' + controlsPrompt, '');
    lines.push('Исходная идея пользователя (дословно, высший приоритет): ' + userPrompt);
    return lines.join('\n');
}

const CONTROLS_MOBILE = "▶ УПРАВЛЕНИЕ ДЛЯ МОБИЛЬНЫХ: ИСКЛЮЧИТЕЛЬНО touch-события (или pointer-события). ЗАПРЕЩЕНЫ мышь и клавиатура. ЗАПРЕЩЕНЫ HTML-кнопки. Используй e.preventDefault().";
const CONTROLS_PC = "▶ УПРАВЛЕНИЕ ДЛЯ ПК: Стандартное управление с клавиатуры или клики мышью. ЗАПРЕЩЕНЫ touch-события.";

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

const SYSTEM_INSTRUCTION = {
    parts: [{
        text: [
            "Ты — профессиональный разработчик браузерных игр на HTML5 Canvas.",
            "Отвечай ТОЛЬКО полным кодом одного самодостаточного HTML-файла: от <!DOCTYPE html> до </html>. Запрещены markdown-блоки, пояснения и комментарии в коде.",
            "ГЛАВНОЕ: игра обязана ТОЧНО соответствовать ТЗ из пользовательского промпта — жанр, механики, сущности, управление и условия победы/поражения берутся из ТЗ. Эталон кода (если приложен) — только образец качества и структуры, НЕ источник жанра: если ТЗ говорит о другом жанре, делай по ТЗ.",
            "АБСОЛЮТНЫЕ ПРАВИЛА:",
            "1. Игра запускается мгновенно. Запрещены экраны загрузки, прелоадеры и обращения к элементу loading-screen.",
            "2. Всё в одном файле: CSS в <style>, JS в <script>. Запрещены внешние <script src>, библиотеки, движки, шрифты по ссылкам, картинки и аудиофайлы по URL.",
            "3. Графика процедурная, на Canvas, и она должна быть красивой: градиенты (createLinearGradient/createRadialGradient), свечение (shadowBlur/shadowColor), скругления (roundRect), тени, полупрозрачные слои. Пиксель-арт из массивов — допустим, но не обязателен. КАК ЕДИНСТВЕННЫЙ способ рисовать объекты ЗАПРЕЩЕНЫ плоские одноцветные прямоугольники.",
            "4. Запрещены localStorage, Яндекс SDK (YaGames), лидерборды, словари локализаций i18n и HTML-элементы <button>. Меню, кнопки и HUD рисуй на самом canvas либо через div-оверлеи с обработкой ввода по координатам.",
            "5. Обязательные состояния: Меню (старт) → Игра → Пауза → Game Over → Рестарт. Экраны меню и Game Over стилизуй: крупный заголовок с градиентом или свечением, акцентная кнопка, счёт крупно.",
            "6. Ресайз: обрабатывай изменение размера окна, игра корректно заполняет экран и на ПК, и на телефоне.",
            "7. В CSS тела обязателен дословно этот фон: background: url('{{AI_BG_IMAGE}}') center/cover no-repeat;",
            "8. Перед </html> добавь ровно одну строку вида [BG: два-три англ слова для фона], например [BG: space nebula].",
            "",
            "ВИЗУАЛЬНОЕ КАЧЕСТВО — обязательные требования, игра НЕ ДОЛЖНА выглядеть прототипом:",
            "A. Тёмная подложка поверх фотофона: CSS body::after { content:''; position:fixed; inset:0; background:rgba(3,5,15,0.55); pointer-events:none; } или непрозрачный слой rgba(0,0,0,0.35-0.6) в начале отрисовки кадра. Без неё фон конфликтует с графикой и текст не читается.",
            "B. Единая палитра: максимум 2-3 акцентных цвета + нейтральный тёмный фон. Цвета персонажей, эффектов и HUD — из одной палитры, подобранные под фон.",
            "C. Частицы обязательно: система частиц {x,y,vx,vy,life} с затуханием alpha — минимум при двух событиях (попадание/взрыв и сбор предмета или смерть врага). Рисуй их аддитивно: globalCompositeOperation='lighter'.",
            "D. Свечение ключевых объектов (игрок, снаряды, бонусы) через shadowBlur+shadowColor.",
            "E. Динамика: тряска экрана при уроне (translate на пару px с затуханием), белая/акцентная вспышка при попадании, score-попапы (+10 всплывает и улетает).",
            "F. Фон живой: параллакс минимум в 2 слоя или анимированные фоновые частицы (звёзды, искры). Статичная картинка без движения запрещена.",
            "G. Плавность: движение через delta time (секунды) или lerp, без рывков по кадрам; UI появляется с плавным изменением alpha.",
            "H. Аудио опционально: короткие процедурные звуки через WebAudio (осциллятор), только после первого жеста пользователя и в try/catch. Если сомневаешься — лучше тишина, чем битый звук.",
            "В гайде визуальных техник ниже есть готовые реализации всех этих приёмов — адаптируй их под свою игру."
        ].join('\n')
    }]
};

function stripCodeMarkers(text) {
    const marker = String.fromCharCode(96, 96, 96);
    let out = text.replace(new RegExp(marker + 'html', 'gi'), '');
    out = out.replace(new RegExp(marker, 'g'), '');
    return out.trim();
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

let styleGuideCache = null;
function loadStyleGuide() {
    if (styleGuideCache !== null) return styleGuideCache;
    const guidePath = path.join(__dirname, 'references', 'style_guide.html');
    styleGuideCache = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
    return styleGuideCache;
}

const RR_POLYFILL = '<script>/*__RR_POLYFILL__*/(function(){try{if(typeof CanvasRenderingContext2D!=="undefined"&&!CanvasRenderingContext2D.prototype.roundRect){CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,r){r=Number(r);if(!isFinite(r)||r<0)r=0;r=Math.min(r,Math.abs(w)/2,Math.abs(h)/2);this.moveTo(x+r,y);this.arcTo(x+w,y,x+w,y+h,r);this.arcTo(x+w,y+h,x,y+h,r);this.arcTo(x,y+h,x,y,r);this.arcTo(x,y,x+w,y,r);this.closePath();return this;};}}catch(e){}})();</script>';

function injectCompat(html) {
    if (typeof html !== 'string' || !html) return html;
    if (html.includes('__RR_POLYFILL') || /prototype\.roundRect\s*=/.test(html)) return html;
    const m = html.match(/<script(\s[^>]*)?>/i);
    if (m && typeof m.index === 'number') {
        return html.slice(0, m.index) + RR_POLYFILL + '\n' + html.slice(m.index);
    }
    if (html.includes('</head>')) return html.replace('</head>', RR_POLYFILL + '\n</head>');
    return RR_POLYFILL + '\n' + html;
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

    const crash = runtimeDryRun(code);
    if (crash) critical('игра падает при запуске: ' + crash);

    return issues;
}

async function repairGameCode(code, issues, platform) {
    const controlsPrompt = platform === 'mobile' ? CONTROLS_MOBILE : CONTROLS_PC;
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
            "- В CSS тела оставь дословно: background: url('{{AI_BG_IMAGE}}') center/cover no-repeat;",
            '- Перед </html> добавь строку [BG: два-три англ слова для фона].',
            '- Управление: ' + controlsPrompt,
            '',
            'КОД ИГРЫ:',
            current
        ].join('\n');
        try {
            const response = await axios.post(
                `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`,
                {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
                    safetySettings: SAFETY_SETTINGS,
                    generationConfig: { temperature: 0.3, topK: 40, topP: 0.9, maxOutputTokens: 65536 }
                },
                { headers: { 'Content-Type': 'application/json' }, timeout: 300000 }
            );
            const text = (response.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
            const repaired = stripCodeMarkers(text);
            if (!repaired || !/<\/html>/i.test(repaired)) continue;
            current = repaired;
            currentIssues = validateGameCode(current, platform);
            if (!currentIssues.some(i => i.level === 'critical')) break;
        } catch (e) {
            console.error(`[Авторемонт] Раунд ${round} не удался:`, e.message);
        }
    }
    return { code: current, issues: currentIssues };
}

async function generateAIGame(userPrompt, platform = 'pc', maxRetries = 5, plan = null) {
    try {
        if (!process.env.GEMINI_API_KEY) throw new Error('Ключ Gemini не настроен');

        if (!plan) plan = await planGameRequest(userPrompt, platform);
        const fullPrompt = buildGamePrompt(userPrompt, platform, plan);

        const url = `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`;
        let fullCode = '';
        let history = [{ role: 'user', parts: [{ text: fullPrompt }] }];
        let isFinished = false;

        for (let chunk = 0; chunk < 5 && !isFinished; chunk++) {
            let attemptSuccess = false;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const payload = {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        contents: history,
                        safetySettings: SAFETY_SETTINGS,
                        generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 65536 }
                    };
                    const response = await axios.post(url, payload, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 300000
                    });
                    const chunkText = (response.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
                    if (!chunkText) throw new Error('Пустой ответ модели');
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
                    if (err.response && (err.response.status === 503 || err.response.status === 429)) {
                        if (attempt === maxRetries) throw err;
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                    throw err;
                }
            }
            if (!attemptSuccess) break;
        }

        if (!isFinished) return null;
        return stripCodeMarkers(fullCode);
    } catch (e) {
        console.error('[Генерация] Ошибка:', e.message);
        return null;
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Фабрика Игр: Статус OK'));
app.get('/sdk.js', (req, res) => res.send('console.log("Mock SDK loaded");'));

const uploadsDir = path.join(__dirname, 'uploads');
const aiGamesDir = path.join(__dirname, 'ai_games');
const referencesDir = path.join(__dirname, 'references');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(aiGamesDir)) fs.mkdirSync(aiGamesDir);
if (!fs.existsSync(referencesDir)) fs.mkdirSync(referencesDir);

app.use('/uploads', express.static(uploadsDir));
app.use('/ai_games', express.static(aiGamesDir));

app.get('/:engine/', (req, res, next) => {
    const engine = req.params.engine;
    if (['ai_games', 'uploads', 'references'].includes(engine)) return next();
    
    const biome = req.query.biome || 'silent_stars';
    const s = styles[biome] || styles['silent_stars'];
    const platform = req.query.platform || 'pc';
    const indexPath = path.join(__dirname, 'templates', `${engine}_core`, 'index.html');
    
    if (!fs.existsSync(indexPath)) return res.status(404).send("<h2>⚙️ Движок в разработке.</h2>");
    
    let html = fs.readFileSync(indexPath, 'utf8');
    const customBg = req.query.bg ? `/uploads/${req.query.bg}` : s.img;
    const gameName = req.query.name || s.name;
    
    html = html.replace(/{{GAME_TITLE}}/g, gameName)
               .replace(/{{BG_IMAGE}}/g, customBg)
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

    html = injectCompat(html);
    validateGameCode(html, platform).filter(i => i.level === 'critical')
        .forEach(i => console.warn(`[Шаблон ${engine}] critical: ${i.msg}`));
    res.send(html);
});

app.use('/:engine', (req, res, next) => {
    const dir = path.join(__dirname, 'templates', `${req.params.engine}_core`);
    if (fs.existsSync(dir)) express.static(dir)(req, res, next); else next();
});

app.listen(PORT, () => console.log(`[Сервер] Запущен на порту ${PORT}`));

function getMainMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🎮 Создать игру', 'start_creation')],
        [Markup.button.callback('👤 Мой профиль / Баланс', 'show_profile')],
        [Markup.button.callback('👥 Пригласить друга', 'show_referral')],
        [Markup.button.url('🌐 Наше сообщество', 'https://t.me/your_community_link')]
    ]);
}

bot.start(async (ctx) => {
    ctx.session.gameData = {}; 
    ctx.session.step = null;
    const userId = ctx.from.id; 
    const refId = ctx.payload;
    const user = getUser(userId);
    
    if (!usersDb[userId] && refId && refId != userId && usersDb[refId]) {
        user.referredBy = refId; 
        usersDb[refId].balance += REWARD_PER_REF; 
        usersDb[refId].referrals += 1; 
        saveDb();
        try { 
            await bot.telegram.sendMessage(refId, `🎉 Зарегистрировался новый демиург!\n+${REWARD_PER_REF} 🪙`); 
        } catch (e) {}
    }
    const txt = `🌌 Добро пожаловать!\n\nГенерация стоит ${COST_PER_GAME} 🪙. На счету ${user.balance} 🪙!`;
    return ctx.reply(txt, getMainMenuKeyboard());
});

bot.action('main_menu', async (ctx) => {
    ctx.session.gameData = {}; 
    ctx.session.step = null;
    try { 
        await ctx.editMessageText('🌌 Главное меню:', getMainMenuKeyboard()); 
    } catch(e) { 
        await ctx.reply('🌌 Главное меню:', getMainMenuKeyboard()); 
    }
});

bot.action('show_profile', async (ctx) => {
    const user = getUser(ctx.from.id);
    const bal = user.balance >= 1000000 ? `**БЕСКОНЕЧНОСТЬ 👑**` : `**${user.balance} 🪙**`;
    const genCount = Math.floor(user.balance / COST_PER_GAME);
    const txt = `👤 **Профиль**\n\n🆔 ID: \`${ctx.from.id}\`\n🪙 Баланс: ${bal}\n🕹️ Генераций: **${genCount}**\n👥 Друзей: **${user.referrals}**`;
    
    const kb = [[Markup.button.callback('⬅️ Назад', 'main_menu')]];
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action('show_referral', async (ctx) => {
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    const txt = `👥 **Реферальная программа**\n\nЗа 1 друга: **+${REWARD_PER_REF} 🪙**\nСсылка:\n\`${link}\``;
    
    const kb = [[Markup.button.callback('⬅️ Назад', 'main_menu')]];
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action('start_creation', async (ctx) => {
    ctx.session.step = 'platform';
    const kb = [
        [Markup.button.callback('📱 Мобильная', 'platform_mobile')],
        [Markup.button.callback('💻 ПК', 'platform_pc')],
        [Markup.button.callback('⬅️ Отмена', 'main_menu')]
    ];
    await ctx.editMessageText('Выбери платформу:', Markup.inlineKeyboard(kb));
});

bot.action(/platform_(.+)/, async (ctx) => {
    ctx.session.gameData.platform = ctx.match[1];
    const kb = [
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')],
        [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')],
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris')],
        [Markup.button.callback('🚀 Платформер', 'engine_platformer')],
        [Markup.button.callback('🔫 Шутер', 'engine_shooter')],
        [Markup.button.callback('✨ ИИ-Генератор', 'engine_ai')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText('Выбери движок:', Markup.inlineKeyboard(kb));
});

bot.action('engine_ai', async (ctx) => {
    if (getUser(ctx.from.id).balance < COST_PER_GAME) {
        const kb = [
            [Markup.button.callback('👥 Пригласить', 'show_referral')], 
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        return ctx.editMessageText('❌ Мало токенов!', Markup.inlineKeyboard(kb));
    }
    ctx.session.gameData.engine = 'ai'; 
    ctx.session.step = 'awaiting_ai_prompt';
    
    const kb = [[Markup.button.callback('🏠 Меню', 'main_menu')]];
    await ctx.editMessageText(`✨ Опиши свою игру в 1-2 предложениях.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action(/engine_(?!ai)(.+)/, async (ctx) => {
    ctx.session.gameData.engine = ctx.match[1];
    const kb = [
        [Markup.button.callback('🌌 Звезды', 'biome_silent_stars')],
        [Markup.button.callback('🩸 Фэнтези', 'biome_credo_fantasy')],
        [Markup.button.callback('🍃 Лес', 'biome_ghibli_forest')],
        [Markup.button.callback('🌃 Токио', 'biome_neon_tokyo')],
        [Markup.button.callback('⚙️ Пустошь', 'biome_wasteland')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText('Выбери визуальный шаблон:', Markup.inlineKeyboard(kb));
});

bot.action(/biome_(.+)/, async (ctx) => {
    ctx.session.gameData.biome = ctx.match[1]; 
    ctx.session.step = 'awaiting_name';
    await ctx.editMessageText('Придумай название для игры:');
});

async function handleAIGeneration(chatId, msgId, prompt, ctx) {
    const user = getUser(ctx.from.id);
    user.balance -= COST_PER_GAME; 
    saveDb();

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
        const text = `⚒️ **Гримуар кода в работе...**\n\n\`[${state.bar}]\` **${state.percent}%**\n⏳ _${state.text}_`;
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, text, { parse_mode: 'Markdown' });
        } catch (e) {}
    }, 3500);
    
    try {
        const platform = ctx.session.gameData.platform || 'pc';

        let plan = (ctx.session.gameData.lastPlan && ctx.session.gameData.lastPrompt === prompt)
            ? ctx.session.gameData.lastPlan
            : null;
        if (!plan) {
            try {
                await bot.telegram.editMessageText(chatId, msgId, null, '🔍 **Разбираю идею по пунктам...**\n\n`[█░░░░░░░░░]` **10%**', { parse_mode: 'Markdown' });
            } catch (e) {}
            plan = await planGameRequest(prompt, platform);
            ctx.session.gameData.lastPlan = plan;
        }
        console.log(`[План] жанр=${plan.genre} эталон=${plan.reference || 'нет'} fallback=${plan.fallback ? 'да' : 'нет'} title="${plan.title}"`);

        let gameCode = await generateAIGame(prompt, platform, 5, plan);
        if (!gameCode) throw new Error('Генерация оборвалась: модель не вернула полный файл');

        clearInterval(progressInterval);
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, '`[██████████]` **100%**\n🔍 _Проверяю качество кода..._', { parse_mode: 'Markdown' });
        } catch (e) {}

        let issues = validateGameCode(gameCode, platform);
        const criticals = issues.filter(i => i.level === 'critical');
        if (criticals.length) {
            console.error('[Валидация] Критично:', criticals.map(i => i.msg).join(' | '));
            try {
                await bot.telegram.editMessageText(chatId, msgId, null, `🔧 **Автопочинка...**\n\n_Устраняю замечания проверки (${criticals.length})..._`, { parse_mode: 'Markdown' });
            } catch (e) {}
            const repaired = await repairGameCode(gameCode, issues, platform);
            gameCode = repaired.code;
            issues = repaired.issues;
            const stillCritical = issues.filter(i => i.level === 'critical');
            if (stillCritical.length) throw new Error('Игра не прошла валидацию: ' + stillCritical[0].msg);
        }
        if (issues.length) console.warn('[Валидация] Замечания:', issues.map(i => i.msg).join(' | '));

        try {
            await bot.telegram.editMessageText(chatId, msgId, null, '🎨 **Подбор атмосферного фона...**', { parse_mode: 'Markdown' });
        } catch (e) {}

        // Вытаскиваем ключевое слово
        let bgKeyword = plan.bgKeyword || 'fantasy landscape';
        const bgMatch = gameCode.match(/\[BG:\s*([^\]]+)\]/i);
        if (bgMatch && bgMatch[1]) {
            bgKeyword = bgMatch[1].trim();
        }

        // Очищаем код от тега, чтобы он не ломал Flexbox
        gameCode = gameCode.replace(/\[BG:\s*([^\]]+)\]/i, '').trim();
        
        // Дефолтный фон на случай сбоя Unsplash 
        let customBgUrl = 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop'; 

        try {
            const query = encodeURIComponent(bgKeyword);
            const apiKey = process.env.UNSPLASH_ACCESS_KEY || '';
            const unUrl = `https://api.unsplash.com/photos/random?query=${query}&orientation=landscape&client_id=${apiKey}`;
            const unRes = await axios.get(unUrl);
            
            const imgUrl = (unRes.data && unRes.data.urls) ? unRes.data.urls.regular : null;
            if (imgUrl) {
                const fileName = `bg_ai_${Date.now()}.jpg`;
                const filePath = path.join(uploadsDir, fileName);
                const writer = fs.createWriteStream(filePath);
                
                const imgStream = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
                imgStream.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
                
                customBgUrl = `/uploads/${fileName}`;
            }
        } catch (e) {
            console.error("Unsplash skipped:", e.message);
        }

        // Стандартная замена плейсхолдера
        gameCode = gameCode.replace(/\{\{AI_BG_IMAGE\}\}/g, customBgUrl);
        
        // ЖЕЛЕЗОБЕТОННАЯ СТРАХОВКА:
        // Если ИИ удалил плейсхолдер и написал пустые кавычки, ссылка не вставится.
        // Проверяем: если итоговой ссылки нет в коде — насильно инжектим стиль фона.
        if (!gameCode.includes(customBgUrl)) {
            const styleTag = `<style>body { background: url('${customBgUrl}') center/cover no-repeat !important; }</style>`;
            if (gameCode.includes('</head>')) {
                gameCode = gameCode.replace('</head>', '\n' + styleTag + '\n</head>');
            } else {
                gameCode = gameCode.replace(/<body/i, styleTag + '<body');
            }
        }

        gameCode = injectCompat(gameCode);
        
        const gameId = `ai_${Date.now()}`;
        fs.writeFileSync(path.join(aiGamesDir, `${gameId}.html`), gameCode);
        
        clearInterval(progressInterval);
        
        try {
            await bot.telegram.editMessageText(chatId, msgId, null, `⚒️ **Гримуар кода в работе...**\n\n\`[██████████]\` **100%**\n✅ _Финальная компиляция..._`, { parse_mode: 'Markdown' });
        } catch(e) {}

        const url = `${process.env.WEBAPP_URL}/ai_games/${gameId}.html`;
        const kb = [
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('📦 Архив', `dl_ai_${gameId}`)],
            [Markup.button.callback('🔁 Перегенерировать', 'regen_ai')],
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        
        const msg = `✅ Проект успешно собран!\n💳 Остаток: ${user.balance} 🪙`;
        await bot.telegram.editMessageText(chatId, msgId, null, msg, Markup.inlineKeyboard(kb));
        
    } catch (err) {
        clearInterval(progressInterval);
        console.error(err);
        user.balance += COST_PER_GAME; 
        saveDb();
        const kb = [
            [Markup.button.callback('🔄 Повторить', 'regen_ai')], 
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        await bot.telegram.editMessageText(chatId, msgId, null, '❌ Ошибка генерации. Магия прервалась.', Markup.inlineKeyboard(kb));
    }
}

bot.action('regen_ai', async (ctx) => {
    const p = ctx.session?.gameData?.lastPrompt;
    if (!p) return ctx.answerCbQuery('❌ Запрос не найден.', { show_alert: true });
    if (getUser(ctx.from.id).balance < COST_PER_GAME) return ctx.answerCbQuery('❌ Мало токенов!', { show_alert: true });
    
    await ctx.editMessageText('⚒️ **Гримуар кода в работе...**\n\n`[░░░░░░░░░░]` **0%**\n⏳ _Запуск нейронных потоков..._', { parse_mode: 'Markdown' });
    handleAIGeneration(ctx.chat.id, ctx.callbackQuery.message.message_id, p, ctx);
});

bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'awaiting_ai_prompt') {
        ctx.session.step = null; 
        ctx.session.gameData.lastPrompt = ctx.message.text;
        ctx.session.gameData.lastPlan = null;
        const msg = await ctx.reply('⚒️ **Гримуар кода в работе...**\n\n`[░░░░░░░░░░]` **0%**\n⏳ _Запуск нейронных потоков..._', { parse_mode: 'Markdown' });
        handleAIGeneration(ctx.chat.id, msg.message_id, ctx.message.text, ctx);
    } else if (ctx.session?.step === 'awaiting_name') {
        ctx.session.gameData.gameName = ctx.message.text; 
        ctx.session.step = 'awaiting_bg_choice';
        const kb = [
            [Markup.button.callback('🏞 Оставить как есть', 'bg_choice_standard')], 
            [Markup.button.callback('🖼 Своя картинка', 'bg_choice_custom')]
        ];
        await ctx.reply(`Фон?`, Markup.inlineKeyboard(kb));
    }
});

bot.action('bg_choice_standard', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') { 
        ctx.session.gameData.customBgFile = null; 
        ctx.session.step = null; 
        await ctx.editMessageText('✅ Собираю...'); 
        finishGameGeneration(ctx); 
    }
});

bot.action('bg_choice_custom', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') { 
        ctx.session.step = 'awaiting_photo'; 
        await ctx.editMessageText('Отправь фото 🖼️'); 
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.session?.step === 'awaiting_photo') {
        const msg = await ctx.reply('⏳ Проверяю...');
        try {
            const url = (await ctx.telegram.getFileLink(ctx.message.photo.pop().file_id)).href;
            if (!(await checkImageSafety(url))) {
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '🔞 Отклонено.');
            }
            const fileName = `bg_${Date.now()}.jpg`; 
            const writer = fs.createWriteStream(path.join(uploadsDir, fileName));
            const response = await axios({ url, method: 'GET', responseType: 'stream' });
            
            response.data.pipe(writer);
            writer.on('finish', () => { 
                ctx.session.gameData.customBgFile = fileName; 
                ctx.session.step = null; 
                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); 
                finishGameGeneration(ctx); 
            });
        } catch (e) { 
            ctx.reply('❌ Ошибка.'); 
        }
    }
});

async function finishGameGeneration(ctx) {
    const data = ctx.session.gameData;
    const bgParam = data.customBgFile ? `&bg=${data.customBgFile}` : '';
    const platform = data.platform || 'pc';
    const nameEnc = encodeURIComponent(data.gameName);
    
    const url = `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}&name=${nameEnc}${bgParam}&platform=${platform}`;
    const kb = [
        [Markup.button.webApp('🎮 ИГРАТЬ', url)], 
        [Markup.button.callback('📦 Архив', 'download_source')], 
        [Markup.button.callback('🏠 Меню', 'main_menu')]
    ];
    await ctx.reply(`✅ Игра "${data.gameName}" готова!`, Markup.inlineKeyboard(kb));
}

bot.action(/dl_ai_(.+)/, async (ctx) => {
    const gameId = ctx.match[1];
    const zipPath = path.join(os.tmpdir(), `${gameId}.zip`);
    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    
    if (!fs.existsSync(gamePath)) return ctx.answerCbQuery('❌ Не найдено!', { show_alert: true });
    
    try {
        let html = injectCompat(fs.readFileSync(gamePath, 'utf8'));
        const bgMatch = html.match(/\/uploads\/(bg_ai_\d+\.jpg)/);
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(zipPath);
        
        output.on('close', async () => { 
            await ctx.replyWithDocument({ source: zipPath, filename: `ai_game.zip` }); 
            fs.unlinkSync(zipPath); 
        });
        archive.pipe(output);
        
        if (bgMatch && fs.existsSync(path.join(uploadsDir, bgMatch[1]))) {
            archive.file(path.join(uploadsDir, bgMatch[1]), { name: bgMatch[1] });
            archive.append(html.replace(/\/uploads\//g, ''), { name: 'index.html' });
        } else {
            archive.append(html, { name: 'index.html' });
        }
        archive.finalize();
    } catch (e) { 
        ctx.reply('❌ Ошибка.'); 
    }
});

bot.action('download_source', async (ctx) => {
    const data = ctx.session.gameData; 
    const s = styles[data.biome]; 
    const tempDir = path.join(os.tmpdir(), `build_${Date.now()}`); 
    const zipPath = path.join(os.tmpdir(), `game_${data.engine}.zip`);
    
    try {
        fse.copySync(path.join(__dirname, 'templates', `${data.engine}_core`), tempDir);
        let finalBgPath = s.img;
        
        if (data.customBgFile) { 
            fse.copySync(path.join(uploadsDir, data.customBgFile), path.join(tempDir, 'custom_bg.jpg')); 
            finalBgPath = 'custom_bg.jpg'; 
        }
        
        const indexPath = path.join(tempDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        
        html = html.replace(/{{GAME_TITLE}}/g, data.gameName || s.name)
                   .replace(/{{BG_IMAGE}}/g, finalBgPath)
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
                   .replace(/{{PLATFORM}}/g, data.platform || 'pc');

        html = injectCompat(html);
        validateGameCode(html, data.platform || 'pc').filter(i => i.level === 'critical')
            .forEach(i => console.warn(`[ZIP ${data.engine}] critical: ${i.msg}`));
        fs.writeFileSync(indexPath, html);
        const archive = archiver('zip', { zlib: { level: 9 } }); 
        const output = fs.createWriteStream(zipPath);
        
        output.on('close', async () => { 
            await ctx.replyWithDocument({ source: zipPath, filename: `${data.gameName}.zip` }); 
            fse.removeSync(tempDir); 
            fs.unlinkSync(zipPath); 
        });
        archive.pipe(output); 
        archive.directory(tempDir, false); 
        archive.finalize();
    } catch (e) { 
        ctx.reply('❌ Ошибка сборки.'); 
    }
});

if (require.main === module) {
    bot.launch();
}

module.exports = {
    generateAIGame,
    validateGameCode,
    repairGameCode,
    loadReference,
    sanitizeReference,
    buildGamePrompt,
    fallbackPlan,
    planGameRequest,
    parsePlanJson,
    normalizePlan,
    injectCompat
};
