const fs = require('fs');
const path = require('path');
const gemini = require('../gemini');

const ENGINE_DIR = path.join(__dirname, 'engines');

const DEFAULT_SPEC = {
    title: 'Лесной дух',
    narration: 'Собери всех светлячков и доберись до финиша',
    palette: {
        sky: '#1b2a3a',
        deep: '#0f1722',
        ground: '#2f4a3c',
        accent: '#7fd1ff',
        danger: '#ff6b6b',
        reward: '#ffd166'
    },
    player: {
        name: 'Герой',
        color: '#7fd1ff',
        speed: 250,
        jump: 640
    },
    world: {
        length: 4200
    },
    bg: 'fantasy landscape',
    enemies: [
        { type: 'patrol', name: 'Страж', color: '#ff9f68', speed: 70, behavior: 'patrol' },
        { type: 'jumper', name: 'Прыгун', color: '#c77dff', speed: 90, behavior: 'jump' },
        { type: 'hazard', name: 'Шипы', color: '#ff6b6b', speed: 0, behavior: 'static' }
    ],
    collectible: {
        name: 'Светлячок',
        color: '#ffd166'
    }
};

const SPEC_SYSTEM = {
    parts: [{
        text: [
            'Ты — геймдизайнер и арт-директор. Ты НЕ пишешь код.',
            'Ты описываешь содержимое платформера для движка: палитру, героя, врагов, мир и цель.',
            'Верни ТОЛЬКО валидный JSON без markdown и пояснений.',
            'Схема:',
            '{',
            '  "title": "короткое название на русском",',
            '  "narration": "одна строка: что делает игрок и какова цель",',
            '  "palette": { "sky": "#hex", "deep": "#hex", "ground": "#hex", "accent": "#hex", "danger": "#hex", "reward": "#hex" },',
            '  "player": { "name": "имя героя", "color": "#hex", "speed": 180-320, "jump": 520-780 },',
            '  "world": { "length": 3000-5200 },',
            '  "bg": "2-3 english words for the background photo, e.g. neon city night",',
            '  "enemies": [',
            '    { "type": "patrol", "name": "имя", "color": "#hex", "speed": 40-110, "behavior": "patrol" },',
            '    { "type": "jumper", "name": "имя", "color": "#hex", "speed": 60-140, "behavior": "jump" },',
            '    { "type": "hazard", "name": "имя", "color": "#hex", "speed": 0, "behavior": "static" }',
            '  ],',
            '  "collectible": { "name": "имя собираемого", "color": "#hex" }',
            '}',
            'Правила: ровно 3 врага с разным поведением; палитра контрастная и атмосферная, 6 цветов; hex-цвета вида #RRGGBB.'
        ].join('\n')
    }]
};

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function pickHex(value, fallback) {
    const text = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function normalizeEnemy(raw, index) {
    const fallback = DEFAULT_SPEC.enemies[index] || DEFAULT_SPEC.enemies[0];
    const behavior = ['patrol', 'jump', 'static'].includes(String(raw && raw.behavior))
        ? String(raw.behavior)
        : fallback.behavior;
    return {
        type: String((raw && raw.type) || fallback.type).slice(0, 24),
        name: String((raw && raw.name) || fallback.name).slice(0, 24),
        color: pickHex(raw && raw.color, fallback.color),
        speed: behavior === 'static' ? 0 : clampNumber(raw && raw.speed, 30, 160, fallback.speed),
        behavior
    };
}

function normalizeSpec(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const palette = data.palette || {};
    const player = data.player || {};
    const world = data.world || {};
    const collectible = data.collectible || {};
    const enemies = Array.isArray(data.enemies) && data.enemies.length
        ? data.enemies.slice(0, 3).map(normalizeEnemy)
        : DEFAULT_SPEC.enemies.map((enemy) => Object.assign({}, enemy));

    while (enemies.length < 3) {
        const fallback = DEFAULT_SPEC.enemies[enemies.length];
        enemies.push(Object.assign({}, fallback));
    }

    return {
        title: String(data.title || DEFAULT_SPEC.title).slice(0, 40),
        narration: String(data.narration || DEFAULT_SPEC.narration).slice(0, 160),
        palette: {
            sky: pickHex(palette.sky, DEFAULT_SPEC.palette.sky),
            deep: pickHex(palette.deep, DEFAULT_SPEC.palette.deep),
            ground: pickHex(palette.ground, DEFAULT_SPEC.palette.ground),
            accent: pickHex(palette.accent, DEFAULT_SPEC.palette.accent),
            danger: pickHex(palette.danger, DEFAULT_SPEC.palette.danger),
            reward: pickHex(palette.reward, DEFAULT_SPEC.palette.reward)
        },
        player: {
            name: String(player.name || DEFAULT_SPEC.player.name).slice(0, 24),
            color: pickHex(player.color, DEFAULT_SPEC.palette.accent),
            speed: clampNumber(player.speed, 170, 330, DEFAULT_SPEC.player.speed),
            jump: clampNumber(player.jump, 520, 800, DEFAULT_SPEC.player.jump)
        },
        world: {
            length: Math.round(clampNumber(world.length, 2600, 5600, DEFAULT_SPEC.world.length))
        },
        bg: String(data.bg || DEFAULT_SPEC.bg).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || DEFAULT_SPEC.bg,
        enemies,
        collectible: {
            name: String(collectible.name || DEFAULT_SPEC.collectible.name).slice(0, 24),
            color: pickHex(collectible.color, DEFAULT_SPEC.palette.reward)
        }
    };
}

async function generateSpec(prompt, options = {}) {
    const result = await gemini.generateJson({
        systemInstruction: SPEC_SYSTEM,
        contents: [{ role: 'user', parts: [{ text: 'Идея игры: ' + String(prompt || '') }] }],
        generationConfig: { temperature: 0.8, topK: 40, topP: 0.95, maxOutputTokens: 2000 },
        timeout: options.timeout || 120000
    });
    return {
        spec: normalizeSpec(result.data),
        usage: result.usage,
        model: result.model,
        fallbackUsed: result.fallbackUsed
    };
}

function loadEngineTemplate(name) {
    const file = path.join(ENGINE_DIR, `${name}.html`);
    return fs.readFileSync(file, 'utf8');
}

function renderPlatformer(spec, options = {}) {
    const template = loadEngineTemplate('platformer');
    const backgroundUrl = String(options.backgroundUrl || '').trim();
    const bgStyle = backgroundUrl
        ? `background: #05070d url('${backgroundUrl}') center/cover no-repeat;`
        : "background: #05070d url('{{AI_BG_IMAGE}}') center/cover no-repeat;";
    return template
        .replace('{{SPEC_JSON}}', JSON.stringify(spec))
        .replace('{{TITLE}}', String(spec.title || 'Игра').replace(/[<>&]/g, ''))
        .replace('{{BG_STYLE}}', bgStyle)
        .replace('{{BG_LINE}}', '[BG: ' + (spec.bg || DEFAULT_SPEC.bg) + ']');
}

const ENGINE_BY_GENRE = {
    platformer: { id: 'platformer', title: 'Платформер', render: renderPlatformer }
};

function getEngine(genre) {
    return ENGINE_BY_GENRE[genre] || null;
}

function supportsGenre(genre) {
    return Boolean(ENGINE_BY_GENRE[genre]);
}

module.exports = {
    DEFAULT_SPEC,
    SPEC_SYSTEM,
    normalizeSpec,
    generateSpec,
    renderPlatformer,
    getEngine,
    supportsGenre
};
