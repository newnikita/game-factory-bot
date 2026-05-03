require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const express = require('express');
const fse = require('fs-extra');
const axios = require('axios');

// === 🛡️ СИСТЕМА АНТИ-КРАШ ===
process.on('uncaughtException', (err) => console.error('❌ Ошибка:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Ошибка сети:', err.message));

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// === 📊 БАЗА ДАННЫХ БИОМОВ (СМАЙЛЫ И ИКОНКИ) ===
const styles = {
    'silent_stars': { 
        name: 'Немые Звезды', bg: '#050510', block: '#E0E0FF', 
        img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1080&auto=format&fit=crop',
        font: '"Courier New", monospace', shadow: '0 0 15px rgba(224, 224, 255, 0.5)', vibe: 'melancholic_orchestral',
        life: '💠', score: '☄️', b_wide: '🌌', b_triple: '✨', b_fire: '🌠', b_lightning: '🌩️'
    }, 
    'credo_fantasy': { 
        name: 'Темное Фэнтези', bg: '#110000', block: '#8B0000', 
        img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop',
        font: '"Palatino Linotype", "Book Antiqua", serif', shadow: '0 0 20px rgba(139, 0, 0, 0.8)', vibe: 'dark_orchestral_metal',
        life: '🩸', score: '💀', b_wide: '📜', b_triple: '🔮', b_fire: '🔥', b_lightning: '🗡️'
    }, 
    'ghibli_forest': { 
        name: 'Волшебный Лес', bg: '#1E3B27', block: '#A8E6CF', 
        img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1080&auto=format&fit=crop',
        font: '"Comic Sans MS", cursive, sans-serif', shadow: '2px 2px 5px rgba(0, 0, 0, 0.3)', vibe: 'calm_acoustic',
        life: '🌸', score: '🍃', b_wide: '🍄', b_triple: '✨', b_fire: '☀️', b_lightning: '🌩️'
    },
    'neon_tokyo': { 
        name: 'Неоновый Токио', bg: '#090014', block: '#FF00FF', 
        img: 'https://images.unsplash.com/photo-1555580399-5ddb9eb8518e?q=80&w=1080&auto=format&fit=crop',
        font: '"Trebuchet MS", sans-serif', shadow: '0 0 10px #00FFFF, 0 0 20px #FF00FF', vibe: 'j_pop_dynamic',
        life: '🔋', score: '💿', b_wide: '🛹', b_triple: '💠', b_fire: '💥', b_lightning: '⚡'
    },
    'wasteland': { 
        name: 'Ржавая Пустошь', bg: '#2B1D14', block: '#D2691E', 
        img: 'https://images.unsplash.com/photo-1508361001413-7a9dca21d08a?q=80&w=1080&auto=format&fit=crop',
        font: '"Impact", charcoal, sans-serif', shadow: '4px 4px 0px rgba(0, 0, 0, 0.8)', vibe: 'aggressive_metal',
        life: '⚙️', score: '🔩', b_wide: '🛡️', b_triple: '☢️', b_fire: '🔥', b_lightning: '⚡'
    }
};

// === 🕵️‍♂️ РЕАЛЬНАЯ НЕЙРОСЕТЬ-МОДЕРАТОР ===
async function checkImageSafety(imageUrl) {
    try {
        if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) {
            console.warn("⚠️ Ключи Sightengine не настроены в .env! Фильтр отключен.");
            return true; 
        }

        console.log("Отправляем картинку модератору Sightengine...");
        const response = await axios.get('https://api.sightengine.com/1.0/check.json', {
            params: {
                'url': imageUrl,
                'models': 'nudity-2.0',
                'api_user': process.env.SIGHT_USER,
                'api_secret': process.env.SIGHT_SECRET,
            }
        });

        if (response.data.status === 'success') {
            const nudity = response.data.nudity;
            if (nudity.none < 0.8) { 
                console.log("⛔ NSFW контент обнаружен!");
                return false; 
            }
            return true;
        }
        return true;
    } catch (e) {
        console.error("❌ Ошибка при запросе к Sightengine:", e.message);
        return true; 
    }
}

