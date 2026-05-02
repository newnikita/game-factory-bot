require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const express = require('express');
const fse = require('fs-extra');

// === 🛡️ СИСТЕМА АНТИ-КРАШ ===
process.on('uncaughtException', (err) => console.error('❌ Ошибка:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Ошибка сети:', err.message));

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// === 📊 БАЗА ДАННЫХ БИОМОВ (5 СТИЛЕЙ) ===
const styles = {
    'silent_stars': { 
        name: 'Немые Звезды',
        bg: '#050510', 
        block: '#E0E0FF', 
        img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1080&auto=format&fit=crop',
        font: '"Courier New", monospace',
        shadow: '0 0 15px rgba(224, 224, 255, 0.5)',
        vibe: 'melancholic_orchestral'
    }, 
    'credo_fantasy': { 
        name: 'Темное Фэнтези',
        bg: '#110000', 
        block: '#8B0000', 
        img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop',
        font: '"Palatino Linotype", "Book Antiqua", serif',
        shadow: '0 0 20px rgba(139, 0, 0, 0.8)',
        vibe: 'dark_orchestral_metal'
    }, 
    'ghibli_forest': { 
        name: 'Волшебный Лес',
        bg: '#1E3B27', 
        block: '#A8E6CF', 
        img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1080&auto=format&fit=crop',
        font: '"Comic Sans MS", cursive, sans-serif',
        shadow: '2px 2px 5px rgba(0, 0, 0, 0.3)',
        vibe: 'calm_acoustic'
    },
    'neon_tokyo': { 
        name: 'Неоновый Токио',
        bg: '#090014', 
        block: '#FF00FF', 
        img: 'https://images.unsplash.com/photo-1555580399-5ddb9eb8518e?q=80&w=1080&auto=format&fit=crop',
        font: '"Trebuchet MS", sans-serif',
        shadow: '0 0 10px #00FFFF, 0 0 20px #FF00FF',
        vibe: 'j_pop_dynamic'
    },
    'wasteland': { 
        name: 'Ржавая Пустошь',
        bg: '#2B1D14', 
        block: '#D2691E', 
        img: 'https://images.unsplash.com/photo-1508361001413-7a9dca21d08a?q=80&w=1080&auto=format&fit=crop',
        font: '"Impact", charcoal, sans-serif',
        shadow: '4px 4px 0px rgba(0, 0, 0, 0.8)',
        vibe: 'aggressive_metal'
    }
};

// === 🌐 УМНЫЙ СЕРВЕР ПРЕДПРОСМОТРА ===
const app = express();
const PORT = process.env.PORT || 3000;

// Заглушка для UptimeRobot (чтобы статус всегда был UP)
app.get('/', (req, res) => res.send('Фабрка Игр: Статус OK'));

app.get('/sdk.js', (req, res) => res.send('console.log("Mock SDK loaded");'));

app.get('/:engine/', (req, res) => {
    const engine = req.params.engine;
    const biome = req.query.biome || 'silent_stars';
    const s = styles[biome] || styles['silent_stars'];
    
    const indexPath = path.join(__dirname, 'templates', `${engine}_core`, 'index.html');
    if (!fs.existsSync(indexPath)) return res.status(404).send("<h2>⚙️ Движок в разработке.</h2>");

    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(/{{BG_COLOR}}/g, s.bg)
               .replace(/{{BLOCK_COLOR}}/g, s.block)
               .replace(/{{BG_IMAGE}}/g, s.img)
               .replace(/{{FONT_FAMILY}}/g, s.font)
               .replace(/{{SHADOW}}/g, s.shadow);
    res.send(html);
});

app.use('/:engine', (req, res, next) => {
    const dir = path.join(__dirname, 'templates', `${req.params.engine}_core`);
    if (fs.existsSync(dir)) express.static(dir)(req, res, next); else next();
});

app.listen(PORT, () => {
    console.log(`[Сервер] Запущен на порту ${PORT}`);
    console.log(`[Туннель] Ссылка: ${process.env.WEBAPP_URL}`);
});

// === 🤖 ЛОГИКА БОТА ===
bot.start((ctx) => {
    ctx.session = { gameData: {} }; 
    return ctx.reply('Привет, Демиург! 🌌\nВыбери платформу:',
        Markup.inlineKeyboard([
            [Markup.button.callback('📱 Мобильная', 'platform_mobile')],
            [Markup.button.callback('💻 ПК', 'platform_pc')]
        ])
    );
});

bot.action(/platform_(.+)/, async (ctx) => {
    ctx.session.gameData = { platform: ctx.match[1] }; 
    await ctx.editMessageText('Выбери движок:', Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')],
        [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')],
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris')]
    ]));
});

bot.action(/engine_(.+)/, async (ctx) => {
    ctx.session.gameData.engine = ctx.match[1];
    await ctx.editMessageText('Выбери атмосферу и сеттинг:', Markup.inlineKeyboard([
        [Markup.button.callback('🌌 Немые Звезды', 'biome_silent_stars')],
        [Markup.button.callback('🩸 Темное Фэнтези', 'biome_credo_fantasy')],
        [Markup.button.callback('🍃 Волшебный Лес', 'biome_ghibli_forest')],
        [Markup.button.callback('🌃 Неоновый Токио', 'biome_neon_tokyo')],
        [Markup.button.callback('⚙️ Ржавая Пустошь', 'biome_wasteland')]
    ]));
});

bot.action(/biome_(.+)/, async (ctx) => {
    ctx.session.gameData.biome = ctx.match[1];
    const data = ctx.session.gameData;
    setTimeout(async () => {
        const url = `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}`; 
        await ctx.reply(`✅ Сборка "${styles[data.biome].name}" готова:`, Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('📦 Скачать Архив', 'download_source')]
        ]));
    }, 1000);
});

bot.action('download_source', async (ctx) => {
    const data = ctx.session.gameData;
    const s = styles[data.biome];
    const templatePath = path.join(__dirname, 'templates', `${data.engine}_core`);
    
    const tempDir = path.join(os.tmpdir(), `build_${Date.now()}`); 
    const zipPath = path.join(os.tmpdir(), `game_${data.engine}.zip`); 

    try {
        fse.copySync(templatePath, tempDir);
        const indexPath = path.join(tempDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/{{BG_COLOR}}/g, s.bg)
                   .replace(/{{BLOCK_COLOR}}/g, s.block)
                   .replace(/{{BG_IMAGE}}/g, s.img)
                   .replace(/{{FONT_FAMILY}}/g, s.font)
                   .replace(/{{SHADOW}}/g, s.shadow);
        fs.writeFileSync(indexPath, html);

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', async () => {
            await ctx.replyWithDocument({ source: zipPath, filename: `game_${data.biome}.zip` });
            fse.removeSync(tempDir);
            fs.unlinkSync(zipPath);
        });
        archive.pipe(output);
        archive.directory(tempDir, false);
        archive.finalize();
    } catch (e) {
        ctx.reply('❌ Ошибка сборки.');
    }
});

bot.launch();
