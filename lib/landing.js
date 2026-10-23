const { escapeHtml } = require('./security');
const { PLANS, gamesLabel } = require('./plans');

const DEMO_GAMES = [
    { slug: 'bubble', title: 'Бабл-шутер', text: 'Лопай пузыри и уворачивайся от пауков' },
    { slug: 'tetris', title: 'Тетрис', text: 'Классика с ускорением и бустерами' },
    { slug: 'platformer', title: 'Платформер', text: 'Прыжки, монеты и шипы' },
    { slug: 'shooter', title: 'Шутер', text: 'Арена, враги и выстрелы' },
    { slug: 'arkanoid', title: 'Арканоид', text: 'Отбивай кирпич и не теряй мяч' }
];

const PILLARS = [
    { title: '2 минуты вместо 2 недель', text: 'Описываете идею — бот уточняет детали и собирает игру.' },
    { title: 'Не нужен разработчик', text: 'Ни кода, ни движков, ни сборки: всё внутри одного чата.' },
    { title: 'Исходники и лицензия', text: 'Игру можно скачать кодом и использовать в своих проектах.' }
];

const STEPS = [
    'Напишите идею: «арканоид про космос».',
    'Бот задаст пару уточнений и покажет план игры.',
    'Через пару минут игра готова: играйте, скачивайте исходники, улучшайте по запросу.'
];

const DOCS = [
    { file: 'offer.md', title: 'Публичная оферта' },
    { file: 'privacy.md', title: 'Политика конфиденциальности' },
    { file: 'rules.md', title: 'Правила использования' },
    { file: 'refunds.md', title: 'Политика возвратов' },
    { file: 'license.md', title: 'Лицензия на игры' }
];

function botLink(username) {
    const name = String(username || '').trim().replace(/^@/, '');
    return name ? `https://t.me/${encodeURIComponent(name)}` : '';
}

