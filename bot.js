require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os'); // Подключаем работу с оперативной памятью облака
const archiver = require('archiver');
const express = require('express');
const fse = require('fs-extra');

// === 🛡️ СИСТЕМА БЕССМЕРТИЯ (Анти-Краш) ===
process.on('uncaughtException', (err) => {
    console.error('❌ Критическая ошибка:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('❌ Ошибка сети/промиса:', err.message);
});

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// Перехват внутренних ошибок Телеграфа
bot.catch((err, ctx) => {
    console.log(`❌ Ошибка логики бота:`, err.message);
});

// База данных стилей
const styles = {
    'space': { bg: '#0B0C10', block: '#66FCF1', img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1080&auto=format&fit=crop' }, 
    'darkfantasy': { bg: '#1A1A1D', block: '#8B0000', img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop' }, 
    'forest': { bg: '#2C5E3B', block: '#8B5A2B', img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1080&auto=format&fit=crop' } 
};

// === УМНЫЙ СЕРВЕР ПРЕДПРОСМОТРА ===
const app = express();
// ОБЛАЧНЫЙ ПОРТ (Render сам решит, какой порт нам выдать)
const PORT = process.env.PORT || 3000;

app.get('/sdk.js', (req, res) => res.send('console.log("Mock SDK loaded");'));

app.get('/:engine/', (req, res) => {
    const engine = req.params.engine;
    const biome = req.query.biome || 'space';
    const selectedStyle = styles[biome] || styles['space'];
    
    const indexPath = path.join(__dirname, 'templates', `${engine}_core`, 'index.html');
    
    if (!fs.existsSync(indexPath)) {
        return res.status(404).send("<h2 style='color:white; text-align:center; margin-top:50px;'>⚙️ Движок еще в разработке.</h2>");
    }

    try {
        let htmlCode = fs.readFileSync(indexPath, 'utf8');
        htmlCode = htmlCode.replace(/{{BG_COLOR}}/g, selectedStyle.bg);
        htmlCode = htmlCode.replace(/{{BLOCK_COLOR}}/g, selectedStyle.block);
        htmlCode = htmlCode.replace(/{{BG_IMAGE}}/g, selectedStyle.img); 
        res.send(htmlCode);
    } catch (e) {
        res.status(500).send("Ошибка рендеринга матрицы.");
    }
});

app.use('/:engine', (req, res, next) => {
    const engine = req.params.engine;
    const dir = path.join(__dirname, 'templates', `${engine}_core`);
    if (fs.existsSync(dir)) express.static(dir)(req, res, next); else next();
});

// Запускаем сервер 
app.listen(PORT, () => {
    console.log(`[Сервер] Облачный мульти-хостинг запущен на порту ${PORT}`);
    console.log(`[Туннель] Ссылка: ${process.env.WEBAPP_URL}`);
});

// === ШАГ 0: СТАРТ ===
bot.start((ctx) => {
    ctx.session = { gameData: {} }; 
    return ctx.reply(
        'Привет, Демиург! 🌌\nВыбери платформу:',
        Markup.inlineKeyboard([
            [Markup.button.callback('📱 Мобильная', 'platform_mobile')],
            [Markup.button.callback('💻 ПК', 'platform_pc')]
        ])
    );
});

// === ШАГ 1: ПЛАТФОРМА -> ДВИЖОК ===
bot.action(/platform_(.+)/, async (ctx) => {
    if (!ctx.session || !ctx.session.gameData) ctx.session = { gameData: {} };
    ctx.session.gameData.platform = ctx.match[1]; 
    await ctx.editMessageText('Выбери движок:', Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')],
        [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')],
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris')]
    ]));
});

// === ШАГ 2: ДВИЖОК -> БИОМ ===
bot.action(/engine_(.+)/, async (ctx) => {
    if (!ctx.session || !ctx.session.gameData) return ctx.reply('⏳ Нажми /start');
    ctx.session.gameData.engine = ctx.match[1];
    await ctx.editMessageText('Выбери сеттинг:', Markup.inlineKeyboard([
        [Markup.button.callback('🌌 Космос', 'biome_space')],
        [Markup.button.callback('🏰 Фэнтези', 'biome_darkfantasy')],
        [Markup.button.callback('🌲 Лес', 'biome_forest')]
    ]));
});

// === ШАГ 3: ФИНАЛ ===
bot.action(/biome_(.+)/, async (ctx) => {
    if (!ctx.session || !ctx.session.gameData || !ctx.session.gameData.engine) return ctx.reply('⏳ Нажми /start');
    ctx.session.gameData.biome = ctx.match[1];
    const data = ctx.session.gameData;

    setTimeout(async () => {
        const currentUrl = process.env.WEBAPP_URL ? `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}` : `https://yandex.ru/games`; 
        await ctx.reply('✅ Готово! Можешь играть:', Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 ИГРАТЬ', currentUrl)],
            [Markup.button.callback('📦 Скачать', 'download_source')]
        ]));
    }, 1500);
});

// === ШАГ 4: СБОРКА АРХИВА ===
bot.action('download_source', async (ctx) => {
    if (!ctx.session || !ctx.session.gameData || !ctx.session.gameData.biome) return ctx.reply('⏳ Нажми /start');
    
    await ctx.reply('⚙️ Упаковываю...');
    const data = ctx.session.gameData;
    const selectedStyle = styles[data.biome] || styles['space']; 
    const templatePath = path.join(__dirname, 'templates', `${data.engine}_core`);
    
    if (!fs.existsSync(templatePath)) return ctx.reply('❌ Движок в разработке.');

    // Используем временную директорию облачного сервера (os.tmpdir)
    const tempDirPath = path.join(os.tmpdir(), `temp_${ctx.from.id}_${Date.now()}`); 
    const buildPath = path.join(os.tmpdir(), `game_build_${ctx.from.id}.zip`); 

    try {
        fse.copySync(templatePath, tempDirPath);
        const indexPath = path.join(tempDirPath, 'index.html');
        let htmlCode = fs.readFileSync(indexPath, 'utf8');
        htmlCode = htmlCode.replace(/{{BG_COLOR}}/g, selectedStyle.bg);
        htmlCode = htmlCode.replace(/{{BLOCK_COLOR}}/g, selectedStyle.block);
        htmlCode = htmlCode.replace(/{{BG_IMAGE}}/g, selectedStyle.img); 
        fs.writeFileSync(indexPath, htmlCode, 'utf8');

        const output = fs.createWriteStream(buildPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', async () => {
            await ctx.replyWithDocument({ source: buildPath });
            fse.removeSync(tempDirPath);
            fs.unlinkSync(buildPath);
        });
        archive.pipe(output);
        archive.directory(tempDirPath, false);
        archive.finalize();
    } catch (error) {
        console.error('Ошибка сборки в облаке:', error);
        ctx.reply('❌ Ошибка сборки архива.');
        if (fs.existsSync(tempDirPath)) fse.removeSync(tempDirPath);
    }
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));