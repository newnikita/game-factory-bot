'use strict';

// Минимальный разбор верхнего уровня скрипта: границы операторов и объявления
// без полного AST. Нужен детерминированному ремонту, чтобы перенести объявление
// выше места, где оно используется, и не сломать зависимости.

const NEW_STATEMENT_KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'class', 'async', 'if', 'for', 'while',
    'switch', 'return', 'do', 'try', 'throw', 'new', 'delete', 'typeof',
    'import', 'export', 'break', 'continue', 'case', 'default'
]);

const REGEX_AFTER_WORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'case', 'do', 'else', 'yield', 'await'
]);

function isIdentChar(ch) {
    return typeof ch === 'string' && /[A-Za-z0-9_$]/.test(ch);
}

function isIdentStart(ch) {
    return typeof ch === 'string' && /[A-Za-z_$]/.test(ch);
}

function skipString(text, i) {
    const quote = text[i];
    i += 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) return i + 1;
        i += 1;
    }
    return i;
}

function skipTemplate(text, i) {
    i += 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') return i + 1;
        if (ch === '$' && text[i + 1] === '{') {
            i += 2;
            let depth = 1;
            while (i < text.length && depth > 0) {
                const c = text[i];
                if (c === '{') { depth += 1; i += 1; continue; }
                if (c === '}') { depth -= 1; i += 1; continue; }
                if (c === '"' || c === "'") { i = skipString(text, i); continue; }
                if (c === '`') { i = skipTemplate(text, i); continue; }
                if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
                if (c === '/' && text[i + 1] === '*') {
                    i += 2;
                    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
                    i += 2;
                    continue;
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    return i;
}

function skipRegex(text, i) {
    i += 1;
    let inClass = false;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') { inClass = true; i += 1; continue; }
        if (ch === ']') { inClass = false; i += 1; continue; }
        if (ch === '/' && !inClass) { i += 1; break; }
        if (ch === '\n') break;
        i += 1;
    }
    while (i < text.length && /[a-z]/i.test(text[i])) i += 1;
    return i;
}

function regexAllowed(lastSig, prevWord) {
    if (!lastSig) return true;
    if ('(,=:[!&|?{};+-*%~^<>'.includes(lastSig)) return true;
    if (prevWord && REGEX_AFTER_WORDS.has(prevWord)) return true;
    return false;
}

function skipSpace(text, i) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    return i;
}

// Пропускает пробелы и комментарии перед оператором, чтобы текст оператора
// начинался с первого значащего символа.
function skipTrivia(text, from, end) {
    let i = from;
    while (i < end) {
        const ch = text[i];
        if (/\s/.test(ch)) { i += 1; continue; }
        if (ch === '/' && text[i + 1] === '/') { while (i < end && text[i] !== '\n') i += 1; continue; }
        if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < end && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        break;
    }
    return i;
}

// Имена в фигурных/квадратных скобках: { a, b: c, ...rest } или [ a, b ]
function patternNames(text, start, end) {
    const names = [];
    for (const part of text.slice(start, end).split(',')) {
        const name = part.split(':')[0].split('=')[0].trim().replace(/^\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
    return names;
}

// Разбор одного декларатора после const/let/var/class
function parsePattern(text, i) {
    const pos = skipSpace(text, i);
    if (pos >= text.length) return { names: [], end: pos };
    const ch = text[pos];
    if (ch === '{' || ch === '[') {
        let depth = 0;
        let j = pos;
        while (j < text.length) {
            const c = text[j];
            if (c === '{' || c === '[') depth += 1;
            else if (c === '}' || c === ']') {
                depth -= 1;
                if (depth === 0) { j += 1; break; }
            }
            j += 1;
        }
        return { names: patternNames(text, pos + 1, j - 1), end: j };
    }
    if (!isIdentStart(ch)) return { names: [], end: pos };
    let j = pos;
    while (j < text.length && isIdentChar(text[j])) j += 1;
    const name = text.slice(pos, j);
    return { names: /^[A-Za-z_$][\w$]*$/.test(name) ? [name] : [], end: j };
}

// Имена, объявленные одним оператором: "const a = 1, b = 2"
function parseDeclaration(text, i, kind) {
    const first = parsePattern(text, i);
    const names = first.names.slice();
    if (kind === 'class') return { names, end: first.end };

    let scan = first.end;
    let rel = 0;
    let lastSig = '';
    while (scan < text.length) {
        const ch = text[scan];
        if (ch === '"' || ch === "'") { scan = skipString(text, scan); lastSig = '"'; continue; }
        if (ch === '`') { scan = skipTemplate(text, scan); lastSig = '`'; continue; }
        if (ch === '/' && text[scan + 1] === '/') { while (scan < text.length && text[scan] !== '\n') scan += 1; continue; }
        if (ch === '/' && text[scan + 1] === '*') {
            scan += 2;
            while (scan < text.length && !(text[scan] === '*' && text[scan + 1] === '/')) scan += 1;
            scan += 2;
            continue;
        }
        if (ch === '/' && regexAllowed(lastSig, '')) { scan = skipRegex(text, scan); lastSig = '/'; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { rel += 1; scan += 1; lastSig = ch; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (rel === 0) break;
            rel -= 1; scan += 1; lastSig = ch; continue;
        }
        if (ch === ';' && rel === 0) break;
        if (ch === '\n' && rel === 0) break;
        if (ch === ',' && rel === 0) {
            const next = parsePattern(text, scan + 1);
            if (!next.names.length) break;
            names.push(...next.names);
            scan = next.end;
            continue;
        }
        if (!/\s/.test(ch)) lastSig = ch;
        scan += 1;
    }
    return { names, end: first.end };
}

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function lineOf(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
    }
    return low + 1;
}

// Разбивает скрипт на операторы верхнего уровня.
// Для каждого: границы, текст и объявленные им имена (const/let/var/class).
function scanTopLevel(js) {
    const text = String(js || '');
    const len = text.length;
    const starts = lineStarts(text);
    const statements = [];
    let i = 0;
    let depth = 0;
    let start = 0;
    let lastSig = '';
    let prevWord = '';
    let decls = [];

    const push = (end) => {
        const from = skipTrivia(text, start, end);
        const raw = text.slice(from, end);
        if (raw.trim()) {
            statements.push({
                start: from,
                end,
                text: raw,
                decls,
                line: lineOf(starts, from),
                endLine: lineOf(starts, Math.max(from, end - 1))
            });
        }
        decls = [];
        start = end;
    };

    while (i < len) {
        const ch = text[i];
        if (ch === '/' && text[i + 1] === '/') { while (i < len && text[i] !== '\n') i += 1; continue; }
        if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") { i = skipString(text, i); lastSig = '"'; prevWord = ''; continue; }
        if (ch === '`') { i = skipTemplate(text, i); lastSig = '`'; prevWord = ''; continue; }
        if (ch === '/' && regexAllowed(lastSig, prevWord)) { i = skipRegex(text, i); lastSig = '/'; prevWord = ''; continue; }
        if (ch === '{' || ch === '(' || ch === '[') { depth += 1; i += 1; lastSig = ch; prevWord = ''; continue; }
        if (ch === '}' || ch === ')' || ch === ']') {
            depth -= 1;
            if (depth < 0) depth = 0;
            i += 1;
            if (depth === 0 && ch === '}') {
                let end = i;
                if (text[end] === ';') { end += 1; i = end; }
                push(end);
                lastSig = '}';
                prevWord = '';
                continue;
            }
            lastSig = ch;
            prevWord = '';
            continue;
        }
        if (ch === ';' && depth === 0) {
            i += 1;
            push(i);
            lastSig = ';';
            prevWord = '';
            continue;
        }
        if (ch === '\n' && depth === 0) {
            const next = nextWord(text, i + 1);
            if (next && NEW_STATEMENT_KEYWORDS.has(next) && canEndStatement(lastSig)) push(i);
            i += 1;
            continue;
        }
        if (isIdentChar(ch)) {
            let j = i;
            while (j < len && isIdentChar(text[j])) j += 1;
            const word = text.slice(i, j);
            lastSig = 'a';
            prevWord = word;
            if (depth === 0 && (word === 'const' || word === 'let' || word === 'var' || word === 'class')) {
                const parsed = parseDeclaration(text, j, word);
                for (const name of parsed.names) decls.push({ name, kind: word });
                i = parsed.end;
                continue;
            }
            i = j;
            continue;
        }
        if (!/\s/.test(ch)) { lastSig = ch; prevWord = ''; }
        i += 1;
    }
    push(len);
    return statements;
}

function nextWord(text, from) {
    let i = from;
    while (i < text.length) {
        const ch = text[i];
        if (/\s/.test(ch)) { i += 1; continue; }
        if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
        if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        break;
    }
    if (i >= text.length || !isIdentStart(text[i])) return null;
    let j = i;
    while (j < text.length && isIdentChar(text[j])) j += 1;
    return text.slice(i, j);
}

function canEndStatement(lastSig) {
    return !'=+-*/%<>!&|?.,:([{'.includes(lastSig);
}

module.exports = {
    scanTopLevel,
    lineStarts,
    lineOf,
    isIdentChar,
    isIdentStart,
    skipString,
    skipTemplate,
    skipRegex
};
