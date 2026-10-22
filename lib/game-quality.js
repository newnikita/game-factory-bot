const OVERLAY_SELECTOR = /(overlay|\bmenu\b|start)/i;

function lineOf(code, index) {
    return String(code).slice(0, index).split('\n').length;
}

function extractCssRules(code) {
    const rules = new Map();
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleRe.exec(code)) !== null) {
        const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let ruleMatch;
        while ((ruleMatch = ruleRe.exec(css)) !== null) {
            const body = ruleMatch[2];
            for (const selector of ruleMatch[1].split(',')) {
                const key = selector.trim();
                if (!key) continue;
                rules.set(key, (rules.get(key) || '') + ';' + body);
            }
        }
    }
    return rules;
}

function selectorExistsInHtml(code, selector) {
    const idMatch = selector.match(/#([A-Za-z0-9_-]+)/);
    if (idMatch) {
        return new RegExp(`id\\s*=\\s*["']${idMatch[1]}["']`, 'i').test(code);
    }
    const classMatch = selector.match(/\.([A-Za-z0-9_-]+)/);
    if (classMatch) {
        return new RegExp(`class\\s*=\\s*["'][^"']*\\b${classMatch[1]}\\b[^"']*["']`, 'i').test(code);
    }
    return false;
}

function hasInputHandler(code, platform) {
    const scoped = /(?:querySelector(?:All)?\s*\(\s*['"][^'"]*(?:overlay|menu|start|btn|button)[^'"]*['"]\s*\)|getElementById\s*\(\s*['"][^'"]*(?:overlay|menu|start|btn|button)[^'"]*['"]\s*\))[\s\S]{0,240}?addEventListener/i.test(code);
    const element = /(?:overlay|menu|start\w*|btn\w*|button\w*)\s*\.\s*addEventListener/i.test(code);
    const propertyHandler = /(?:overlay|menu|start\w*|btn\w*|button\w*)\s*\.\s*(?:onclick|ontouchstart|onpointerdown|onmousedown)\s*=/i.test(code);
    const inline = /<(?:div|section|span|a|p)[^>]*(?:id|class)=["'][^"']*(?:overlay|menu|start|btn)[^"']*["'][^>]*onclick=/i.test(code);
    const globalPointer = platform === 'mobile'
        ? /(?:document|window)\.addEventListener\s*\(\s*['"](?:pointerdown|touchstart|click)/i.test(code)
        : /(?:document|window)\.addEventListener\s*\(\s*['"](?:pointerdown|mousedown|click|keydown|touchstart)/i.test(code);
    return scoped || element || propertyHandler || inline || globalPointer;
}

function findBlockingOverlay(code, platform) {
    if (!/<canvas[\s>]/i.test(code)) return null;
    const rules = extractCssRules(code);
    for (const [selector, body] of rules) {
        if (!OVERLAY_SELECTOR.test(selector)) continue;
        if (!selectorExistsInHtml(code, selector)) continue;
        const positioned = /position\s*:\s*(absolute|fixed)/i.test(body);
        const coversScreen = /inset\s*:\s*0/i.test(body)
            || (/width\s*:\s*100%/i.test(body) && /height\s*:\s*(100%|100vh)/i.test(body));
        if (!positioned || !coversScreen) continue;
        if (/pointer-events\s*:\s*none/i.test(body)) continue;
        if (hasInputHandler(code, platform)) continue;
        return {
            level: 'critical',
            code: 'overlay_blocking',
            msg: `полноэкранный оверлей ${selector} перекрывает canvas, но не имеет pointer-events:none и своего обработчика ввода — кнопка старта может не нажиматься`
        };
    }

    const inlineRe = /<(div|section)[^>]*(?:id|class)=["'][^"']*(?:overlay|menu|start)[^"']*["'][^>]*style=["']([^"']*)["'][^>]*>/gi;
    let inlineMatch;
    while ((inlineMatch = inlineRe.exec(code)) !== null) {
        const style = inlineMatch[2];
        const positioned = /position\s*:\s*(absolute|fixed)/i.test(style);
        const coversScreen = /inset\s*:\s*0/i.test(style)
            || (/width\s*:\s*100%/i.test(style) && /height\s*:\s*(100%|100vh)/i.test(style));
        if (!positioned || !coversScreen) continue;
        if (/pointer-events\s*:\s*none/i.test(style)) continue;
        if (hasInputHandler(code, platform)) continue;
        return {
            level: 'critical',
            code: 'overlay_blocking',
            msg: 'полноэкранный div-оверлей меню перекрывает canvas без pointer-events:none и обработчика ввода — старт может быть недоступен'
        };
    }
    return null;
}

function topLevelConstDeclarations(code) {
    const names = new Set();
    let depth = 0;
    let state = 'code';
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1];
        if (state === 'code') {
            if (ch === "'") state = 'single';
            else if (ch === '"') state = 'double';
            else if (ch === '`') state = 'template';
            else if (ch === '/' && next === '/') { state = 'line'; i++; }
            else if (ch === '/' && next === '*') { state = 'block'; i++; }
            else if (ch === '{') depth++;
            else if (ch === '}') depth = Math.max(0, depth - 1);
            else if (depth === 0 && /[A-Za-z_$]/.test(ch) && code.startsWith('const', i) && !/[\w$]/.test(code[i - 1] || '')) {
                const match = code.slice(i).match(/^const\s+([A-Za-z_$][\w$]*)\s*=/);
                if (match) {
                    names.add(match[1]);
                    i += match[0].length - 1;
                }
            }
        } else if (state === 'single') {
            if (ch === '\\') i++;
            else if (ch === "'") state = 'code';
        } else if (state === 'double') {
            if (ch === '\\') i++;
            else if (ch === '"') state = 'code';
        } else if (state === 'template') {
            if (ch === '\\') i++;
            else if (ch === '`') state = 'code';
        } else if (state === 'line') {
            if (ch === '\n') state = 'code';
        } else if (state === 'block') {
            if (ch === '*' && next === '/') { state = 'code'; i++; }
        }
    }
    return names;
}

function findConstReassignment(code) {
    const names = topLevelConstDeclarations(code);
    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(^|[^.\\w$])' + escaped + '\\s*=(?!=|>)', 'g');
        let match;
        while ((match = re.exec(code)) !== null) {
            const start = match.index + (match[1] ? match[1].length : 0);
            const before = code.slice(Math.max(0, start - 12), start);
            if (/(?:const|let|var)\s*$/.test(before)) continue;
            return {
                level: 'critical',
                code: 'const_reassignment',
                msg: `top-level переменная ${name} объявлена через const, но позже ей присваивается новое значение — это TypeError и остановка игры (строка ~${lineOf(code, start)})`
            };
        }
    }
    return null;
}

function findDoubleDprScale(code) {
    const scales = /\bctx\.scale\s*\(\s*dpr\s*,\s*dpr\s*\)/i.test(code);
    const backing = /canvas\.width\s*=[^;]*\*\s*dpr/i.test(code) || /width\s*=\s*canvas\.width\s*=[^;]*\*\s*dpr/i.test(code);
    if (!scales || !backing) return null;
    const cssCoordinateHelper = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]*(?:canvas\.(?:width|height)|innerWidth|innerHeight)[^;\n]*\/\s*dpr/i.test(code)
        || /\/\s*\(\s*2\s*\*\s*dpr\s*\)/i.test(code);
    if (cssCoordinateHelper) return null;
    const divisions = (code.match(/\/\s*dpr\b/g) || []).length;
    if (divisions >= 3) return null;
    return {
        level: 'warning',
        code: 'double_dpr_scale',
        msg: 'похоже на двойной DPR: canvas в backing-пикселях и ctx.scale(dpr), но координаты почти нигде не делятся на dpr — HUD и объекты могут уехать за экран'
    };
}

function findOverscaledHudFont(code) {
    const scales = /\bctx\.scale\s*\(\s*dpr\s*,\s*dpr\s*\)/i.test(code);
    if (!scales) return null;
    if (!/\.font\s*=[^;\n]*\*\s*dpr/i.test(code)) return null;
    return {
        level: 'warning',
        code: 'hud_font_overscaled',
        msg: 'размер шрифта умножается на dpr при уже включённом ctx.scale(dpr) — HUD будет вдвое больше и может перекрыть игру'
    };
}

function findUnboundedParticles(code) {
    const spawns = /(?:particles?|particlePool|sparks?|effects?)\.(?:push|add)\s*\(/gi;
    if (!spawns.test(code)) return null;
    const capped = /MAX_PARTICLES|maxParticles|maxSparks|maxRainParticles|PARTICLE_LIMIT|particles?\.(?:active\.)?length\s*[<>]=?|length\s*>=\s*[A-Z_]*PARTICLE/i.test(code);
    if (!capped) {
        return {
            level: 'warning',
            code: 'no_particle_cap',
            msg: 'частицы добавляются без видимого лимита — при взрывах массив может вырасти до сотен элементов'
        };
    }
    const addRe = /(?:add\s*:\s*function\s*\([^)]*\)|add\s*\([^)]*\))\s*\{([\s\S]*?)\n\s*\}/gi;
    let match;
    let particleAdd = null;
    while ((match = addRe.exec(code)) !== null) {
        if (/active|particle|spark|effect|this\.pool/i.test(match[1])) {
            particleAdd = match[1];
            break;
        }
    }
    if (particleAdd && !/(?:MAX_[A-Z_]+|maxParticles|maxSparks|maxRainParticles|\.shift\s*\(|\.splice\s*\()/i.test(particleAdd)) {
        return {
            level: 'warning',
            code: 'particle_cap_not_enforced',
            msg: 'константа лимита частиц есть, но в функции spawn/add нет проверки длины и переиспользования — массив всё равно может расти'
        };
    }
    return null;
}

function findExcessiveShadows(code) {
    const count = (code.match(/shadowBlur\s*=\s*[1-9]\d*/g) || []).length;
    if (count <= 10) return null;
    return {
        level: 'warning',
        code: 'many_shadow_blur',
        msg: `много shadowBlur (${count} присваиваний) — на телефоне свечение для каждого объекта может стоить дорого`
    };
}

function auditGame(code, platform = 'pc') {
    const issues = [];
    const add = (issue) => { if (issue) issues.push(issue); };
    const text = String(code || '');

    add(findBlockingOverlay(text, platform));
    add(findConstReassignment(text));
    add(findDoubleDprScale(text));
    add(findOverscaledHudFont(text));
    add(findUnboundedParticles(text));
    add(findExcessiveShadows(text));

    const penalty = issues.reduce((sum, issue) => sum + (issue.level === 'critical' ? 40 : 10), 0);
    const technicalScore = Math.max(0, 100 - penalty);
    return {
        score: technicalScore,
        issues,
        metrics: {
            lines: text.split('\n').length,
            gradients: (text.match(/create(?:Linear|Radial)Gradient/g) || []).length,
            shadowBlur: (text.match(/shadowBlur/g) || []).length,
            particleSpawns: (text.match(/(?:particles?|particlePool|sparks?|effects?)\.(?:push|add)\s*\(/gi) || []).length,
            hasTouch: /touch(start|move|end)|pointer(down|move|up)/i.test(text),
            hasKeyboard: /key(down|up)/i.test(text)
        }
    };
}

function formatAudit(audit) {
    if (!audit || !audit.issues.length) return 'OK';
    return audit.issues.map((issue) => `[${issue.level}] ${issue.msg}`).join('\n');
}

module.exports = {
    auditGame,
    formatAudit
};
