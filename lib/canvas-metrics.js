const PROBE_TYPE = 'gf-canvas-metrics';
const MAX_COLORS = 4096;
const MAX_SHADES = 16;
const MAX_SCREENSHOT_CHARS = 180000;
const MAX_SCREENSHOT_BYTES = 140000;

function buildProbeScript(options = {}) {
    const gameId = String(options.gameId || '');
    const token = String(options.token || '');
    return `(function(){
try {
  var GAME_ID = ${JSON.stringify(gameId)};
  var TOKEN = ${JSON.stringify(token)};
  var MAX_SAMPLES = 8;
  var SIG_CELLS = 16;
  var ANIMATION_THRESHOLD = 0.6;
  var samples = [];
  var animated = false;
  var fps = 0;
  var fpsValid = false;
  var fpsFrames = 0;
  var fpsStarted = 0;
  var frameSent = false;
  var interacted = false;

  function pickCanvas() {
    var list = document.querySelectorAll('canvas');
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i];
      if (!candidate || !candidate.width || !candidate.height) continue;
      if (!best || candidate.width * candidate.height > best.width * best.height) best = candidate;
    }
    return best;
  }

  function measure(canvas) {
    var size = 64;
    var off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    var ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, size, size);
    var data = ctx.getImageData(0, 0, size, size).data;
    var colors = {};
    var shades = {};
    var covered = 0;
    var lumSum = 0;
    var lumSq = 0;
    var sigSum = new Array(SIG_CELLS * SIG_CELLS);
    var sigCount = new Array(SIG_CELLS * SIG_CELLS);
    for (var i = 0; i < sigSum.length; i++) { sigSum[i] = 0; sigCount[i] = 0; }
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      covered++;
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      colors[(r >> 4) + '_' + (g >> 4) + '_' + (b >> 4)] = 1;
      var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      lumSum += lum;
      lumSq += lum * lum;
      var shade = Math.floor(lum * 16);
      shades[shade > 15 ? 15 : shade] = 1;
      var cell = ((i / 4) % size >> 2) + SIG_CELLS * (Math.floor(i / 4 / size) >> 2);
      sigSum[cell] += lum * 255;
      sigCount[cell] += 1;
    }
    var mean = covered ? lumSum / covered : 0;
    var variance = covered ? Math.max(0, lumSq / covered - mean * mean) : 0;
    var signature = new Array(SIG_CELLS * SIG_CELLS);
    for (var c = 0; c < signature.length; c++) {
      signature[c] = sigCount[c] ? Math.round(sigSum[c] / sigCount[c]) : 0;
    }
    return {
      coverage: Math.round((covered / (size * size)) * 1000) / 1000,
      colors: Object.keys(colors).length,
      shades: Object.keys(shades).length,
      contrast: Math.round(Math.sqrt(variance) * 1000) / 1000,
      brightness: Math.round(mean * 1000) / 1000,
      width: canvas.width,
      height: canvas.height,
      signature: signature
    };
  }

  function signatureDiff(a, b) {
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
      var d = a[i] - b[i];
      sum += d < 0 ? -d : d;
    }
    return sum / a.length;
  }

  function richness(metric) {
    return metric.colors + metric.shades + Math.round(metric.coverage * 20);
  }

  function countFps(time) {
    if (!fpsStarted) {
      fpsStarted = time;
      fpsFrames = 0;
    }
    fpsFrames++;
    var elapsed = time - fpsStarted;
    if (elapsed < 1000) {
      requestAnimationFrame(countFps);
    } else {
      fps = Math.round(fpsFrames * 1000 / elapsed);
      fpsValid = !document.hidden;
    }
  }

  function capture(canvas) {
    try {
      var width = 320;
      var height = Math.max(1, Math.round(canvas.height * width / canvas.width));
      if (height > 640) {
        height = 640;
        width = Math.max(1, Math.round(canvas.width * height / canvas.height));
      }
      var off = document.createElement('canvas');
      off.width = width;
      off.height = height;
      var context = off.getContext('2d');
      if (!context) return null;
      context.drawImage(canvas, 0, 0, width, height);
      var data = off.toDataURL('image/jpeg', 0.6);
      if (!data || data.length < 2048 || data.length > ${MAX_SCREENSHOT_CHARS}) return null;
      return data;
    } catch (error) {
      return null;
    }
  }

  function takeSample() {
    var canvas = pickCanvas();
    if (!canvas) return;
    var metric = null;
    try {
      metric = measure(canvas);
    } catch (error) {
      return;
    }
    if (!metric) return;
    var previous = samples.length ? samples[samples.length - 1] : null;
    if (previous && previous.signature && signatureDiff(previous.signature, metric.signature) > ANIMATION_THRESHOLD) {
      animated = true;
    }
    samples.push(metric);
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  function report() {
    if (!samples.length) return;
    var best = samples[0];
    for (var i = 1; i < samples.length; i++) {
      if (richness(samples[i]) > richness(best)) best = samples[i];
    }
    var screenshot = null;
    if (!frameSent && best.coverage >= 0.02 && (interacted || (animated && best.coverage > 0.15))) {
      var canvas = pickCanvas();
      if (canvas) {
        screenshot = capture(canvas);
        frameSent = Boolean(screenshot);
      }
    }
    var payload = {
      type: ${JSON.stringify(PROBE_TYPE)},
      gameId: GAME_ID,
      token: TOKEN,
      screenshot: screenshot,
      metrics: {
        coverage: best.coverage,
        colors: best.colors,
        shades: best.shades,
        contrast: best.contrast,
        brightness: best.brightness,
        animated: animated,
        samples: samples.length,
        fps: fpsValid ? fps : 0,
        width: best.width,
        height: best.height
      }
    };
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(payload, '*');
    } catch (error) {}
  }

  function schedule(delay, sendReport) {
    setTimeout(function () {
      takeSample();
      if (sendReport) report();
    }, delay);
  }

  if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    requestAnimationFrame(countFps);
  }
  schedule(1200, false);
  schedule(3500, true);
  schedule(7000, true);
  schedule(12000, true);
  function onInteract() {
    interacted = true;
    schedule(1200, true);
  }
  window.addEventListener('pointerdown', onInteract, { passive: true });
  window.addEventListener('touchstart', onInteract, { passive: true });
  window.addEventListener('keydown', onInteract, { passive: true });
} catch (error) {}
})();`;
}

