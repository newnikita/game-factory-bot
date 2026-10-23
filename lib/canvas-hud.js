const { measureCanvasText } = require('./canvas-text-metrics');

const VIEWPORT = { width: 390, height: 844 };
const MIN_OVERLAP_PX = 3;
const MIN_OVERLAP_RATIO = 0.15;
const BASELINE_TOLERANCE = 0.6;

function parseFontSpec(spec) {
    const size = /(\d+(?:\.\d+)?)\s*px/.exec(String(spec || ''));
    return {
        size: size ? Number(size[1]) : 14,
        bold: /bold|[789]00/i.test(String(spec || ''))
    };
}

function substituteViewport(expression) {
    return String(expression)
        .replace(/canvas\s*\.\s*width/g, String(VIEWPORT.width))
        .replace(/canvas\s*\.\s*height/g, String(VIEWPORT.height))
        .replace(/\binnerWidth\b/g, String(VIEWPORT.width))
        .replace(/\binnerHeight\b/g, String(VIEWPORT.height))
        .replace(/\bwidth\b/g, String(VIEWPORT.width))
        .replace(/\bheight\b/g, String(VIEWPORT.height));
}

function evalNumeric(expression) {
    if (typeof expression === 'number') return Number.isFinite(expression) ? expression : null;
    const text = substituteViewport(expression).trim();
    if (!text || !/^[\d\s+\-*/().]+$/.test(text)) return null;
    try {
        const value = Function(`"use strict";return (${text});`)();
        return Number.isFinite(value) ? value : null;
    } catch (error) {
        return null;
    }
}

function splitCallArgs(code, openIndex) {
    const args = [];
    let depth = 1;
    let current = '';
    let quote = null;
    for (let i = openIndex + 1; i < code.length; i++) {
        const char = code[i];
        if (quote) {
            current += char;
            if (char === '\\') {
                current += code[i + 1] || '';
                i += 1;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            current += char;
            continue;
        }
        if (char === '(' || char === '[' || char === '{') {
            depth += 1;
            current += char;
            continue;
        }
        if (char === ')' || char === ']' || char === '}') {
            depth -= 1;
            if (depth === 0 && char === ')') {
                args.push(current.trim());
                return { args, end: i };
            }
            current += char;
            continue;
        }
        if (char === ',' && depth === 1) {
            args.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    return null;
}

function readTextArgument(raw) {
    const text = String(raw || '').trim();
    if (text.startsWith("'") || text.startsWith('"')) {
        const end = text.lastIndexOf(text[0]);
        if (end <= 0) return null;
        const value = text.slice(1, end);
        return { label: value, widthText: value };
    }
    if (text.startsWith('`')) {
        const end = text.lastIndexOf('`');
        const body = end > 0 ? text.slice(1, end) : '';
        const parts = body.split(/\$\{[^}]*\}/);
        const label = parts.join('…');
        const widthText = parts.join('') + '88'.repeat(Math.max(0, parts.length - 1));
        return { label, widthText };
    }
    return null;
}

function readQuoted(code, index) {
    let start = index;
    while (start < code.length && /\s/.test(code[start])) start += 1;
    const quote = code[start];
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;
    for (let i = start + 1; i < code.length; i++) {
        if (code[i] === '\\') {
            i += 1;
            continue;
        }
        if (code[i] === quote) return { value: code.slice(start + 1, i), end: i + 1 };
    }
    return null;
}

function isZeroTranslate(args) {
    if (args.length < 2) return false;
    const x = evalNumeric(args[0]);
    const y = evalNumeric(args[1]);
    return x === 0 && y === 0;
}

function hasLiteralScale(args) {
    for (const arg of args) {
        const text = String(arg).trim();
        if (!/^\d+(?:\.\d+)?$/.test(text)) continue;
        if (Number(text) !== 1) return true;
    }
    return false;
}

function collectCanvasTexts(code) {
    const texts = [];
    let font = { size: 14, bold: true };
    let align = 'left';
    let transformed = false;
    const scopes = [];
    const re = /(?:ctx|context)\s*\.\s*(fillText|font|textAlign|save|restore|translate|scale|rotate|setTransform)\b\s*(=|\()/g;
    let match;
    while ((match = re.exec(code)) !== null) {
        const method = match[1];
        if (match[2] === '=') {
            const quoted = readQuoted(code, re.lastIndex);
            if (!quoted) continue;
            re.lastIndex = quoted.end;
            if (method === 'font') font = parseFontSpec(quoted.value);
            else if (method === 'textAlign') align = quoted.value;
            continue;
        }
        const openIndex = code.indexOf('(', match.index + match[0].length - 1);
        const parsed = splitCallArgs(code, openIndex);
        if (!parsed) continue;
        re.lastIndex = parsed.end + 1;
        if (method === 'fillText') {
            if (transformed || parsed.args.length < 3) continue;
            const content = readTextArgument(parsed.args[0]);
            if (!content) continue;
            const x = evalNumeric(parsed.args[1]);
            const y = evalNumeric(parsed.args[2]);
            if (x === null || y === null) continue;
            texts.push({ label: content.label, widthText: content.widthText, x, y, font, align });
            continue;
        }
        if (method === 'save') scopes.push(transformed);
        else if (method === 'restore') transformed = scopes.length ? scopes.pop() : false;
        else if (method === 'translate') {
            if (!isZeroTranslate(parsed.args)) transformed = true;
        } else if (method === 'rotate') transformed = true;
        else if (method === 'scale' || method === 'setTransform') {
            if (hasLiteralScale(parsed.args)) transformed = true;
        }
    }
    return texts;
}

function textBox(text) {
    const width = measureCanvasText(text.widthText, text.font.size, text.font.bold);
    let left = text.x;
    if (text.align === 'center') left = text.x - width / 2;
    else if (text.align === 'right' || text.align === 'end') left = text.x - width;
    return { left, right: left + width, width, text };
}

function auditCanvasHud(code) {
    const texts = collectCanvasTexts(String(code || ''));
    const issues = [];
    const seen = new Set();
    for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
            const a = texts[i];
            const b = texts[j];
            if (Math.abs(a.y - b.y) > Math.max(a.font.size, b.font.size) * BASELINE_TOLERANCE) continue;
            const boxA = textBox(a);
            const boxB = textBox(b);
            const overlap = Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left);
            if (overlap <= MIN_OVERLAP_PX) continue;
            const narrower = Math.min(boxA.width, boxB.width);
            if (narrower <= 0 || overlap / narrower < MIN_OVERLAP_RATIO) continue;
            const key = [boxA.text.label, boxB.text.label].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            issues.push({
                code: 'hud_overlap',
                level: 'warning',
                msg: `подписи HUD наезжают друг на друга: «${boxA.text.label}» и «${boxB.text.label}» (перекрытие ${Math.round(overlap)}px на 390 px)`,
                fix: 'разведи подписи HUD по горизонтали: посчитай суммарную ширину подписи и её числа и разнеси их так, чтобы между ними оставался зазор 8-12 px при ширине экрана 390 px'
            });
        }
    }
    return { issues, texts };
}

module.exports = {
    auditCanvasHud,
    collectCanvasTexts
};
