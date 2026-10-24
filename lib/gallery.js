const { escapeHtml } = require('./security');
const { detectGenre } = require('./game-design');
const { GENRE_LABELS } = require('./covers');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function botLink(username) {
    const name = String(username || '').trim().replace(/^@/, '');
    return name ? `https://t.me/${encodeURIComponent(name)}` : '';
}

function formatDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function sourceLabel(source) {
    if (source === 'hybrid') return 'Движок + ИИ';
    if (source === 'template') return 'Шаблон';
    return 'ИИ';
}

const STYLE = `
:root{--bg:#080b18;--card:#111736;--line:#263060;--text:#eef1ff;--muted:#9aa3d4;--accent:#7c8cff;--accent2:#39d3c4;--radius:16px}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:radial-gradient(1100px 650px at 12% -10%,#1b2350 0%,var(--bg) 55%),radial-gradient(900px 560px at 95% 0%,#152a4a 0%,transparent 60%),var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:28px}
.logo{font-size:22px;font-weight:700;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent;text-decoration:none}
nav{display:flex;gap:18px;flex-wrap:wrap;align-items:center}
nav a{color:var(--muted);text-decoration:none;font-size:15px}
nav a:hover{color:var(--text)}
.btn{display:inline-block;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;border:1px solid transparent}
.btn-primary{background:linear-gradient(90deg,var(--accent),var(--accent2));color:#08102b}
.btn-ghost{border-color:var(--line);color:var(--text);background:rgba(255,255,255,.03)}
.hero{padding:26px 0 34px;max-width:780px}
.hero h1{font-size:clamp(28px,5vw,44px);line-height:1.16;margin:0 0 14px}
.hero p{color:#c3cafa;margin:0 0 24px;font-size:clamp(16px,2.2vw,19px)}
.actions{display:flex;gap:12px;flex-wrap:wrap}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.card{display:block;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.01));border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;text-decoration:none;color:inherit;transition:transform .15s ease,border-color .15s ease}
.card:hover{transform:translateY(-2px);border-color:var(--accent)}
.cover{display:block;aspect-ratio:1200/630;background:#0b1030;overflow:hidden}
.cover img{display:block;width:100%;height:100%;object-fit:cover}
.body{display:block;padding:16px 18px 18px}
.title{display:block;font-weight:700;font-size:17px;line-height:1.35;margin-bottom:6px}
.meta{display:block;color:var(--muted);font-size:14px}
.empty{border:1px dashed var(--line);border-radius:var(--radius);padding:34px 24px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--text);font-size:18px;margin-bottom:8px}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:26px}
footer{border-top:1px solid var(--line);margin-top:52px;padding-top:22px;color:var(--muted);font-size:14px}
footer .links{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px}
footer .links a{color:#c3caff;text-decoration:none}
footer .links a:hover{text-decoration:underline}
@media (max-width:640px){.wrap{padding:20px 16px 48px}}
`;

function renderGallery(options = {}) {
    const games = Array.isArray(options.games) ? options.games : [];
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const limit = Math.max(1, Number.parseInt(options.limit, 10) || 24);
    const botUrl = botLink(options.botUsername);
    const cta = botUrl
        ? `<a class="btn btn-primary" href="${escapeHtml(botUrl)}">Создать свою игру</a>`
        : '';
    const cards = games.map((game) => {
        const id = String(game.id || '');
        const title = String(game.title || 'Игра');
        const genre = GENRE_LABELS[detectGenre(title)] || 'Игра';
        const date = formatDate(game.created_at);
        const meta = [genre, sourceLabel(game.source), date].filter(Boolean).join(' · ');
        return `<a class="card" href="/play/${encodeURIComponent(id)}">
          <span class="cover"><img src="/covers/${encodeURIComponent(id)}.svg" alt="Обложка игры ${escapeHtml(title)}" width="1200" height="630" loading="lazy"></span>
          <span class="body">
            <span class="title">${escapeHtml(title)}</span>
            <span class="meta">${escapeHtml(meta)}</span>
          </span>
        </a>`;
    }).join('');

    const content = cards
        ? `<div class="grid">${cards}</div>`
        : `<div class="empty"><b>В галерее пока пусто</b>Создай игру в боте и нажми «Опубликовать в галерее» — она появится здесь.</div>`;

    const pager = [
        page > 1 ? `<a class="btn btn-ghost" href="/gallery?page=${page - 1}">← Назад</a>` : '<span></span>',
        games.length >= limit ? `<a class="btn btn-ghost" href="/gallery?page=${page + 1}">Дальше →</a>` : '<span></span>'
    ].join('');

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Галерея игр сообщества — Фабрика Игр</title>
<meta name="description" content="Игры, созданные пользователями «Фабрики Игр»: играй в браузере и делай свою по описанию за пару минут.">
<meta property="og:title" content="Галерея игр сообщества — Фабрика Игр">
<meta property="og:description" content="Игры, созданные пользователями «Фабрики Игр»: играй в браузере и делай свою.">
<meta property="og:type" content="website">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="logo" href="/">🎮 Фабрика Игр</a>
    <nav>
      <a href="/">Главная</a>
      <a href="/gallery">Галерея</a>
      <a href="/legal">Документы</a>
    </nav>
  </header>
  <div class="hero">
    <h1>Галерея игр сообщества</h1>
    <p>Игры, которые пользователи собрали в боте и решили показать. Можно играть сразу в браузере — и сделать свою по описанию.</p>
    <div class="actions">
      ${cta}
      <a class="btn btn-ghost" href="/">← На главную</a>
    </div>
  </div>
  ${content}
  <div class="pager">${pager}</div>
  <footer>
    <div class="links">
      <a href="/legal/offer.md">Оферта</a>
      <a href="/legal/privacy.md">Конфиденциальность</a>
      <a href="/legal/rules.md">Правила</a>
      <a href="/legal/refunds.md">Возвраты</a>
      <a href="/legal/license.md">Лицензия</a>
    </div>
    <div>© ${new Date().getFullYear()} Фабрика Игр. Игры созданы пользователями с помощью нейросети.</div>
  </footer>
</div>
</body>
</html>`;
}

module.exports = {
    renderGallery,
    formatDate,
    sourceLabel
};
