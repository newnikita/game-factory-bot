'use strict';

// Песочница для проверки, что игра не падает при загрузке.
// Запускается в отдельном процессе (см. game-runtime-check.js): код игры
// генерируется моделью, поэтому ограничение памяти и времени здесь обязательны.

const vm = require('node:vm');

const MAX_TIMERS = 25;
const MAX_FRAMES = 2;
const VIEWPORT = { width: 390, height: 844 };

function noop() {}

// Любое неизвестное имя (браузерное API, которое мы не описали) не должно
// ронять проверку: подставляем заглушку вместо ReferenceError.
// Ошибки temporal dead zone при этом сохраняются — они бросает сам движок.
const callableStub = new Proxy(function () {}, {
    get(target, prop) {
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === 'prototype') return target.prototype;
        return callableStub;
    },
    apply() { return callableStub; },
    construct() { return callableStub; }
});

function makeVmContext(sandbox) {
    const proxy = new Proxy(sandbox, {
        get(target, prop) {
            if (typeof prop === 'symbol') return undefined;
            if (prop in target) return target[prop];
            return callableStub;
        },
        has() { return true; },
        getOwnPropertyDescriptor(target, prop) {
            return Object.getOwnPropertyDescriptor(target, prop);
        }
    });
    return vm.createContext(proxy);
}

function makeGradient() {
    return { addColorStop: noop };
}

function makeContext2d(parent = null) {
    const context = {
        canvas: null,
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        miterLimit: 10,
        font: '10px sans-serif',
        textAlign: 'start',
        textBaseline: 'alphabetic',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        filter: 'none',
        imageSmoothingEnabled: true,
        shadowBlur: 0,
        shadowColor: 'rgba(0,0,0,0)',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        save: noop,
        restore: noop,
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        arc: noop,
        arcTo: noop,
        ellipse: noop,
        rect: noop,
        roundRect: noop,
        quadraticCurveTo: noop,
        bezierCurveTo: noop,
        fill: noop,
        stroke: noop,
        clip: noop,
        translate: noop,
        rotate: noop,
        scale: noop,
        transform: noop,
        setTransform: noop,
        resetTransform: noop,
        setLineDash: noop,
        getLineDash: () => [],
        fillRect: noop,
        strokeRect: noop,
        clearRect: noop,
        fillText: noop,
        strokeText: noop,
        drawImage: noop,
        putImageData: noop,
        getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        measureText: (text) => ({ width: String(text == null ? '' : text).length * 7 }),
        createLinearGradient: makeGradient,
        createRadialGradient: makeGradient,
        createConicGradient: makeGradient,
        createPattern: () => null,
        isPointInPath: () => false
    };
    context.canvas = makeElement('canvas', context, parent);
    return context;
}

function makeElement(tag = 'div', context = null, parent = null) {
    let ownContext = context;
    const element = {
        tagName: String(tag).toUpperCase(),
        nodeType: 1,
        id: '',
        className: '',
        innerHTML: '',
        innerText: '',
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        dataset: {},
        children: [],
        childNodes: [],
        parentElement: parent,
        parentNode: parent,
        nextSibling: null,
        previousSibling: null,
        clientWidth: VIEWPORT.width,
        clientHeight: VIEWPORT.height,
        offsetWidth: VIEWPORT.width,
        offsetHeight: VIEWPORT.height,
        scrollWidth: VIEWPORT.width,
        scrollHeight: VIEWPORT.height,
        scrollTop: 0,
        scrollLeft: 0,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        naturalWidth: 0,
        naturalHeight: 0,
        complete: true,
        crossOrigin: null,
        src: '',
        style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' },
        classList: { add: noop, remove: noop, toggle: noop, replace: noop, contains: () => false },
        getContext: (kind) => {
            if (String(kind) !== '2d') return makeWebgl();
            if (!ownContext) ownContext = makeContext2d(null);
            return ownContext;
        },
        getBoundingClientRect: () => ({
            x: 0, y: 0, left: 0, top: 0, right: VIEWPORT.width, bottom: VIEWPORT.height,
            width: VIEWPORT.width, height: VIEWPORT.height, toJSON: noop
        }),
        getClientRects: () => [],
        addEventListener: noop,
        removeEventListener: noop,
        dispatchEvent: () => true,
        appendChild: (child) => {
            element.children.push(child);
            element.childNodes.push(child);
            if (child && typeof child === 'object') child.parentElement = element;
            return child;
        },
        removeChild: noop,
        insertBefore: (child) => child,
        replaceChild: (child) => child,
        cloneNode: () => makeElement(tag, context),
        setAttribute: noop,
        getAttribute: () => null,
        removeAttribute: noop,
        hasAttribute: () => false,
        querySelector: () => makeElement('div', context),
        querySelectorAll: () => [],
        closest: () => null,
        focus: noop,
        blur: noop,
        click: noop,
        remove: noop,
        play: () => Promise.resolve(),
        pause: noop,
        load: noop,
        toDataURL: () => 'data:image/png;base64,',
        getContextAttributes: () => ({})
    };
    return element;
}