// === 🌐 УМНЫЙ СЕРВЕР ПРЕДПРОСМОТРА ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Фабрка Игр: Статус OK'));
app.get('/sdk.js', (req, res) => res.send('console.log("Mock SDK loaded");'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

app.get('/:engine/', (req, res) => {
    const engine = req.params.engine;
    const biome = req.query.biome || 'silent_stars';
    const s = styles[biome] || styles['silent_stars'];
    
    const gameName = req.query.name || s.name;
    const customBg = req.query.bg ? `/uploads/${req.query.bg}` : s.img;
    const platform = req.query.platform || 'pc'; // <-- Ловим платформу
    
    const indexPath = path.join(__dirname, 'templates', `${engine}_core`, 'index.html');
    if (!fs.existsSync(indexPath)) return res.status(404).send("<h2>⚙️ Движок в разработке.</h2>");

    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(/{{GAME_TITLE}}/g, gameName)
               .replace(/{{BG_IMAGE}}/g, customBg)
               .replace(/{{BG_COLOR}}/g, s.bg)
               .replace(/{{BLOCK_COLOR}}/g, s.block)
               .replace(/{{FONT_FAMILY}}/g, s.font)
               .replace(/{{SHADOW}}/g, s.shadow)
               .replace(/{{LIFE_ICON}}/g, s.life)
               .replace(/{{SCORE_ICON}}/g, s.score)
               .replace(/{{BOOSTER_WIDE}}/g, s.b_wide)
               .replace(/{{BOOSTER_TRIPLE}}/g, s.b_triple)
               .replace(/{{BOOSTER_FIRE}}/g, s.b_fire)
               .replace(/{{BOOSTER_LIGHTNING}}/g, s.b_lightning)
               .replace(/{{PLATFORM}}/g, platform); // <-- Вшиваем платформу в игру
    res.send(html);
});

app.use('/:engine', (req, res, next) => {
    const dir = path.join(__dirname, 'templates', `${req.params.engine}_core`);
    if (fs.existsSync(dir)) express.static(dir)(req, res, next); else next();
});

app.listen(PORT, () => console.log(`[Сервер] Запущен на порту ${PORT}`));

// === 🤖 ЛОГИКА БОТА ===
bot.start((ctx) => {
    ctx.session = { gameData: {}, step: 'platform' }; 
    return ctx.reply('Привет, Демиург! 🌌\nВыбери платформу:',
        Markup.inlineKeyboard([ [Markup.button.callback('📱 Мобильная', 'platform_mobile')], [Markup.button.callback('💻 ПК', 'platform_pc')] ])
    );
});

bot.action(/platform_(.+)/, async (ctx) => {
    ctx.session = ctx.session || { gameData: {} };
    ctx.session.gameData.platform = ctx.match[1]; 
    await ctx.editMessageText('Выбери движок (механику игры):', Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')], [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')], [Markup.button.callback('🧩 Тетрис', 'engine_tetris')]
    ]));
});

bot.action(/engine_(.+)/, async (ctx) => {
    ctx.session = ctx.session || { gameData: {} };
    ctx.session.gameData.engine = ctx.match[1];
    await ctx.editMessageText('Отлично! Теперь выбери визуальный шаблон (атмосферу) для твоей игры:', Markup.inlineKeyboard([
        [Markup.button.callback('🌌 Немые Звезды', 'biome_silent_stars')], [Markup.button.callback('🩸 Темное Фэнтези', 'biome_credo_fantasy')],
        [Markup.button.callback('🍃 Волшебный Лес', 'biome_ghibli_forest')], [Markup.button.callback('🌃 Неоновый Токио', 'biome_neon_tokyo')], [Markup.button.callback('⚙️ Ржавая Пустошь', 'biome_wasteland')]
    ]));
});

bot.action(/biome_(.+)/, async (ctx) => {
    ctx.session = ctx.session || { gameData: {} };
    ctx.session.gameData.biome = ctx.match[1];
    ctx.session.step = 'awaiting_name';
    await ctx.editMessageText('Шаблон применен! 🎨\nТеперь придумай и напиши мне название для твоей игры:');
});

bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'awaiting_name') {
        ctx.session.gameData.gameName = ctx.message.text;
        ctx.session.step = 'awaiting_bg_choice';
        
        await ctx.reply(`Супер! Название «${ctx.message.text}» принято.\n\nПоследний штрих: хочешь добавить на задний фон свою собственную фотографию? Или оставим всё как есть (стандартный фон выбранного шаблона)?`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🏞 Оставить всё как есть', 'bg_choice_standard')],
                [Markup.button.callback('🖼 Добавить свою фотографию (PRO)', 'bg_choice_custom')]
            ])
        );
    }
});