function buildForwarderScript(options = {}) {
    const gameId = String(options.gameId || '');
    const token = String(options.token || '');
    return `(function(){
try {
  var GAME_ID = ${JSON.stringify(gameId)};
  var TOKEN = ${JSON.stringify(token)};
  var frame = document.getElementById('gf-game-frame');
  window.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(PROBE_TYPE)}) return;
    if (data.gameId !== GAME_ID || data.token !== TOKEN) return;
    if (!data.metrics) return;
    fetch('/api/canvas-metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: GAME_ID, token: TOKEN, metrics: data.metrics, screenshot: data.screenshot || null })
    }).catch(function () {});
  });
} catch (error) {}
})();`;
}

function numberInRange(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (number < min || number > max) return null;
    return number;
}

function isValidMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    const coverage = numberInRange(metrics.coverage, 0, 1);
    const colors = numberInRange(metrics.colors, 0, MAX_COLORS);
    const shades = numberInRange(metrics.shades, 0, MAX_SHADES);
    const contrast = numberInRange(metrics.contrast, 0, 1);
    if (coverage === null || colors === null || shades === null || contrast === null) return false;
    if (metrics.fps !== undefined && metrics.fps !== null && numberInRange(metrics.fps, 0, 240) === null) return false;
    return true;
}

function decodeScreenshot(value) {
    if (typeof value !== 'string') return null;
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
    if (!match) return null;
    const base64 = match[1].replace(/\s+/g, '');
    if (base64.length > MAX_SCREENSHOT_CHARS) return null;
    let buffer;
    try {
        buffer = Buffer.from(base64, 'base64');
    } catch (error) {
        return null;
    }
    if (buffer.length < 1024 || buffer.length > MAX_SCREENSHOT_BYTES) return null;
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) return null;
    return buffer;
}

function scoreMetrics(metrics) {
    const coverage = Number(metrics.coverage) || 0;
    const colors = Number(metrics.colors) || 0;
    const shades = Number(metrics.shades) || 0;
    const contrast = Number(metrics.contrast) || 0;
    const animated = metrics.animated === true;
    const fps = Number(metrics.fps);

    const issues = [];
    let penalty = 0;
    const add = (code, value, msg) => {
        issues.push({ code, penalty: value, msg });
        penalty += value;
    };

    const blank = coverage < 0.01 && colors < 3;
    if (blank) {
        add('blank_canvas', 100, 'экран остаётся пустым: игра ничего не рисует');
    } else {
        if (colors < 4) add('weak_palette', 25, `палитра бедная: ${colors} цвета вместо 4-6`);
        if (coverage < 0.06) add('empty_screen', 20, 'экран почти пуст: рисунок занимает меньше 6% кадра');
        if (shades < 3) add('flat_shading', 12, 'нет объёма: всего 1-2 тона яркости');
        if (contrast < 0.05) add('low_contrast', 15, 'контраст низкий: объекты не читаются на фоне');
        if (!animated) add('no_animation', 8, 'кадр не меняется: игра выглядит статичной');
        if (Number.isFinite(fps) && fps > 0) {
            if (fps < 10) add('low_fps', 40, `игра идёт на ${Math.round(fps)} FPS вместо 60 — управлять невозможно`);
            else if (fps < 20) add('low_fps', 25, `низкий FPS (${Math.round(fps)}) — игра тормозит на телефоне`);
            else if (fps < 30) add('low_fps', 10, `FPS ниже комфортного (${Math.round(fps)})`);
        }
    }

    const score = Math.max(0, 100 - penalty);
    return { score, ceiling: score, blank, issues, coverage, colors, shades, contrast, animated };
}

function calibrationOffset(samples) {
    const list = (samples || []).filter((sample) => sample
        && Number.isFinite(Number(sample.staticScore))
        && Number.isFinite(Number(sample.measuredScore)));
    if (list.length < 5) return null;
    const deltas = list
        .map((sample) => Number(sample.measuredScore) - Number(sample.staticScore))
        .sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    return Math.max(-20, Math.min(0, Math.round(median)));
}

module.exports = {
    PROBE_TYPE,
    buildProbeScript,
    buildForwarderScript,
    isValidMetrics,
    decodeScreenshot,
    scoreMetrics,
    calibrationOffset
};
