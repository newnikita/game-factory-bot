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
        font: '"Courier New", monospace', shadow: '0 0 15px rgba(224, 224, 255, 0.5)', 
        life: '💠', score: '☄️', b_wide: '🌌', b_triple: '✨', b_fire: '🌠', b_lightning: '🌩️'
    }, 
    'credo_fantasy': { 
        name: 'Темное Фэнтези', bg: '#110000', block: '#8B0000', 
        img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop',
        font: '"Palatino Linotype", "Book Antiqua", serif', shadow: '0 0 20px rgba(139, 0, 0, 0.8)', 
        life: '🩸', score: '💀', b_wide: '📜', b_triple: '🔮', b_fire: '🔥', b_lightning: '🗡️'
    }, 
    'ghibli_forest': { 
        name: 'Волшебный Лес', bg: '#1E3B27', block: '#A8E6CF', 
        img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1080&auto=format&fit=crop',
        font: '"Comic Sans MS", cursive, sans-serif', shadow: '2px 2px 5px rgba(0, 0, 0, 0.3)', 
        life: '🌸', score: '🍃', b_wide: '🍄', b_triple: '✨', b_fire: '☀️', b_lightning: '🌩️'
    },
    'neon_tokyo': { 
        name: 'Неоновый Токио', bg: '#090014', block: '#FF00FF', 
        img: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?q=80&w=1080&auto=format&fit=crop',
        font: '"Trebuchet MS", sans-serif', shadow: '0 0 10px #00FFFF, 0 0 20px #FF00FF', 
        life: '🔋', score: '💿', b_wide: '🛹', b_triple: '💠', b_fire: '💥', b_lightning: '⚡'
    },
    'wasteland': { 
        name: 'Ржавая Пустошь', bg: '#2B1D14', block: '#D2691E', 
        img: 'https://images.unsplash.com/photo-1508361001413-7a9dca21d08a?q=80&w=1080&auto=format&fit=crop',
        font: '"Impact", charcoal, sans-serif', shadow: '4px 4px 0px rgba(0, 0, 0, 0.8)', 
        life: '⚙️', score: '🔩', b_wide: '🛡️', b_triple: '☢️', b_fire: '🔥', b_lightning: '⚡'
    }
};

// === 🕵️‍♂️ НЕЙРОСЕТЬ-МОДЕРАТОР SIGHTENGINE ===
async function checkImageSafety(imageUrl) {
    try {
        if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) {
            console.warn("⚠️ Ключи Sightengine не настроены в .env! Фильтр отключен.");
            return true; 
        }
        const response = await axios.get('https://api.sightengine.com/1.0/check.json', {
            params: {
                'url': imageUrl,
                'models': 'nudity-2.0',
                'api_user': process.env.SIGHT_USER,
                'api_secret': process.env.SIGHT_SECRET,
            }
        });
        if (response.data.status === 'success' && response.data.nudity.none < 0.8) { 
            return false; 
        }
        return true;
    } catch (e) {
        console.error("❌ Ошибка Sightengine:", e.message);
        return true; 
    }
}

