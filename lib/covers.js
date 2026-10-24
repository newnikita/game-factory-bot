const { escapeHtml } = require('./security');
const { detectGenre } = require('./game-design');

const PALETTES = [
    { bg1: '#0b1030', bg2: '#1b2a6b', accent: '#7c8cff', glow: '#39d3c4' },
    { bg1: '#120818', bg2: '#3a1050', accent: '#ff6bd6', glow: '#ffd166' },
    { bg1: '#061a1f', bg2: '#0c3b3a', accent: '#2ee6a8', glow: '#9bffcf' },
    { bg1: '#1a0b06', bg2: '#4a1d0c', accent: '#ff8a3d', glow: '#ffd166' },
    { bg1: '#0a0a12', bg2: '#23233f', accent: '#f5f7ff', glow: '#9aa3d4' },
    { bg1: '#001018', bg2: '#003347', accent: '#38bdf8', glow: '#a5f3fc' }
];

const GENRE_LABELS = {
    defense: 'Оборона базы',
    runner: 'Раннер',
    shooter: 'Шутер',
    platformer: 'Платформер',
    breaker: 'Арканоид',
    puzzle: 'Головоломка',
    arcade: 'Аркада',
    racing: 'Гонка'
};

function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function wrapTitle(title, maxChars = 18, maxLines = 2) {
    const words = String(title || 'Игра').trim().split(/\s+/).filter(Boolean).slice(0, 14);
    if (!words.length) words.push('Игра');
    const lines = [];
    let current = '';
    let index = 0;
    for (; index < words.length; index += 1) {
        const word = words[index];
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxChars || !current) {
            current = candidate;
            continue;
        }
        lines.push(current);
        current = word;
        if (lines.length === maxLines - 1) break;
    }
    if (current) lines.push(current);
    if (index < words.length - 1 && lines.length) {
        lines[lines.length - 1] = `${lines[lines.length - 1]}…`;
    }
    return lines.slice(0, maxLines);
}

function emblem(genre, accent, glow, random) {
    const rotate = Math.round((random() - 0.5) * 24);
    const shapes = {
        defense: '<path d="M0 -70 L62 -42 L54 22 L0 70 L-54 22 L-62 -42 Z" fill="none" stroke="AC" stroke-width="10"/><path d="M0 -34 L0 30" stroke="GL" stroke-width="8"/>',
        runner: '<path d="M-62 -34 L-10 -34 L-40 0 L-10 34 L-62 34" fill="none" stroke="AC" stroke-width="10"/><path d="M10 -34 L62 -34 L32 0 L62 34 L10 34" fill="none" stroke="GL" stroke-width="10"/>',
        shooter: '<circle r="62" fill="none" stroke="AC" stroke-width="9"/><circle r="26" fill="none" stroke="GL" stroke-width="7"/><path d="M0 -82 V-48 M0 48 V82 M-82 0 H-48 M48 0 H82" stroke="AC" stroke-width="8"/>',
        platformer: '<rect x="-70" y="30" width="60" height="18" rx="6" fill="AC"/><rect x="-24" y="2" width="60" height="18" rx="6" fill="GL"/><rect x="22" y="-26" width="60" height="18" rx="6" fill="AC"/><circle cx="48" cy="-48" r="12" fill="GL"/>',
        breaker: '<g fill="AC"><rect x="-72" y="-54" width="42" height="22" rx="5"/><rect x="-22" y="-54" width="42" height="22" rx="5"/><rect x="28" y="-54" width="42" height="22" rx="5"/></g><g fill="GL"><rect x="-72" y="-24" width="42" height="22" rx="5"/><rect x="28" y="-24" width="42" height="22" rx="5"/></g><rect x="-30" y="54" width="60" height="12" rx="6" fill="AC"/>',
        puzzle: '<g fill="AC"><rect x="-70" y="-70" width="52" height="52" rx="12"/><rect x="6" y="-70" width="52" height="52" rx="12"/></g><g fill="GL"><rect x="-70" y="6" width="52" height="52" rx="12"/><rect x="6" y="6" width="52" height="52" rx="12"/></g>',
        arcade: '<path d="M0 -78 L22 -24 L80 -22 L34 14 L50 74 L0 40 L-50 74 L-34 14 L-80 -22 L-22 -24 Z" fill="none" stroke="AC" stroke-width="9"/><circle r="16" fill="GL"/>',
        racing: '<path d="M-80 -34 H18 M-80 0 H38 M-80 34 H18" stroke="AC" stroke-width="10"/><path d="M46 -44 L86 0 L46 44 Z" fill="GL"/>'
    };
    const shape = (shapes[genre] || shapes.arcade)
        .replace(/AC/g, accent)
        .replace(/GL/g, glow);
    return `<g transform="translate(940 300) rotate(${rotate})" opacity=".95">${shape}</g>`;
}