bot.action('bg_choice_standard', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') {
        ctx.session.gameData.customBgFile = null;
        ctx.session.step = null;
        await ctx.editMessageText('✅ Оставляем стандартный фон. Запускаю сборку...');
        finishGameGeneration(ctx);
    }
});

bot.action('bg_choice_custom', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') {
        ctx.session.step = 'awaiting_photo';
        await ctx.editMessageText('Отлично! Отправь мне картинку, которая станет фоном твоей игры 🖼️\n\n(Только без пошлятины, наша нейросеть-модератор следит за порядком!)');
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.session?.step === 'awaiting_photo') {
        const msg = await ctx.reply('⏳ Проверяю картинку нейросетью и применяю к игре...');
        try {
            const photo = ctx.message.photo.pop();
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const url = fileLink.href;

            const isSafe = await checkImageSafety(url);
            if (!isSafe) {
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '🔞 Ого-го! Мой сканер заметил что-то неприличное на этом фото. За такое на платформе сразу бан. Давай выберем картинку поскромнее!');
            }

            const fileName = `bg_${Date.now()}.jpg`;
            const filePath = path.join(uploadsDir, fileName);
            const response = await axios({ url, method: 'GET', responseType: 'stream' });
            
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            writer.on('finish', () => {
                ctx.session.gameData.customBgFile = fileName;
                ctx.session.step = null;
                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
                finishGameGeneration(ctx);
            });
        } catch (e) {
            console.error(e);
            ctx.reply('❌ Произошла ошибка при загрузке картинки. Давай попробуем другую!');
        }
    }
});

async function finishGameGeneration(ctx) {
    const data = ctx.session.gameData;
    const encName = encodeURIComponent(data.gameName);
    const encBg = data.customBgFile ? `&bg=${data.customBgFile}` : '';
    const platformParam = `&platform=${data.platform || 'pc'}`; // <-- Добавляем параметр
    
    const url = `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}&name=${encName}${encBg}${platformParam}`; 
    
    await ctx.reply(`✅ Игра "${data.gameName}" успешно сгенерирована!`, Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 ИГРАТЬ', url)],
        [Markup.button.callback('📦 Скачать Архив', 'download_source')]
    ]));
}

bot.action('download_source', async (ctx) => {
    const data = ctx.session.gameData;
    const s = styles[data.biome];
    const platform = data.platform || 'pc'; // <-- Для архива
    const templatePath = path.join(__dirname, 'templates', `${data.engine}_core`);
    const tempDir = path.join(os.tmpdir(), `build_${Date.now()}`); 
    const zipPath = path.join(os.tmpdir(), `game_${data.engine}.zip`); 

    try {
        fse.copySync(templatePath, tempDir);
        
        let finalBgPath = s.img;
        if (data.customBgFile) {
            const localBgPath = path.join(uploadsDir, data.customBgFile);
            fse.copySync(localBgPath, path.join(tempDir, 'custom_bg.jpg'));
            finalBgPath = 'custom_bg.jpg';
        }

        const indexPath = path.join(tempDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/{{GAME_TITLE}}/g, data.gameName || s.name)
                   .replace(/{{BG_IMAGE}}/g, finalBgPath)
                   .replace(/{{BG_COLOR}}/g, s.bg)
                   .replace(/{{BLOCK_COLOR}}/g, s.block)
                   .replace(/{{FONT_FAMILY}}/g, s.font)
                   .replace(/{{SHADOW}}/g, s.shadow)
                   .replace(/{{LIFE_ICON}}/g, s.life)
                   .replace(/{{SCORE_ICON}}/g, s.score)
                   .replace(/{{BOOSTER_WIDE}}/g, s.b_wide)
                   .replace(/{{BOOSTER_TRIPLE}}/g, s.b_triple)
                   .replace(/{{BOOSTER_FIRE}}/g, s.b_fire)
                   .replace(/{{BOOSTER_LIGHTNING}}/g, s.b_lightning)
                   .replace(/{{PLATFORM}}/g, platform); // <-- Вшиваем платформу в скачанный код
        fs.writeFileSync(indexPath, html);

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', async () => {
            await ctx.replyWithDocument({ source: zipPath, filename: `${data.gameName}.zip` });
            fse.removeSync(tempDir);
            fs.unlinkSync(zipPath);
        });
        archive.pipe(output);
        archive.directory(tempDir, false);
        archive.finalize();
    } catch (e) {
        ctx.reply('❌ Ошибка сборки архива.');
    }
});

bot.launch();
