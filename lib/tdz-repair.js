'use strict';

// Детерминированный ремонт игр, которые падают при загрузке из-за
// temporal dead zone: переменная объявлена ниже, чем её используют.
// Такие игры LLM чинит запросом к модели — но квота может быть исчерпана,
// а починка детерминированная и не стоит ничего.

const { checkRuntimeErrors, extractScriptBlocks } = require('./game-runtime-check');
const { scanTopLevel } = require('./js-top-level');

const MAX_PASSES = 3;

const RESERVED = new Set([
    'arguments', 'Array', 'async', 'Audio', 'AudioContext', 'await', 'Boolean', 'break',
    'canvas', 'CanvasRenderingContext2D', 'case', 'catch', 'clearInterval', 'clearTimeout',
    'console', 'const', 'continue', 'crypto', 'Date', 'debugger', 'default', 'delete', 'document',
    'do', 'else', 'export', 'extends', 'false', 'fetch', 'finally', 'for', 'function', 'get',
    'getComputedStyle', 'globalThis', 'history', 'if', 'Image', 'import', 'in', 'Infinity',
    'instanceof', 'isFinite', 'isNaN', 'JSON', 'let', 'localStorage', 'location', 'Location',
    'matchMedia', 'Math', 'MutationObserver', 'navigator', 'NaN', 'new', 'null', 'Number',
    'Object', 'OffscreenCanvas', 'of', 'onerror', 'parseFloat', 'parseInt', 'Path2D', 'performance',
    'postMessage', 'Promise', 'Proxy', 'Reflect', 'RegExp', 'requestAnimationFrame',
    'requestIdleCallback', 'ResizeObserver', 'return', 'screen', 'sessionStorage', 'set',
    'setInterval', 'setTimeout', 'static', 'String', 'structuredClone', 'super', 'Symbol',
    'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'window', 'XMLHttpRequest',
    'yield'
]);

function isTdzError(error) {
    if (!error || error.name !== 'ReferenceError') return false;
    return /before initialization/i.test(String(error.message || ''));
}

function tdzVariableName(error) {
    const message = String((error && error.message) || '');
    const exact = message.match(/Cannot access '([^']+)' before initialization/);
    if (exact) return exact[1];
    const loose = message.match(/'([^']+)'[^.]*before initialization/);
    return loose ? loose[1] : null;
}

function findTdzIssues(errors) {
    const issues = [];
    for (const error of Array.isArray(errors) ? errors : []) {
        if (!isTdzError(error)) continue;
        const variable = tdzVariableName(error);
        if (!variable) continue;
        issues.push({
            error,
            variable,
            script: Number(error.script) || 1,
            callLine: Number(error.callLine) || null
        });
    }
    return issues;
}

// Имена, на которые ссылается оператор: без свойств (obj.name) и ключей ({ name: 1 }).
function referencedIdentifiers(text) {
    const names = new Set();
    const re = /[A-Za-z_$][\w$]*/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const name = match[0];
        if (RESERVED.has(name)) continue;
        const before = text.slice(0, match.index).replace(/\s+$/, '');
        if (before.endsWith('.')) continue;
        const after = text.slice(match.index + name.length).replace(/^\s*/, '');
        if (after.startsWith(':')) continue;
        names.add(name);
    }
    return names;
}

// Имя → номер оператора. Только const/let/class: у них есть temporal dead zone.
function buildDeclMap(statements) {
    const map = new Map();
    statements.forEach((statement, index) => {
        for (const decl of statement.decls) {
            if (decl.kind === 'var') continue;
            if (!map.has(decl.name)) map.set(decl.name, index);
        }
    });
    return map;
}

// Операторы, которые надо перенести вместе с объявлением: те, что используются
// в его инициализаторе и объявлены позже места вставки — иначе возникнет новая ошибка.
function collectGroup(statements, declMap, declIndex, targetIndex, variable) {
    const order = [];
    const seen = new Set();
    const visit = (index, name) => {
        if (seen.has(name)) return;
        seen.add(name);
        const statement = statements[index];
        for (const dep of referencedIdentifiers(statement.text)) {
            if (dep === name) continue;
            const depIndex = declMap.get(dep);
            if (depIndex === undefined || depIndex <= targetIndex || depIndex === index) continue;
            visit(depIndex, dep);
        }
        order.push(index);
    };
    visit(declIndex, variable);
    return order;
}

function lineStartOf(text, offset) {
    let start = offset;
    while (start > 0 && text[start - 1] !== '\n') start -= 1;
    return start;
}