function makeWebgl() {
    return {
        canvas: null,
        viewport: noop,
        clearColor: noop,
        clear: noop,
        enable: noop,
        disable: noop,
        blendFunc: noop,
        drawArrays: noop,
        drawElements: noop,
        createBuffer: () => ({ bindBuffer: noop, bufferData: noop }),
        createShader: () => ({ shaderSource: noop, compileShader: noop }),
        createProgram: () => ({ attachShader: noop, linkProgram: noop, useProgram: noop }),
        createTexture: () => ({ bindTexture: noop, texImage2D: noop, texParameteri: noop }),
        getParameter: () => 0,
        getAttribLocation: () => 0,
        getUniformLocation: () => ({}),
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getShaderInfoLog: () => '',
        getProgramInfoLog: () => '',
        getExtension: () => null,
        getSupportedExtensions: () => [],
        createBufferSource: () => ({ connect: noop, start: noop, stop: noop }),
        createTexture2D: () => ({})
    };
}

function makeAudioContext() {
    const param = { value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop, setTargetAtTime: noop };
    const node = () => ({
        connect: noop,
        disconnect: noop,
        start: noop,
        stop: noop,
        type: 'sine',
        buffer: null,
        loop: false,
        frequency: param,
        detune: param,
        gain: param,
        pan: param,
        Q: param,
        playbackRate: param
    });
    return {
        currentTime: 0,
        state: 'running',
        sampleRate: 44100,
        destination: node(),
        listener: { positionX: param, positionY: param, positionZ: param },
        createOscillator: node,
        createGain: node,
        createBiquadFilter: node,
        createBufferSource: node,
        createStereoPanner: node,
        createDelay: node,
        createDynamicsCompressor: node,
        createWaveShaper: node,
        createConvolver: node,
        createAnalyser: node,
        createMediaStreamSource: node,
        createMediaStreamDestination: node,
        createBuffer: () => ({ getChannelData: () => new Float32Array(1), length: 1 }),
        createScriptProcessor: node,
        resume: () => Promise.resolve(),
        suspend: () => Promise.resolve(),
        close: () => Promise.resolve(),
        startRendering: () => Promise.resolve()
    };
}

function makeStorage() {
    const data = new Map();
    return {
        getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
        setItem: (key, value) => { data.set(String(key), String(value)); },
        removeItem: (key) => { data.delete(String(key)); },
        clear: () => data.clear(),
        key: (index) => [...data.keys()][index] || null,
        get length() { return data.size; }
    };
}

