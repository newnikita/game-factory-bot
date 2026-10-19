const vm = require('vm');

function runtimeDryRun(html) {
    try {
        if (typeof html !== 'string' || html.length < 200) return null;

        const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
            .filter(m => !/\ssrc\s*=/.test(m[1] || ''))
            .filter(m => {
                const t = (m[1].match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
                return !t || /javascript/i.test(t);
            })
            .map(m => m[2])
            .filter(s => s.trim());
        if (!scripts.length) return null;

        const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
        const classVariants = [...html.matchAll(/\sclass\s*=\s*["']([^"']+)["']/g)]
            .map(m => new Set(m[1].split(/\s+/).filter(Boolean)));

        let rafQ = [], timerQ = [], intervalFns = [];
        let tNow = 1000, crash = null;
        const elMap = new Map();

        const fail = (e, phase) => {
            if (!crash) crash = phase + ': ' + ((e && e.message) || e);
        };

        const ctxProxy = new Proxy(function () { }, {
            get: (t, p) => (p === 'then') ? undefined : ctxProxy,
            set: () => true,
            apply: () => ctxProxy
        });

        function regId(id, el) {
            if (!id) return;
            ids.add(id);
            elMap.set(id, el);
        }

        function qSelect(sel) {
            sel = String(sel || '').trim();
            if (!sel) return null;
            if (sel[0] === '#') {
                const id = sel.slice(1).split(/[.[:\s]/)[0];
                return elMap.get(id) || (ids.has(id) ? mkEl(id) : null);
            }
            if (sel[0] === '.') {
                const tokens = (sel.match(/\.([\w-]+)/g) || []).map(t => t.slice(1));
                if (tokens.length && classVariants.some(s => tokens.every(t => s.has(t)))) {
                    const key = '_cls_' + tokens.join('_');
                    return elMap.get(key) || mkEl(key);
                }
                return null;
            }
            const tag = sel.split(/[#.\[:\s]/)[0].toLowerCase();
            if (/^[a-z][a-z0-9]*$/.test(tag) && new RegExp('<' + tag + '[\\s>]', 'i').test(html)) {
                const key = '_tag_' + tag;
                return elMap.get(key) || mkEl(key, tag);
            }
            return null;
        }

        function fire(target, type, ev) {
            if (!target) return;
            try {
                const hs = (target.__handlers && target.__handlers[type]) || [];
                for (const fn of hs.slice()) fn(ev);
                const prop = target['on' + type];
                if (typeof prop === 'function') prop(ev);
            } catch (e) {
                fail(e, 'обработчик ' + type);
            }
        }

        function mkEl(id, tag) {
            tag = tag || 'div';
            if (elMap.has(id)) return elMap.get(id);
            const cls = new Set();
            const handlers = {};
            let innerHTML = '';
            const el = {
                id, tagName: tag.toUpperCase(), tagName2: undefined,
                style: new Proxy({}, { get: () => '', set: () => true }),
                dataset: {},
                __handlers: handlers,
                classList: {
                    add: (...c) => c.forEach(x => cls.add(x)),
                    remove: (...c) => c.forEach(x => cls.delete(x)),
                    contains: c => cls.has(c),
                    toggle: c => { if (cls.has(c)) { cls.delete(c); return false; } cls.add(c); return true; }
                },
                addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
                removeEventListener: (t, fn) => { if (handlers[t]) handlers[t] = handlers[t].filter(f => f !== fn); },
                dispatchEvent: () => true,
                appendChild: c => c, removeChild: () => { }, remove: () => { },
                insertBefore: c => c, replaceChildren: () => { }, replaceWith: () => { },
                setAttribute: (k, v) => { if (String(k).toLowerCase() === 'id') regId(String(v), el); },
                getAttribute: () => null, removeAttribute: () => { }, hasAttribute: () => false,
                focus: () => { }, blur: () => { }, select: () => { },
                click: () => fire(el, 'click', { preventDefault() { }, target: el }),
                getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 400, width: 300, height: 400, x: 0, y: 0 }),
                clientWidth: 300, clientHeight: 400, offsetWidth: 300, offsetHeight: 400,
                scrollWidth: 300, scrollHeight: 400, scrollTop: 0, scrollLeft: 0,
                width: (tag === 'canvas' ? 300 : undefined),
                height: (tag === 'canvas' ? 300 : undefined),
                parentElement: null, ownerDocument: null,
                contains: () => false, closest: () => null, matches: () => false,
                querySelector: s => qSelect(s),
                querySelectorAll: s => { const e = qSelect(s); return e ? [e] : []; },
                getContext: () => ctxProxy,
                toDataURL: () => 'data:,', toBlob: cb => cb && cb(null),
                requestPointerLock: () => { }, releasePointerLock: () => { },
                requestFullscreen: () => Promise.resolve(), webkitRequestFullscreen: () => { },
                exitFullscreen: () => Promise.resolve(),
                play: () => Promise.resolve(), pause: () => { }, load: () => { },
                captureStream: () => ({})
            };
            el.parentElement = {
                clientWidth: 300, clientHeight: 400, offsetWidth: 300, offsetHeight: 400,
                style: {}, classList: { add() { }, remove() { }, contains: () => false },
                appendChild: c => c, querySelector: s => qSelect(s)
            };
            Object.defineProperty(el, 'innerHTML', {
                get: () => innerHTML,
                set: (v) => {
                    innerHTML = String(v);
                    try {
                        for (const m of innerHTML.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) {
                            if (!elMap.has(m[1])) mkEl(m[1]);
                        }
                    } catch (e) { }
                }
            });
            Object.defineProperty(el, 'onclick', { writable: true, value: null });
            elMap.set(id, el);
            return el;
        }

        const docHandlers = {};
        const documentObj = {
            hidden: false, visibilityState: 'visible', title: '',
            __handlers: docHandlers,
            readyState: 'complete',
            body: mkEl('body', 'body'),
            documentElement: mkEl('html', 'html'),
            head: mkEl('head', 'head'),
            getElementById: id => (id && elMap.get(id)) || (ids.has(id) ? mkEl(id) : null),
            querySelector: s => qSelect(s),
            querySelectorAll: s => { const e = qSelect(s); return e ? [e] : []; },
            createElement: t => mkEl('_dyn_' + Math.random().toString(36).slice(2, 9), String(t).toLowerCase()),
            createTextNode: () => mkEl('_text'),
            addEventListener: (t, fn) => { (docHandlers[t] = docHandlers[t] || []).push(fn); },
            removeEventListener: (t, fn) => { if (docHandlers[t]) docHandlers[t] = docHandlers[t].filter(f => f !== fn); },
            dispatchEvent: () => true,
            exitPointerLock: () => { }, hasFocus: () => true,
            write: () => { }, writeln: () => { }
        };

        const winHandlers = {};
        const rafFn = fn => { rafQ.push(fn); return rafQ.length; };
        const sandbox = {
            document: documentObj,
            console: { log() { }, warn() { }, error() { }, info() { }, debug() { } },
            performance: { now: () => tNow },
            requestAnimationFrame: rafFn, cancelAnimationFrame: () => { },
            setTimeout: (fn, ms) => { timerQ.push(fn); return timerQ.length; },
            clearTimeout: () => { }, setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; },
            clearInterval: () => { }, queueMicrotask: (fn) => { try { fn(); } catch (e) { fail(e, 'microtask'); } },
            innerWidth: 360, innerHeight: 740, outerWidth: 360, outerHeight: 740,
            devicePixelRatio: 2, screenX: 0, screenY: 0,
            addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); },
            removeEventListener: (t, fn) => { if (winHandlers[t]) winHandlers[t] = winHandlers[t].filter(f => f !== fn); },
            dispatchEvent: () => true,
            scrollTo: () => { }, scrollBy: () => { }, focus: () => { }, blur: () => { },
            open: () => null, close: () => { },
            matchMedia: () => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } }),
            getComputedStyle: () => new Proxy({}, { get: () => '' }),
            location: { search: '', hash: '', href: 'https://game.local/', pathname: '/', reload() { }, assign() { }, replace() { } },
            history: { back() { }, forward() { }, pushState() { }, replaceState() { }, length: 1 },
            navigator: {
                language: 'ru', languages: ['ru'], userAgent: 'runtime-check',
                maxTouchPoints: 5, vibrate() { }, clipboard: { writeText: () => Promise.resolve() }
            },
            localStorage: { getItem: () => null, setItem() { }, removeItem() { }, clear() { }, key: () => null, length: 0 },
            sessionStorage: { getItem: () => null, setItem() { }, removeItem() { }, clear() { } },
            fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), blob: () => Promise.resolve(new Blob ? new Blob() : {}) }),
            alert() { }, confirm: () => true, prompt: () => '',
            Image: class {
                constructor() { this.width = 300; this.height = 200; this.onload = null; this.onerror = null; }
                set src(v) { this._src = v; }
                get src() { return this._src; }
            },
            Audio: class {
                constructor() { this.currentTime = 0; this.duration = 0; }
                play() { return Promise.resolve(); } pause() { } load() { }
            },
            Path2D: class { }, Path2DStub: undefined,
            OffscreenCanvas: class {
                constructor(w, h) { this.width = w; this.height = h; }
                getContext() { return ctxProxy; }
                transferToImageBitmap() { return {}; }
            },
            ResizeObserver: class { observe() { } unobserve() { } disconnect() { } },
            IntersectionObserver: class { observe() { } unobserve() { } disconnect() { } takeRecords() { return []; } },
            MutationObserver: class { observe() { } disconnect() { } takeRecords() { return []; } },
            Worker: class { postMessage() { } terminate() { } addEventListener() { } },
            WebSocket: class { constructor() { this.readyState = 1; } send() { } close() { } addEventListener() { } },
            Blob: class { constructor(parts) { this.size = 0; this.parts = parts; } },
            URL: { createObjectURL: () => 'blob:x', revokeObjectURL() { }, parse: () => ({ href: '' }) },
            URLSearchParams: class { constructor() { } get() { return null; } toString() { return ''; } },
            FileReader: class { readAsDataURL() { } readAsText() { } },
            addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); },
            removeEventListener: (t, fn) => { if (winHandlers[t]) winHandlers[t] = winHandlers[t].filter(f => f !== fn); },
            __handlers: winHandlers,
            isSecureContext: true,
            device: undefined
        };
        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.top = sandbox;
        sandbox.parent = sandbox;
        sandbox.frames = sandbox;

        const audioNodeProxy = new Proxy(function () { }, {
            get: (t, p) => (p === 'then') ? undefined : audioNodeProxy,
            set: () => true,
            apply: () => audioNodeProxy
        });
        const FakeAudioContext = function () {
            return new Proxy({}, {
                get: (t, p) => {
                    if (p === 'state') return 'running';
                    if (p === 'currentTime') return 0;
                    if (p === 'destination') return {};
                    if (p === 'sampleRate') return 44100;
                    if (p === 'resume' || p === 'suspend' || p === 'close') return () => Promise.resolve();
                    return audioNodeProxy;
                },
                set: () => true
            });
        };
        sandbox.AudioContext = FakeAudioContext;
        sandbox.webkitAudioContext = FakeAudioContext;
        sandbox.CanvasRenderingContext2D = class { };
        sandbox.HTMLCanvasElement = class { };
        sandbox.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)); } };
        sandbox.DOMMatrix = class { constructor() { } };
        sandbox.DOMRect = class { constructor() { this.x = 0; this.y = 0; this.width = 0; this.height = 0; } };
        sandbox.TextEncoder = class { encode(s) { return Buffer.from(String(s || ''), 'utf8'); } };
        sandbox.TextDecoder = class { decode(b) { try { return Buffer.from(b || []).toString('utf8'); } catch (e) { return ''; } } };
        sandbox.structuredClone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
        sandbox.crypto = { getRandomValues: (a) => { for (let i = 0; i < (a ? a.length : 0); i++) a[i] = (Math.random() * 256) | 0; return a; }, randomUUID: () => '00000000-0000-4000-8000-000000000000' };
        sandbox.Event = class { constructor(t) { this.type = t; } };
        sandbox.EventTarget = class { addEventListener() { } removeEventListener() { } dispatchEvent() { return true; } };

        const ctx = vm.createContext(sandbox);

        for (let i = 0; i < scripts.length && !crash; i++) {
            try {
                vm.runInContext(scripts[i], ctx, { filename: 'runtime_check_' + i + '.js', timeout: 5000 });
            } catch (e) {
                fail(e, 'скрипт #' + (i + 1) + ' при загрузке');
            }
        }

        const pump = (frames) => {
            for (let i = 0; i < frames && !crash; i++) {
                tNow += 16.7;
                const cbs = rafQ; rafQ = [];
                for (const cb of cbs) {
                    try { cb(tNow); } catch (e) { fail(e, 'кадр #' + (i + 1)); break; }
                }
                if (timerQ.length) {
                    const ts = timerQ.slice(0, 30); timerQ = timerQ.slice(30);
                    for (const fn of ts) {
                        try { fn(); } catch (e) { fail(e, 'setTimeout'); break; }
                    }
                }
                if (intervalFns.length && i % 6 === 0) {
                    for (const fn of intervalFns.slice(0, 5)) {
                        try { fn(); } catch (e) { fail(e, 'setInterval'); break; }
                    }
                }
                if (crash) break;
            }
        };

        if (!crash) fire(documentObj, 'DOMContentLoaded', { target: documentObj });
        if (!crash) fire(sandbox, 'load', { target: sandbox });
        if (!crash) fire(sandbox, 'resize', { target: sandbox });
        if (!crash) fire(documentObj, 'visibilitychange', { target: documentObj });

        if (!crash) pump(30);

        if (!crash) {
            const startIds = [...elMap.keys()].filter(id => /^(start|play|restart|btn[_-]?(start|play)|start[_-]?btn)/i.test(id));
            const skip = /^(html|body|head)$/;
            for (const id of startIds) {
                if (skip.test(id)) continue;
                const el = elMap.get(id);
                if (el && ((el.__handlers && el.__handlers.click && el.__handlers.click.length) || typeof el.onclick === 'function')) {
                    fire(el, 'click', { preventDefault() { }, target: el, touches: [{ clientX: 150, clientY: 300 }] });
                }
            }
            pump(80);
        }

        if (!crash) {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'KeyA', 'KeyD', 'KeyW'];
            for (const k of keys.slice(0, 5)) {
                fire(documentObj, 'keydown', { key: k, code: k, preventDefault() { } });
                fire(sandbox, 'keydown', { key: k, code: k, preventDefault() { } });
            }
            pump(30);
            for (const k of keys.slice(0, 5)) {
                fire(documentObj, 'keyup', { key: k, code: k, preventDefault() { } });
                fire(sandbox, 'keyup', { key: k, code: k, preventDefault() { } });
            }
            const canvasEl = elMap.get('gameCanvas') || qSelect('canvas');
            if (canvasEl) {
                const fakeTouch = { touches: [{ clientX: 150, clientY: 300 }], preventDefault() { }, target: canvasEl };
                fire(canvasEl, 'touchstart', fakeTouch);
                fire(canvasEl, 'touchmove', fakeTouch);
                fire(canvasEl, 'mousedown', { clientX: 150, clientY: 300, preventDefault() { }, target: canvasEl });
                fire(canvasEl, 'mousemove', { clientX: 150, clientY: 300, preventDefault() { }, target: canvasEl });
                pump(30);
                fire(canvasEl, 'touchend', { changedTouches: [{ clientX: 150, clientY: 300 }], preventDefault() { } });
                fire(canvasEl, 'mouseup', { clientX: 150, clientY: 300, preventDefault() { } });
            }
            pump(40);
        }

        return crash;
    } catch (e) {
        try { console.warn('[RuntimeCheck] харнесс пропущен:', e && e.message); } catch (e2) { }
        return null;
    }
}

module.exports = { runtimeDryRun };
