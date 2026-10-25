// Детерминированный слой оформления для игр: виньетка, зерно и мягкая
// цветокоррекция. Не трогает логику и не требует запросов к модели.
const STYLE_ID = 'gf-visual-layer';
const SCRIPT_ID = 'gf-atmosphere-script';
const OVERLAY_IDS = ['gf-vignette', 'gf-grain', 'gf-atmosphere'];

const STYLE = `
html,body{overscroll-behavior:none}
body{filter:saturate(1.06) contrast(1.02);-webkit-tap-highlight-color:transparent}
#gf-vignette{position:fixed;inset:0;pointer-events:none;z-index:2147483000;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 58%,rgba(0,0,0,.1) 82%,rgba(0,0,0,.28) 100%)}
#gf-vignette::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,0) 20%,rgba(0,0,0,0) 82%,rgba(0,0,0,.12))}
#gf-grain{position:fixed;inset:0;pointer-events:none;z-index:2147483001;opacity:.045;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='.6'/></svg>")}
#gf-atmosphere{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483002;mix-blend-mode:screen;opacity:.55}
@media (prefers-reduced-motion:reduce){#gf-grain{opacity:.03}#gf-atmosphere{display:none}}
`;

const OVERLAYS = '<div id="gf-vignette" aria-hidden="true"></div><div id="gf-grain" aria-hidden="true"></div><canvas id="gf-atmosphere" aria-hidden="true"></canvas>';

const ATMOSPHERE_SCRIPT = `(function(){
try {
  var canvas = document.getElementById('gf-atmosphere');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var width = 0;
  var height = 0;
  var particles = [];
  var last = 0;

  function seed() {
    var count = Math.max(18, Math.min(42, Math.round(width * height / 26000)));
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.6 + Math.random() * 1.5,
        vx: (Math.random() - 0.5) * 0.08,
        vy: -(0.05 + Math.random() * 0.16),
        a: 0.06 + Math.random() * 0.16,
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function frame(time) {
    if (!last) last = time;
    var dt = Math.min((time - last) / 1000, 0.05);
    last = time;
    if (!document.hidden) {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#dfe8ff';
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx * 60 * dt;
        p.y += p.vy * 60 * dt;
        if (p.y < -4) { p.y = height + 4; p.x = Math.random() * width; }
        if (p.x < -4) p.x = width + 4;
        if (p.x > width + 4) p.x = -4;
        var twinkle = 0.75 + 0.25 * Math.sin(time / 900 + p.phase);
        ctx.globalAlpha = p.a * twinkle;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });
  if (!reduced) requestAnimationFrame(frame);
} catch (error) {}
})();`;

function alreadyEnhanced(html) {
    return html.includes(`id="${STYLE_ID}"`);
}

function enhanceGameHtml(html) {
    if (typeof html !== 'string' || !html.trim()) return html;
    if (alreadyEnhanced(html)) return html;

    const styleTag = `<style id="${STYLE_ID}">${STYLE}</style>`;
    let out = html;
    if (/<\/head>/i.test(out)) {
        out = out.replace(/<\/head>/i, `${styleTag}</head>`);
    } else {
        out = `${styleTag}${out}`;
    }
    const injection = `${OVERLAYS}<script id="${SCRIPT_ID}">${ATMOSPHERE_SCRIPT}</script>`;
    if (/<\/body>/i.test(out)) {
        out = out.replace(/<\/body>/i, `${injection}</body>`);
    } else {
        out = `${out}${injection}`;
    }
    return out;
}

module.exports = {
    STYLE_ID,
    SCRIPT_ID,
    OVERLAY_IDS,
    enhanceGameHtml
};