// === 🧠 ГЕНЕРАТОР ИГР GEMINI (МАССИВНАЯ БАЗА ЗНАНИЙ) ===
async function generateAIGame(userPrompt) {
    try {
        if (!process.env.GEMINI_API_KEY) throw new Error("Ключ Gemini не настроен");

        let referenceCode = "";
        const referencesDir = path.join(__dirname, 'references');
        
        if (fs.existsSync(referencesDir)) {
            const files = fs.readdirSync(referencesDir).filter(file => file.endsWith('.html'));
            for (const file of files) {
                const filePath = path.join(referencesDir, file);
                referenceCode += `\n\n=== ЭТАЛОН КОДА: ${file} ===\n`;
                referenceCode += fs.readFileSync(filePath, 'utf8');
            }
        } else {
            console.warn("⚠️ Папка references не найдена! ИИ будет генерировать без твоих эталонов.");
        }

        const fullPrompt = `Ты — профессиональный разработчик HTML5/Canvas игр. Твоя задача: написать ПОЛНОСТЬЮ РАБОЧУЮ игру в ОДНОМ файле index.html по идее пользователя.

СТРОГИЕ ПРАВИЛА:
1) Используй только HTML, CSS и Vanilla JS. Без сторонних библиотек и БЕЗ ЧУЖИХ SDK (никакой аналитики, облачных сохранений или рекламы).
2) Размер Canvas должен быть адаптивным с правильной обработкой пропорций на мобильных устройствах.
3) Включи requestAnimationFrame, плавное управление, продвинутую физику, логику победы/поражения.
4) Вместо картинок рисуй примитивы или используй встроенные эмодзи.
5) ВЫДАВАЙ ТОЛЬКО КОД. Никаких пояснений или Markdown. Выдавай сырой текст, который начинается строго с <!DOCTYPE html>. БЕЗ разметки блоков кода.

Ниже приведены примеры МОЕГО ИДЕАЛЬНОГО КОДА. ТЫ ДОЛЖЕН ОПИРАТЬСЯ на их стиль написания, архитектуру игрового цикла, проработку UI, сложную систему частиц и структуру функций. ПОЛНОСТЬЮ ИГНОРИРУЙ любую логику рекламных SDK, если встретишь её в примерах — создавай чистый изолированный Canvas-движок:
${referenceCode}

Идея для новой игры: ${userPrompt}`;

        // МЕНЯЕМ МОДЕЛЬ НА FLASH. ОНА БЫСТРЕЕ И ИМЕЕТ ОГРОМНЫЕ ЛИМИТЫ ДЛЯ БОЛЬШИХ ФАЙЛОВ!
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        
        const response = await axios.post(url, {
            contents: [{
                role: "user",
                parts: [{ text: fullPrompt }]
            }]
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        let code = response.data.candidates[0].content.parts[0].text;
        
        // 100% безопасная очистка от маркдауна без риска синтаксических ошибок в Node.js
        code = code.replace(/\x60\x60\x60html/gi, '');
        code = code.replace(/\x60\x60\x60/g, '');
        
        return code.trim();
    } catch(e) {
        console.error("❌ ОШИБКА ПРЯМОГО ЗАПРОСА К GEMINI:", e.response ? JSON.stringify(e.response.data, null, 2) : e.message);
        return null;
    }
}

// === 🌐 УМНЫЙ СЕРВЕР ПРЕДПРОСМОТРА ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Фабрка Игр: Статус OK'));
app.get('/sdk.js', (req, res) => res.send('console.log("Mock SDK loaded");'));

// Папки для хранения файлов
const uploadsDir = path.join(__dirname, 'uploads');
const aiGamesDir = path.join(__dirname, 'ai_games');
const referencesDir = path.join(__dirname, 'references');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(aiGamesDir)) fs.mkdirSync(aiGamesDir);
if (!fs.existsSync(referencesDir)) fs.mkdirSync(referencesDir);

// Раздаем статику
app.use('/uploads', express.static(uploadsDir));
app.use('/ai_games', express.static(aiGamesDir));

// Обработчик шаблонов
app.get('/:engine/', (req, res, next) => {
    const engine = req.params.engine;
    if(engine === 'ai_games' || engine === 'uploads' || engine === 'references') return next(); 
    
    const biome = req.query.biome || 'silent_stars';
    const s = styles[biome] || styles['silent_stars'];
    
    const gameName = req.query.name || s.name;
    const customBg = req.query.bg ? `/uploads/${req.query.bg}` : s.img;
    const platform = req.query.platform || 'pc'; 
    
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
               .replace(/{{PLATFORM}}/g, platform); 
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
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')], 
        [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')], 
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris')],
        [Markup.button.callback('✨ ИИ-Генератор (Beta)', 'engine_ai')]
    ]));
});