function lineIndent(text, offset) {
    const start = lineStartOf(text, offset);
    const match = /^[ \t]*/.exec(text.slice(start, offset));
    return match ? match[0] : '';
}

function reindent(text, fromIndent, toIndent) {
    if (fromIndent === toIndent) return text;
    const delta = toIndent.length - fromIndent.length;
    const lines = text.split('\n');
    return lines.map((line, index) => {
        if (index === 0) return toIndent + line.trimStart();
        if (!line.trim()) return line;
        if (delta > 0) return ' '.repeat(delta) + line;
        if (line.startsWith(fromIndent)) return toIndent + line.slice(fromIndent.length);
        return line;
    }).join('\n');
}

function moveStatements(js, statements, order, targetIndex) {
    const target = statements[targetIndex];
    const targetIndent = lineIndent(js, target.start);
    const moved = order.map((index) => statements[index]);
    const block = moved
        .map((statement) => reindent(statement.text, lineIndent(js, statement.start), targetIndent))
        .join('\n');

    let result = js;
    const removals = moved.slice().sort((a, b) => b.start - a.start);
    for (const statement of removals) {
        const lineStart = lineStartOf(js, statement.start);
        const aloneOnLine = /^[ \t]*$/.test(js.slice(lineStart, statement.start));
        let from = aloneOnLine ? lineStart : statement.start;
        let end = statement.end;
        while (end < result.length && (result[end] === ' ' || result[end] === '\t')) end += 1;
        if (result[end] === '\r') end += 1;
        if (result[end] === '\n') end += 1;
        result = result.slice(0, from) + result.slice(end);
    }

    const insertAt = target.start;
    return result.slice(0, insertAt) + block + '\n' + targetIndent + result.slice(insertAt);
}

// Один вариант починки: перенести объявление выше места вызова.
// options.top — перенести в самое начало скрипта (запасной вариант).
function applyTdzFix(code, issue, options = {}) {
    const blocks = extractScriptBlocks(code);
    const block = blocks[issue.script - 1];
    if (!block) return null;

    const statements = scanTopLevel(block.js);
    const declIndex = statements.findIndex((statement) =>
        statement.decls.some((decl) => decl.name === issue.variable));
    if (declIndex === -1) return null;

    let targetIndex = -1;
    if (!options.top && issue.callLine) {
        targetIndex = statements.findIndex((statement) =>
            statement.line <= issue.callLine && issue.callLine <= statement.endLine);
    }
    if (targetIndex === -1) targetIndex = 0;
    if (targetIndex >= declIndex) return null;

    const declMap = buildDeclMap(statements);
    const order = collectGroup(statements, declMap, declIndex, targetIndex, issue.variable);
    const script = moveStatements(block.js, statements, order, targetIndex);
    if (script === block.js) return null;

    return {
        code: code.slice(0, block.start) + script + code.slice(block.end),
        moved: order.flatMap((index) => statements[index].decls.map((decl) => decl.name))
    };
}

// Починить все ошибки temporal dead zone в игре.
// Каждая правка применяется только если песочница подтвердила, что ошибка ушла.
function repairTdzErrors(code, options = {}) {
    const maxPasses = options.maxPasses || MAX_PASSES;
    const check = options.check || checkRuntimeErrors;
    let current = String(code || '');
    const fixes = [];
    let runtime = check(current);

    for (let pass = 0; pass < maxPasses; pass += 1) {
        const issues = findTdzIssues(runtime.errors);
        if (!issues.length) break;

        let applied = null;
        for (const issue of issues) {
            const candidates = [];
            const primary = applyTdzFix(current, issue, { top: false });
            if (primary) candidates.push(primary);
            const fallback = applyTdzFix(current, issue, { top: true });
            if (fallback) candidates.push(fallback);

            for (const candidate of candidates) {
                const after = check(candidate.code);
                const stillBroken = findTdzIssues(after.errors)
                    .some((item) => item.variable === issue.variable);
                if (stillBroken) continue;
                applied = { candidate, after, issue };
                break;
            }
            if (applied) break;
        }
        if (!applied) break;

        current = applied.candidate.code;
        runtime = applied.after;
        fixes.push({
            variable: applied.issue.variable,
            script: applied.issue.script,
            moved: applied.candidate.moved
        });
    }

    return { code: current, changed: fixes.length > 0, fixes };
}

module.exports = {
    isTdzError,
    tdzVariableName,
    findTdzIssues,
    referencedIdentifiers,
    buildDeclMap,
    collectGroup,
    applyTdzFix,
    repairTdzErrors
};