function renderCoverSvg(game) {
    const id = String((game && game.id) || 'game');
    const title = String((game && game.title) || 'Игра');
    const genre = detectGenre(title);
    const seed = hashString(id);
    const palette = PALETTES[seed % PALETTES.length];
    const random = seeded(seed);
    const lines = wrapTitle(title);
    const label = GENRE_LABELS[genre] || 'Игра';
    const safeTitle = escapeHtml(title);
    const textLines = lines.map((line, index) => {
        const y = 430 + index * 74;
        return `<text x="72" y="${y}" fill="#ffffff" font-size="66" font-weight="800" letter-spacing="-1">${escapeHtml(line)}</text>`;
    }).join('');
    const stars = Array.from({ length: 26 }, () => {
        const x = Math.round(random() * 1200);
        const y = Math.round(random() * 630);
        const r = (0.8 + random() * 2.2).toFixed(1);
        const opacity = (0.15 + random() * 0.45).toFixed(2);
        return `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${opacity}"/>`;
    }).join('');
    const orbs = Array.from({ length: 4 }, () => {
        const cx = Math.round(120 + random() * 960);
        const cy = Math.round(80 + random() * 470);
        const r = Math.round(80 + random() * 180);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${random() > 0.5 ? palette.accent : palette.glow}" opacity=".06"/>`;
    }).join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${safeTitle}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${palette.bg1}"/>
    <stop offset="1" stop-color="${palette.bg2}"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.78" cy="0.38" r="0.62">
    <stop offset="0" stop-color="${palette.accent}" stop-opacity=".42"/>
    <stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity=".55"/>
  </linearGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0V48" fill="none" stroke="#ffffff" stroke-opacity=".05"/>
  </pattern>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#glow)"/>
<rect width="1200" height="630" fill="url(#grid)"/>
${stars}
${orbs}
<path d="M0 470 L180 360 L340 470 L520 330 L700 470 L900 380 L1080 470 L1200 410 V630 H0 Z" fill="${palette.bg1}" opacity=".75"/>
<path d="M0 540 L220 450 L420 540 L640 440 L860 540 L1060 470 L1200 540 V630 H0 Z" fill="#000000" opacity=".45"/>
<rect width="1200" height="630" fill="url(#fade)"/>
${emblem(genre, palette.accent, palette.glow, random)}
<text x="72" y="96" fill="${palette.accent}" font-size="24" font-weight="700" letter-spacing="4">ФАБРИКА ИГР</text>
<text x="72" y="140" fill="#ffffff" fill-opacity=".62" font-size="22" letter-spacing="2">${escapeHtml(label.toUpperCase())}</text>
${textLines}
<rect x="72" y="${430 + lines.length * 74 - 22}" width="86" height="8" rx="4" fill="${palette.glow}"/>
<text x="72" y="596" fill="#ffffff" fill-opacity=".66" font-size="24">Игра сообщества · играй в браузере</text>
</svg>`;
}

module.exports = {
    PALETTES,
    GENRE_LABELS,
    renderCoverSvg,
    wrapTitle,
    hashString
};