// ПЕРЕХВАТ ИИ-ГЕНЕРАТОРА
bot.action('engine_ai', async (ctx) => {
    ctx.session = ctx.session || { gameData: {} };
    ctx.session.gameData.engine = 'ai';
    ctx.session.step = 'awaiting_ai_prompt';
    await ctx.editMessageText('✨ Режим Нейросети активирован!\n\nОпиши свою игру в одном-двух предложениях (например: Мрачный рыцарь бежит по подземелью и уворачивается от шипов).');
});

bot.action(/engine_(?!ai)(.+)/, async (ctx) => {
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
    // ВЕТКА ИИ-ГЕНЕРАЦИИ
    if (ctx.session?.step === 'awaiting_ai_prompt') {
        const msg = await ctx.reply('✨ Призываю мощности Gemini 2.5 Flash... Изучаю библиотеку эталонов, пишу игру с нуля. Твоих скриптов стало много, так что это займет около 15-20 секунд ⏳');
        const gameCode = await generateAIGame(ctx.message.text);
        
        if (!gameCode) {
            return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '❌ Ошибка генерации. Проверь логи на Render!');
        }

        const gameId = `ai_${Date.now()}`;
        fs.writeFileSync(path.join(aiGamesDir, `${gameId}.html`), gameCode);
        
        ctx.session.gameData.aiGameId = gameId;
        ctx.session.step = null;

        const url = `${process.env.WEBAPP_URL}/ai_games/${gameId}.html`;
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Твоя игра создана нейросетью в твоём фирменном стиле!`, Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('📦 Скачать Архив', 'download_ai_source')]
        ]));
        return;
    }

    // ВЕТКА СТАНДАРТНЫХ ШАБЛОНОВ
    if (ctx.session?.step === 'awaiting_name') {
        ctx.session.gameData.gameName = ctx.message.text;
        ctx.session.step = 'awaiting_bg_choice';
        
        await ctx.reply(`Супер! Название «${ctx.message.text}» принято.\n\nПоследний штрих: хочешь добавить на задний фон свою собственную фотографию? Или оставим всё как есть?`,
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
        await ctx.editMessageText('Отлично! Отправь мне картинку, которая станет фоном твоей игры 🖼️\n\n(Только без пошлятины, модератор не спит!)');
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
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '🔞 Ого-го! Мой сканер заметил что-то неприличное на этом фото. Давай выберем картинку поскромнее!');
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

// Финальная сборка шаблона
async function finishGameGeneration(ctx) {
    const data = ctx.session.gameData;
    const encName = encodeURIComponent(data.gameName);
    const encBg = data.customBgFile ? `&bg=${data.customBgFile}` : '';
    const platformParam = `&platform=${data.platform || 'pc'}`; 
    
    const url = `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}&name=${encName}${encBg}${platformParam}`; 
    
    await ctx.reply(`✅ Игра "${data.gameName}" успешно сгенерирована!`, Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 ИГРАТЬ', url)],
        [Markup.button.callback('📦 Скачать Архив', 'download_source')]
    ]));
}

// Загрузка ИИ-игры
bot.action('download_ai_source', async (ctx) => {
    const gameId = ctx.session.gameData.aiGameId;
    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    const zipPath = path.join(os.tmpdir(), `${gameId}.zip`);

    try {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', async () => {
            await ctx.replyWithDocument({ source: zipPath, filename: `ai_generated_game.zip` });
            fs.unlinkSync(zipPath); // Удаляем временный архив
        });

        archive.pipe(output);
        archive.file(gamePath, { name: 'index.html' });
        archive.finalize();
    } catch (e) {
        ctx.reply('❌ Ошибка сборки архива ИИ-игры.');
    }
});

// Загрузка шаблона
bot.action('download_source', async (ctx) => {
    const data = ctx.session.gameData;
    const s = styles[data.biome];
    const platform = data.platform || 'pc';
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
                   .replace(/{{PLATFORM}}/g, platform); 
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