function createSandbox() {
    const listeners = [];
    const timers = [];
    const frames = [];
    const elements = new Map();
    const root = makeElement('body', null, null);
    const context = makeContext2d(root);

    const document = {
        documentElement: null,
        body: null,
        head: null,
        title: '',
        readyState: 'loading',
        hidden: false,
        visibilityState: 'visible',
        activeElement: null,
        getElementById(id) {
            const key = String(id);
            if (!elements.has(key)) elements.set(key, makeElement('div', context, root));
            return elements.get(key);
        },
        querySelector: () => makeElement('div', context, root),
        querySelectorAll: () => [],
        getElementsByClassName: () => [],
        getElementsByTagName: () => [],
        createElement: (tag) => makeElement(tag, context, root),
        createElementNS: (ns, tag) => makeElement(tag, context, root),
        createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
        createDocumentFragment: () => makeElement('fragment', context, root),
        createEvent: () => ({ initEvent: noop }),
        addEventListener(type, handler) { listeners.push({ target: 'document', type: String(type), handler }); },
        removeEventListener: noop,
        dispatchEvent: () => true,
        elementFromPoint: () => null,
        execCommand: () => false,
        fonts: { ready: Promise.resolve(), load: () => Promise.resolve(), check: () => true },
        getSelection: () => ({ toString: () => '', rangeCount: 0, removeAllRanges: noop })
    };
    document.documentElement = makeElement('html', context, root);
    document.body = root;
    document.head = makeElement('head', context, root);

    const window = {
        innerWidth: VIEWPORT.width,
        innerHeight: VIEWPORT.height,
        outerWidth: VIEWPORT.width,
        outerHeight: VIEWPORT.height,
        devicePixelRatio: 3,
        screen: { width: VIEWPORT.width, height: VIEWPORT.height, availWidth: VIEWPORT.width, availHeight: VIEWPORT.height },
        document,
        addEventListener(type, handler) { listeners.push({ target: 'window', type: String(type), handler }); },
        removeEventListener: noop,
        dispatchEvent: () => true,
        requestAnimationFrame(handler) { frames.push(handler); return frames.length; },
        cancelAnimationFrame: noop,
        setTimeout(handler, delay) { timers.push({ handler, delay: Number(delay) || 0 }); return timers.length; },
        clearTimeout: noop,
        setInterval: () => 0,
        clearInterval: noop,
        getComputedStyle: () => ({ getPropertyValue: () => '', length: 0 }),
        matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
        localStorage: makeStorage(),
        sessionStorage: makeStorage(),
        location: { href: 'https://example.com/', origin: 'https://example.com', pathname: '/', search: '', hash: '', reload: noop, assign: noop, replace: noop },
        navigator: { userAgent: 'node', language: 'ru-RU', languages: ['ru-RU'], maxTouchPoints: 5, vibrate: noop, clipboard: { writeText: () => Promise.resolve() }, share: () => Promise.resolve() },
        performance: { now: () => 0, timeOrigin: 0 },
        alert: noop,
        confirm: () => true,
        prompt: () => null,
        scrollTo: noop,
        scrollBy: noop,
        postMessage: noop,
        Image: function Image() { return { width: 0, height: 0, src: '', complete: true, onload: null, onerror: null }; },
        Audio: function Audio() { return { play: () => Promise.resolve(), pause: noop, volume: 1, currentTime: 0, duration: 0, loop: false }; },
        AudioContext: function AudioContext() { return makeAudioContext(); },
        webkitAudioContext: function AudioContext() { return makeAudioContext(); },
        OfflineAudioContext: function OfflineAudioContext() { return makeAudioContext(); },
        Path2D: function Path2D() { return { addPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, rect: noop, quadraticCurveTo: noop, bezierCurveTo: noop }; },
        OffscreenCanvas: function OffscreenCanvas(width, height) {
            const offscreen = makeElement('canvas', null, null);
            offscreen.width = width || 300;
            offscreen.height = height || 150;
            return offscreen;
        },
        CanvasRenderingContext2D: function CanvasRenderingContext2D() { return makeContext2d(null); },
        MutationObserver: function MutationObserver() { return { observe: noop, disconnect: noop, takeRecords: () => [] }; },
        ResizeObserver: function ResizeObserver() { return { observe: noop, disconnect: noop, unobserve: noop }; },
        IntersectionObserver: function IntersectionObserver() { return { observe: noop, disconnect: noop, unobserve: noop }; },
        customElements: { define: noop, get: () => undefined },
        crypto: { getRandomValues: (array) => array },
        fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
        XMLHttpRequest: function XMLHttpRequest() { return { open: noop, send: noop, setRequestHeader: noop, addEventListener: noop, readyState: 0, status: 0, responseText: '' }; },
        structuredClone: (value) => JSON.parse(JSON.stringify(value)),
        requestIdleCallback: () => 0,
        cancelIdleCallback: noop
    };
    window.window = window;
    window.self = window;
    window.top = window;
    window.parent = window;
    window.frames = window;
    window.console = console;
    window.process = { env: {}, platform: 'browser', version: '', stdout: { write: noop }, stderr: { write: noop } };

    const sandbox = {
        window,
        document,
        self: window,
        top: window,
        parent: window,
        console: { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop },
        Math,
        Date,
        JSON,
        Promise,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        Set,
        Map,
        WeakMap,
        WeakSet,
        Symbol,
        Proxy,
        Reflect,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        setTimeout: window.setTimeout,
        clearTimeout: window.clearTimeout,
        setInterval: window.setInterval,
        clearInterval: window.clearInterval,
        requestAnimationFrame: window.requestAnimationFrame,
        cancelAnimationFrame: window.cancelAnimationFrame,
        Image: window.Image,
        Audio: window.Audio,
        AudioContext: window.AudioContext,
        webkitAudioContext: window.webkitAudioContext,
        Path2D: window.Path2D,
        OffscreenCanvas: window.OffscreenCanvas,
        CanvasRenderingContext2D: window.CanvasRenderingContext2D,
        MutationObserver: window.MutationObserver,
        ResizeObserver: window.ResizeObserver,
        IntersectionObserver: window.IntersectionObserver,
        localStorage: window.localStorage,
        sessionStorage: window.sessionStorage,
        location: window.location,
        navigator: window.navigator,
        performance: window.performance,
        fetch: window.fetch,
        XMLHttpRequest: window.XMLHttpRequest,
        structuredClone: window.structuredClone,
        getComputedStyle: window.getComputedStyle,
        matchMedia: window.matchMedia,
        alert: window.alert,
        confirm: window.confirm,
        prompt: window.prompt,
        scrollTo: window.scrollTo,
        scrollBy: window.scrollBy,
        crypto: window.crypto,
        process: window.process
    };
    sandbox.globalThis = sandbox;
    sandbox.self = window;

    const call = (entry) => {
        if (typeof entry.handler !== 'function') return;
        entry.handler({ type: entry.type, target: entry.target, preventDefault: noop, stopPropagation: noop });
    };

    sandbox.__flush = function flush() {
        const fire = (type) => {
            for (const entry of listeners.filter((item) => item.type === type)) call(entry);
        };
        fire('DOMContentLoaded');
        if (typeof window.onload === 'function') window.onload({ type: 'load' });
        fire('load');
        let timerRuns = 0;
        while (timers.length && timerRuns < MAX_TIMERS) {
            const timer = timers.shift();
            timerRuns += 1;
            call({ handler: timer.handler, type: 'timeout' });
        }
        let frameRuns = 0;
        while (frames.length && frameRuns < MAX_FRAMES) {
            const handler = frames.shift();
            frameRuns += 1;
            if (typeof handler === 'function') handler(0);
        }
    };

    return sandbox;
}

