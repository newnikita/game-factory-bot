// Детерминированный слой оформления для игр: виньетка, зерно и мягкая
// цветокоррекция. Не трогает логику и не требует запросов к модели.
const STYLE_ID = 'gf-visual-layer';
const OVERLAY_IDS = ['gf-vignette', 'gf-grain'];

const STYLE = `
html,body{overscroll-behavior:none}
body{filter:saturate(1.06) contrast(1.02);-webkit-tap-highlight-color:transparent}
#gf-vignette{position:fixed;inset:0;pointer-events:none;z-index:2147483000;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 58%,rgba(0,0,0,.1) 82%,rgba(0,0,0,.28) 100%)}
#gf-vignette::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,0) 20%,rgba(0,0,0,0) 82%,rgba(0,0,0,.12))}
#gf-grain{position:fixed;inset:0;pointer-events:none;z-index:2147483001;opacity:.045;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='.6'/></svg>")}
@media (prefers-reduced-motion:reduce){#gf-grain{opacity:.03}}
`;

const OVERLAYS = '<div id="gf-vignette" aria-hidden="true"></div><div id="gf-grain" aria-hidden="true"></div>';

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
    if (/<\/body>/i.test(out)) {
        out = out.replace(/<\/body>/i, `${OVERLAYS}</body>`);
    } else {
        out = `${out}${OVERLAYS}`;
    }
    return out;
}

module.exports = {
    STYLE_ID,
    OVERLAY_IDS,
    enhanceGameHtml
};