function renderLanding(options) {
    const opts = options || {};
    const botUrl = botLink(opts.botUsername);
    const base = String(opts.baseUrl || '').replace(/\/+$/, '');
    const support = opts.support || {};
    const plans = Object.values(PLANS).filter((plan) => plan && plan.id);

    const cta = botUrl
        ? `<a class="btn btn-primary" href="${escapeHtml(botUrl)}">Открыть бота</a>`
        : '<span class="btn btn-primary is-disabled">Бот скоро откроется</span>';

    const planCards = plans.map((plan) => `
        <article class="plan">
          <div class="plan-badge">${escapeHtml(plan.badge || '')}</div>
          <h3>${escapeHtml(plan.title)}</h3>
          <p class="plan-desc">${escapeHtml(plan.description || '')}</p>
          <div class="plan-price"><span class="plan-stars">${escapeHtml(String(plan.stars))} ⭐</span><span class="plan-rub">≈ ${escapeHtml(String(plan.rub))} ₽</span></div>
          <div class="plan-games">${escapeHtml(gamesLabel(plan.games))}${plan.periodDays ? ' в месяц' : ''}</div>
          ${botUrl ? `<a class="btn btn-ghost" href="${escapeHtml(botUrl)}">Получить в боте</a>` : ''}
        </article>`).join('');

    const demoCards = DEMO_GAMES.map((game) => `
        <article class="demo">
          <a class="demo-link" href="/${escapeHtml(game.slug)}/" target="_blank" rel="noopener">
            <span class="demo-art demo-art-${escapeHtml(game.slug)}"></span>
            <span class="demo-title">${escapeHtml(game.title)}</span>
            <span class="demo-text">${escapeHtml(game.text)}</span>
            <span class="demo-cta">Играть прямо в браузере →</span>
          </a>
        </article>`).join('');

    const docLinks = DOCS.map((doc) =>
        `<a href="/legal/${encodeURIComponent(doc.file)}">${escapeHtml(doc.title)}</a>`
    ).join('');

    const supportBlock = [
        support['[@username]'] ? `<span>Telegram: ${escapeHtml(support['[@username]'])}</span>` : '',
        support['[email]'] ? `<span>Почта: ${escapeHtml(support['[email]'])}</span>` : ''
    ].filter(Boolean).join(' · ');

    const stepsHtml = STEPS.map((step, index) => `
        <li><span class="step-num">${index + 1}</span><span>${escapeHtml(step)}</span></li>`).join('');

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Фабрика Игр — Telegram-бот, который делает игры по описанию</title>
<meta name="description" content="Опишите игру одним предложением — получите готовую HTML5-игру для Telegram за 2 минуты. Без кода, с исходниками и коммерческой лицензией.">
<meta property="og:title" content="Фабрика Игр — игры по описанию за 2 минуты">
<meta property="og:description" content="Telegram-бот собирает готовую HTML5-игру по вашему описанию: план, графика, исходники и лицензия.">
<meta property="og:type" content="website">
<link rel="canonical" href="${escapeHtml(base || '/')}">
<style>
:root{--bg:#080b18;--bg2:#0f1430;--card:#141a3a;--line:#263060;--text:#eef1ff;--muted:#9aa3d4;--accent:#7c8cff;--accent2:#39d3c4;--radius:16px}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:radial-gradient(1200px 700px at 15% -10%,#1b2350 0%,var(--bg) 55%),radial-gradient(900px 600px at 95% 0%,#152a4a 0%,transparent 60%),var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.logo{font-size:22px;font-weight:700;letter-spacing:.2px;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
nav{display:flex;gap:18px;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;font-size:15px}
nav a:hover{color:var(--text)}
.hero{padding:64px 0 40px;max-width:760px}
.hero h1{font-size:clamp(30px,6vw,48px);line-height:1.15;margin:0 0 18px}
.hero p.lead{font-size:clamp(17px,2.4vw,21px);color:#c3cafa;margin:0 0 28px}
.actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;padding:13px 24px;border-radius:12px;text-decoration:none;font-weight:600;font-size:16px;border:1px solid transparent;transition:transform .15s ease,filter .15s ease}
.btn:hover{transform:translateY(-1px)}
.btn-primary{background:linear-gradient(90deg,var(--accent),var(--accent2));color:#08102b}
.btn-ghost{border-color:var(--line);color:var(--text);background:rgba(255,255,255,.03)}
.btn.is-disabled{opacity:.55;pointer-events:none}
.note{color:var(--muted);font-size:14px}
section{margin:56px 0}
h2{font-size:clamp(22px,3.4vw,30px);margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 26px}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.pillar,.plan,.demo{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.01));border:1px solid var(--line);border-radius:var(--radius);padding:22px}
.pillar h3{font-size:18px;margin:0 0 8px}
.pillar p{margin:0;color:var(--muted)}
.steps{list-style:none;padding:0;margin:0;display:grid;gap:14px}
.steps li{display:flex;gap:14px;align-items:flex-start;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.step-num{flex:0 0 28px;height:28px;border-radius:50%;background:linear-gradient(90deg,var(--accent),var(--accent2));color:#08102b;display:grid;place-items:center;font-weight:700;font-size:15px}
.demo{padding:0;overflow:hidden}
.demo-link{display:block;padding:0 0 18px;color:inherit;text-decoration:none}
.demo-art{display:block;height:120px;margin-bottom:16px;background-size:auto,auto,auto;background-position:center;background-repeat:no-repeat}
.demo-art-bubble{background-image:radial-gradient(circle at 26% 42%,#ff8ad8 0 11%,transparent 12%),radial-gradient(circle at 58% 26%,#6fd3ff 0 15%,transparent 16%),radial-gradient(circle at 78% 66%,#9dff8a 0 9%,transparent 10%),linear-gradient(160deg,#1d2456,#0d1130)}
.demo-art-tetris{background-image:repeating-linear-gradient(90deg,rgba(111,211,255,.55) 0 16px,transparent 16px 34px),repeating-linear-gradient(0deg,rgba(111,211,255,.55) 0 16px,transparent 16px 34px),linear-gradient(160deg,#1d2456,#0d1130);background-size:auto,auto,auto;background-position:0 0,0 0,center}
.demo-art-platformer{background-image:radial-gradient(circle at 72% 34%,#ffd166 0 7%,transparent 8%),linear-gradient(#39d3c4 0 0),linear-gradient(160deg,#2a356e 0 62%,#141a3a 62% 100%);background-size:auto,34% 9%,auto;background-position:0 0,10% 72%,0 0;background-repeat:no-repeat,no-repeat,no-repeat}
.demo-art-shooter{background-image:radial-gradient(circle at 50% 52%,rgba(255,123,107,.95) 0 7%,transparent 8%),radial-gradient(circle at 50% 52%,transparent 0 24%,rgba(255,255,255,.3) 24% 25%,transparent 26%),linear-gradient(160deg,#3a1f4e,#0d1130);background-size:auto,auto,auto;background-position:center}
.demo-art-arkanoid{background-image:repeating-linear-gradient(90deg,rgba(255,138,216,.85) 0 20px,transparent 20px 30px),repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 12px,transparent 12px 15px),linear-gradient(160deg,#1d2456,#0d1130);background-size:auto 58%,auto 58%,auto;background-position:0 0,0 0,center;background-repeat:repeat-x,repeat-x,no-repeat}
.demo-title{display:block;font-weight:600;margin:0 18px 4px}
.demo-text{display:block;color:var(--muted);font-size:15px;margin:0 18px 10px}
.demo-cta{display:block;color:var(--accent2);font-size:15px;margin:0 18px}
.plan{position:relative}
.plan-badge{position:absolute;top:16px;right:16px;font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(124,140,255,.18);color:#c3caff}
.plan h3{margin:0 0 6px;font-size:19px}
.plan-desc{margin:0 0 14px;color:var(--muted);min-height:42px}
.plan-price{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}
.plan-stars{font-size:26px;font-weight:700}
.plan-rub{color:var(--muted)}
.plan-games{color:#c3cafa;margin-bottom:16px}
footer{border-top:1px solid var(--line);margin-top:56px;padding-top:24px;color:var(--muted);font-size:14px}
footer .links{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px}
footer .links a{color:#c3caff;text-decoration:none}
footer .links a:hover{text-decoration:underline}
@media (max-width:640px){.hero{padding:40px 0 24px}.wrap{padding:20px 16px 48px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">🎮 Фабрика Игр</div>
    <nav>
      <a href="#how">Как это работает</a>
      <a href="#examples">Примеры</a>
      <a href="#pricing">Тарифы</a>
      <a href="/legal">Документы</a>
    </nav>
  </header>

  <div class="hero">
    <h1>Опишите игру одним предложением — получите готовую игру за 2 минуты</h1>
    <p class="lead">Telegram-бот придумывает план, рисует графику, собирает HTML5-игру и отдаёт её с исходниками. Без кода и без разработчика.</p>
    <div class="actions">
      ${cta}
      <a class="btn btn-ghost" href="#examples">Посмотреть примеры</a>
    </div>
    <p class="note">Оплата внутри Telegram — Telegram Stars. Подписки продлеваются автоматически, отменить можно в настройках Telegram.</p>
  </div>

  <section id="how">
    <h2>Как это работает</h2>
    <p class="sub">Три шага от идеи до играбельной игры.</p>
    <ol class="steps">${stepsHtml}</ol>
    <div class="grid" style="margin-top:18px">
      ${PILLARS.map((pillar) => `
      <div class="pillar">
        <h3>${escapeHtml(pillar.title)}</h3>
        <p>${escapeHtml(pillar.text)}</p>
      </div>`).join('')}
    </div>
  </section>

  <section id="examples">
    <h2>Примеры игр</h2>
    <p class="sub">Эти игры открываются прямо в браузере — их можно попробовать до покупки.</p>
    <div class="grid">${demoCards}</div>
  </section>

  <section id="pricing">
    <h2>Тарифы</h2>
    <p class="sub">Игры можно тратить на генерацию, улучшение и перегенерацию.</p>
    <div class="grid">${planCards}</div>
  </section>

  <footer>
    <div class="links">${docLinks}</div>
    ${supportBlock ? `<div>${supportBlock}</div>` : ''}
    <div>© ${new Date().getFullYear()} Фабрика Игр. Игры сделаны с помощью нейросети — проверяйте их перед публикацией.</div>
  </footer>
</div>
</body>
</html>`;
}

function renderRobots(base) {
    const host = String(base || '').replace(/\/+$/, '') || '';
    return `User-agent: *\nAllow: /\nDisallow: /play/\nDisallow: /sandbox/\nDisallow: /ai_games/\nDisallow: /test-games/\nSitemap: ${host}/sitemap.xml\n`;
}

function renderSitemap(base, paths) {
    const host = String(base || '').replace(/\/+$/, '') || '';
    const urls = (paths || ['/', '/legal']).map((item) => `  <url><loc>${host}${item}</loc></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

module.exports = {
    DEMO_GAMES,
    DOCS,
    botLink,
    renderLanding,
    renderRobots,
    renderSitemap
};