// По стеку находим, где именно код игры упал.
// Первый кадр — где произошло обращение, последний кадр игры — внешний вызов
// (он и указывает, перед каким оператором нужно объявить переменную).
function describeError(error, index) {
    const stack = String((error && error.stack) || '');
    const frames = [];
    const re = /game_(\d+)\.js:(\d+):(\d+)/g;
    let match;
    while ((match = re.exec(stack)) !== null) {
        frames.push({ script: Number(match[1]), line: Number(match[2]), column: Number(match[3]) });
    }
    const first = frames[0] || null;
    const last = frames[frames.length - 1] || null;
    return {
        script: index + 1,
        name: (error && error.name) || 'Error',
        message: (error && error.message) || String(error),
        line: first ? first.line : null,
        column: first ? first.column : null,
        callLine: last ? last.line : null,
        callScript: last ? last.script : null
    };
}

function runScripts(scripts, timeout = 1500) {
    const list = Array.isArray(scripts) ? scripts : [];
    const errors = [];
    for (let index = 0; index < list.length; index += 1) {
        const code = String(list[index] || '');
        if (!code) continue;
        const sandbox = createSandbox();
        const context = makeVmContext(sandbox);
        try {
            vm.runInContext(code, context, { timeout, filename: `game_${index + 1}.js` });
        } catch (error) {
            errors.push(describeError(error, index));
            break;
        }
        try {
            vm.runInContext('__flush()', context, { timeout, filename: `game_${index + 1}_hooks.js` });
        } catch (error) {
            errors.push(describeError(error, index));
            break;
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = { runScripts };

if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
        let payload = { scripts: [], timeout: 1500 };
        try {
            payload = JSON.parse(input) || payload;
        } catch (error) {
            payload = { scripts: [], timeout: 1500 };
        }
        let result;
        try {
            result = runScripts(payload.scripts, payload.timeout);
        } catch (error) {
            result = { ok: false, errors: [{ script: 0, name: (error && error.name) || 'Error', message: (error && error.message) || String(error) }] };
        }
        process.stdout.write(JSON.stringify(result));
    });
}
