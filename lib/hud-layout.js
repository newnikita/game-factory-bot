// Статическая проверка HUD: элемент управления, накрытый панелью (или наоборот).
// Vision-критик видит это только на скриншоте, в проде проверки кадра нет.

const VIEWPORT = { width: 390, height: 844 };
const HUD_PATTERN = /hud|status|top[\s_-]?bar|score[\s_-]?bar|info[\s_-]?bar/i;
const POSITIONED = /absolute|fixed/i;
const MIN_OVERLAP_PX = 8;

function parseDeclarations(body) {
    const declarations = {};
    const withoutComments = String(body || '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const chunk of withoutComments.split(';')) {
        const index = chunk.indexOf(':');
        if (index < 0) continue;
        const property = chunk.slice(0, index).trim().toLowerCase();
        const value = chunk.slice(index + 1).trim();
        if (property) declarations[property] = value;
    }
    return declarations;
}

function parseLength(value) {
    const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(String(value || '').trim());
    return match ? Number(match[1]) : null;
}

function parseRules(code) {
    const rules = [];
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleRe.exec(String(code || ''))) !== null) {
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let ruleMatch;
        while ((ruleMatch = ruleRe.exec(styleMatch[1])) !== null) {
            const selectors = ruleMatch[1].split(',').map((item) => item.trim()).filter(Boolean);
            const declarations = parseDeclarations(ruleMatch[2]);
            for (const selector of selectors) {
                if (!/^[#.]?[a-zA-Z][\w-]*$/.test(selector)) continue;
                rules.push({ selector, declarations });
            }
        }
    }
    return rules;
}

function selectorKey(selector) {
    if (selector.startsWith('#')) return { type: 'id', name: selector.slice(1) };
    if (selector.startsWith('.')) return { type: 'class', name: selector.slice(1) };
    return { type: 'tag', name: selector.toLowerCase() };
}

function elementRect(declarations) {
    const position = String(declarations.position || '');
    if (!POSITIONED.test(position)) return null;
    const top = parseLength(declarations.top);
    if (top === null) return null;
    const left = parseLength(declarations.left);
    const right = parseLength(declarations.right);
    const width = parseLength(declarations.width);
    let start = null;
    let end = null;
    if (left !== null && right !== null) {
        start = left;
        end = VIEWPORT.width - right;
    } else if (left !== null && width !== null) {
        start = left;
        end = left + width;
    } else if (right !== null && width !== null) {
        start = VIEWPORT.width - right - width;
        end = VIEWPORT.width - right;
    }
    if (start === null || end === null) return null;
    const height = parseLength(declarations.height);
    return {
        top,
        bottom: top + (height === null ? 40 : height),
        start,
        end,
        hasBackground: Boolean(declarations.background || declarations['background-color'] || declarations.border)
    };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function innerHtmlOf(html, id) {
    const openRe = new RegExp(`<([a-zA-Z][\\w-]*)[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>`, 'i');
    const open = openRe.exec(String(html || ''));
    if (!open) return '';
    const tag = open[1];
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = open.index + open[0].length;
    let depth = 1;
    let match;
    while ((match = tagRe.exec(String(html || ''))) !== null) {
        if (match[1] === '/') {
            depth -= 1;
            if (depth === 0) return String(html).slice(open.index + open[0].length, match.index);
        } else if (!/\/>$/.test(match[0])) {
            depth += 1;
        }
    }
    return '';
}

function collectElements(code) {
    const elements = new Map();
    for (const rule of parseRules(code)) {
        const key = selectorKey(rule.selector);
        if (!elements.has(rule.selector)) {
            elements.set(rule.selector, { selector: rule.selector, key, declarations: {}, rect: null });
        }
        const element = elements.get(rule.selector);
        Object.assign(element.declarations, rule.declarations);
    }
    const list = [...elements.values()];
    for (const element of list) {
        element.rect = elementRect(element.declarations);
        element.isHud = HUD_PATTERN.test(element.selector.replace(/^[#.]/, ''));
    }
    return list;
}

function auditHudLayout(code) {
    const elements = collectElements(code).filter((element) => element.rect);
    const issues = [];

    const hud = elements.find((element) => element.isHud && element.rect.top < VIEWPORT.height * 0.35);
    if (!hud) return { issues };

    const hudInner = hud.key.type === 'id' ? innerHtmlOf(code, hud.key.name) : '';
    for (const element of elements) {
        if (element === hud) continue;
        if (!element.rect.hasBackground) continue;
        if (element.key.type === 'id' && hudInner.includes(`id="${element.key.name}"`)) continue;
        if (element.key.type === 'class' && hudInner.includes(`"${element.key.name}`)) continue;

        const verticalOverlap = Math.min(hud.rect.bottom, element.rect.bottom) - Math.max(hud.rect.top, element.rect.top);
        if (verticalOverlap <= 0) continue;
        const horizontalOverlap = Math.min(hud.rect.end, element.rect.end) - Math.max(hud.rect.start, element.rect.start);
        if (horizontalOverlap < MIN_OVERLAP_PX) continue;

        issues.push({
            code: 'hud_overlap',
            level: 'warning',
            msg: `элемент «${element.selector}» перекрывает панель «${hud.selector}» на ${Math.round(horizontalOverlap)} px — подпись HUD не читается под ним`,
            fix: 'разведи элементы по вертикали: панель HUD и кнопки управления не должны стоять в одной строке, сдвинь кнопку вниз или вбок и оставь между ними зазор 8-12 px'
        });
    }

    return { issues, hud: hud.selector };
}

module.exports = { auditHudLayout };
