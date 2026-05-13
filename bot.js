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

// === 🗄️ БАЗА ДАННЫХ ПОЛЬЗОВАТЕЛЕЙ (ЭКОНОМИКА) ===
const dbPath = path.join(__dirname, 'users.json');
let usersDb = {};

if (fs.existsSync(dbPath)) {
    usersDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

function saveDb() {
    fs.writeFileSync(dbPath, JSON.stringify(usersDb, null, 2));
}

function getUser(id) {
    if (!usersDb[id]) {
        usersDb[id] = { balance: 100, referrals: 0, referredBy: null };
        saveDb();
    }
    return usersDb[id];
}

// Стоимость генерации и награды
const COST_PER_GAME = 25;
const REWARD_PER_REF = 100;

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// === 📊 БАЗА ДАННЫХ БИОМОВ (СМАЙЛЫ И ИКОНКИ) ===
const styles = {
    'silent_stars': { name: 'Немые Звезды', bg: '#050510', block: '#E0E0FF', img: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1080&auto=format&fit=crop', font: '"Courier New", monospace', shadow: '0 0 15px rgba(224, 224, 255, 0.5)', life: '💠', score: '☄️', b_wide: '🌌', b_triple: '✨', b_fire: '🌠', b_lightning: '🌩️' }, 
    'credo_fantasy': { name: 'Темное Фэнтези', bg: '#110000', block: '#8B0000', img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1080&auto=format&fit=crop', font: '"Palatino Linotype", "Book Antiqua", serif', shadow: '0 0 20px rgba(139, 0, 0, 0.8)', life: '🩸', score: '💀', b_wide: '📜', b_triple: '🔮', b_fire: '🔥', b_lightning: '🗡️' }, 
    'ghibli_forest': { name: 'Волшебный Лес', bg: '#1E3B27', block: '#A8E6CF', img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=1080&auto=format&fit=crop', font: '"Comic Sans MS", cursive, sans-serif', shadow: '2px 2px 5px rgba(0, 0, 0, 0.3)', life: '🌸', score: '🍃', b_wide: '🍄', b_triple: '✨', b_fire: '☀️', b_lightning: '🌩️' },
    'neon_tokyo': { name: 'Неоновый Токио', bg: '#090014', block: '#FF00FF', img: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?q=80&w=1080&auto=format&fit=crop', font: '"Trebuchet MS", sans-serif', shadow: '0 0 10px #00FFFF, 0 0 20px #FF00FF', life: '🔋', score: '💿', b_wide: '🛹', b_triple: '💠', b_fire: '💥', b_lightning: '⚡' },
    'wasteland': { name: 'Ржавая Пустошь', bg: '#2B1D14', block: '#D2691E', img: 'https://images.unsplash.com/photo-1508361001413-7a9dca21d08a?q=80&w=1080&auto=format&fit=crop', font: '"Impact", charcoal, sans-serif', shadow: '4px 4px 0px rgba(0, 0, 0, 0.8)', life: '⚙️', score: '🔩', b_wide: '🛡️', b_triple: '☢️', b_fire: '🔥', b_lightning: '⚡' }
};

// === 🕵️‍♂️ НЕЙРОСЕТЬ-МОДЕРАТОР SIGHTENGINE ===
async function checkImageSafety(imageUrl) {
    try {
        if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) return true; 
        const response = await axios.get('https://api.sightengine.com/1.0/check.json', {
            params: { 'url': imageUrl, 'models': 'nudity-2.0', 'api_user': process.env.SIGHT_USER, 'api_secret': process.env.SIGHT_SECRET }
        });
        if (response.data.status === 'success' && response.data.nudity.none < 0.8) return false; 
        return true;
    } catch (e) { return true; }
}

// === 🧠 ГЕНЕРАТОР ИГР GEMINI (С АЛГОРИТМОМ СКЛЕЙКИ) ===
async function generateAIGame(userPrompt, platform = 'pc', maxRetries = 5) {
    try {
        if (!process.env.GEMINI_API_KEY) throw new Error("Ключ Gemini не настроен");

        let referenceCode = "";
        const referencesDir = path.join(__dirname, 'references');
        
        if (fs.existsSync(referencesDir)) {
            const files = fs.readdirSync(referencesDir).filter(file => file.endsWith('.html'));
            for (const file of files) {
                referenceCode += `\n\n=== ЭТАЛОН КОДА: ${file} ===\n`;
                referenceCode += fs.readFileSync(path.join(referencesDir, file), 'utf8');
            }
        }

        let controlsPrompt = "";
        if (platform === 'mobile') {
            controlsPrompt = `2) УПРАВЛЕНИЕ ДЛЯ МОБИЛЬНЫХ: Размер Canvas адаптивный. Управление ИСКЛЮЧИТЕЛЬНО через тапы и свайпы (touchstart, touchmove, touchend). 
3) КАТЕГОРИЧЕСКИ ЗАПРЕЩАЕТСЯ создавать наэкранные HTML-кнопки. Только считывание жестов по самому Canvas.`;
        } else {
            controlsPrompt = `2) УПРАВЛЕНИЕ ДЛЯ ПК: Используй стандартное управление со стационарной клавиатуры (Стрелочки, WASD, Пробел) или клики мышью.
3) Адаптируй игру под десктоп. Никаких touch-событий свайпов делать не нужно.`;
        }

        const marker = String.fromCharCode(96, 96, 96);
        const fullPrompt = `Ты — профессиональный разработчик HTML5/Canvas игр. Твоя задача: написать ПОЛНОСТЬЮ РАБОЧУЮ игру в ОДНОМ файле index.html по идее пользователя.
СТРОГИЕ ПРАВИЛА:
1) Используй только HTML, CSS и Vanilla JS. Без сторонних библиотек и БЕЗ ЧУЖИХ SDK.
${controlsPrompt}
4) Включи requestAnimationFrame, плавное управление, логику победы/поражения.
5) Вместо картинок рисуй примитивы или эмодзи.
6) ВЫДАВАЙ ТОЛЬКО КОД (БЕЗ ${marker}html). Начинай строго с <!DOCTYPE html>.
7) КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО делать HTML-экраны загрузки. В конце скрипта обязательно вызови функцию старта игры.
8) БЕЗ КОММЕНТАРИЕВ. Категорически запрещено писать комментарии в коде. Никаких // или /* */. Пиши код максимально сжато, только чистая логика.
9) КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать внешние ссылки на изображения (imgur и т.д.). Для фонов используй только сплошные цвета (HEX) или процедурные CSS-градиенты.

Ниже приведены примеры МОЕГО ИДЕАЛЬНОГО КОДА:
${referenceCode}

Идея для новой игры: ${userPrompt}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        
        let fullCode = "";
        let history = [{ role: "user", parts: [{ text: fullPrompt }] }];
        let isFinished = false;

        for (let chunk = 0; chunk < 3; chunk++) {
            let attemptSuccess = false;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await axios.post(url, { 
                        contents: history,
                        safetySettings: [
                            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                        ],
                        generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 8192 }
                    }, { headers: { 'Content-Type': 'application/json' } });
                    
                    const candidate = response.data.candidates[0];
                    const chunkText = candidate.content.parts[0].text;
                    fullCode += chunkText;

                    if (candidate.finishReason === 'MAX_TOKENS') {
                        history.push({ role: "model", parts: [{ text: chunkText }] });
                        history.push({ role: "user", parts: [{ text: "Код оборвался по лимиту токенов. Продолжи писать код СТРОГО с того символа, на котором ты остановился. Не пиши никаких вступлений, маркеров кода или приветствий, просто продолжай синтаксис." }] });
                        attemptSuccess = true;
                        console.log(`[🤖 ИИ] Код оборвался. Запрашиваю кусок ${chunk + 2}...`);
                        break; 
                    } else {
                        isFinished = true;
                        attemptSuccess = true;
                        break; 
                    }
                } catch (apiError) {
                    if (apiError.response && (apiError.response.status === 503 || apiError.response.status === 429)) {
                        const waitTime = Math.min(10000 * Math.pow(2, attempt - 1), 60000);
                        if (attempt === maxRetries) throw apiError; 
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue; 
                    }
                    throw apiError;
                }
            }
            if (isFinished || !attemptSuccess) break;
        }

        let finalCode = fullCode.replace(new RegExp(marker + 'html', 'gi'), '').replace(new RegExp(marker, 'g'), '');
        return finalCode.trim();
    } catch(e) { 
        console.error("Критическая ошибка генерации:", e);
        return null; 
    }
}

// === 🌐 УМНЫЙ СЕРВЕР ПРЕДПРОСМОТРА ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Фабрка Игр: Статус OK'));
app.get('/sdk.js', (req, res) => res.send('console.log("Mock SDK loaded");'));

const uploadsDir = path.join(__dirname, 'uploads');
const aiGamesDir = path.join(__dirname, 'ai_games');
const referencesDir = path.join(__dirname, 'references');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(aiGamesDir)) fs.mkdirSync(aiGamesDir);
if (!fs.existsSync(referencesDir)) fs.mkdirSync(referencesDir);

app.use('/uploads', express.static(uploadsDir));
app.use('/ai_games', express.static(aiGamesDir));

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
    html = html.replace(/{{GAME_TITLE}}/g, gameName).replace(/{{BG_IMAGE}}/g, customBg).replace(/{{BG_COLOR}}/g, s.bg).replace(/{{BLOCK_COLOR}}/g, s.block).replace(/{{FONT_FAMILY}}/g, s.font).replace(/{{SHADOW}}/g, s.shadow).replace(/{{LIFE_ICON}}/g, s.life).replace(/{{SCORE_ICON}}/g, s.score).replace(/{{BOOSTER_WIDE}}/g, s.b_wide).replace(/{{BOOSTER_TRIPLE}}/g, s.b_triple).replace(/{{BOOSTER_FIRE}}/g, s.b_fire).replace(/{{BOOSTER_LIGHTNING}}/g, s.b_lightning).replace(/{{PLATFORM}}/g, platform); 
    res.send(html);
});

app.use('/:engine', (req, res, next) => {
    const dir = path.join(__dirname, 'templates', `${req.params.engine}_core`);
    if (fs.existsSync(dir)) express.static(dir)(req, res, next); else next();
});

app.listen(PORT, () => console.log(`[Сервер] Запущен на порту ${PORT}`));

// === 🤖 ЛОГИКА БОТА И МЕНЮ ===

function getMainMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🎮 Создать игру', 'start_creation')],
        [Markup.button.callback('👤 Мой профиль / Баланс', 'show_profile')],
        [Markup.button.callback('👥 Пригласить друга', 'show_referral')],
        [Markup.button.url('🌐 Наше сообщество', 'https://t.me/your_community_link')] 
    ]);
}

bot.start(async (ctx) => {
    ctx.session = { gameData: {}, step: null }; 
    const userId = ctx.from.id;
    const refId = ctx.payload; 
    
    if (!usersDb[userId]) {
        usersDb[userId] = { balance: 100, referrals: 0, referredBy: null };
        if (refId && refId != userId && usersDb[refId]) {
            usersDb[userId].referredBy = refId;
            usersDb[refId].balance += REWARD_PER_REF;
            usersDb[refId].referrals += 1;
            try {
                await bot.telegram.sendMessage(refId, `🎉 По твоей ссылке зарегистрировался новый демиург!\nТебе начислено +${REWARD_PER_REF} 🪙 токенов.`);
            } catch (e) {}
        }
        saveDb();
    }

    const text = `🌌 Добро пожаловать на Фабрику Игр!\n\nЯ — нейросеть, которая превращает твои безумные идеи в рабочие браузерные игры за пару секунд.\n\nКаждая генерация стоит ${COST_PER_GAME} 🪙. На твоем стартовом счету 100 🪙!`;
    return ctx.reply(text, getMainMenuKeyboard());
});

bot.action('main_menu', async (ctx) => {
    ctx.session = { gameData: {}, step: null }; 
    try {
        await ctx.editMessageText('🌌 Главное меню Фабрики Игр:', getMainMenuKeyboard());
    } catch(e) {
        await ctx.reply('🌌 Главное меню Фабрики Игр:', getMainMenuKeyboard());
    }
});

bot.action('show_profile', async (ctx) => {
    const user = getUser(ctx.from.id);
    const text = `👤 **Твой профиль**\n\n🆔 ID: \`${ctx.from.id}\`\n🪙 Баланс: **${user.balance} токенов**\n🕹️ Хватит на генераций: **${Math.floor(user.balance / COST_PER_GAME)}**\n👥 Приглашено друзей: **${user.referrals}**\n\n*(Система пополнения баланса скоро будет добавлена!)*`;
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'main_menu')]]) });
});

bot.action('show_referral', async (ctx) => {
    const botInfo = await bot.telegram.getMe();
    const refLink = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    const text = `👥 **Реферальная программа**\n\nПриглашай друзей и получай токены за каждого нового пользователя!\n\n🎁 За 1 друга: **+${REWARD_PER_REF} 🪙**\n💰 Стоимость 1 игры: **${COST_PER_GAME} 🪙**\n\nТвоя персональная ссылка для приглашения:\n\`${refLink}\``;
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'main_menu')]]) });
});

bot.action('start_creation', async (ctx) => {
    ctx.session.step = 'platform';
    await ctx.editMessageText('Выбери платформу для новой игры:', Markup.inlineKeyboard([
        [Markup.button.callback('📱 Мобильная', 'platform_mobile')], 
        [Markup.button.callback('💻 ПК', 'platform_pc')],
        [Markup.button.callback('⬅️ Отмена', 'main_menu')]
    ]));
});

bot.action(/platform_(.+)/, async (ctx) => {
    ctx.session.gameData.platform = ctx.match[1]; 
    await ctx.editMessageText('Выбери движок (механику игры):', Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')], 
        [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')], 
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris')],
        [Markup.button.callback('✨ ИИ-Генератор (Beta)', 'engine_ai')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ]));
});

bot.action('engine_ai', async (ctx) => {
    const user = getUser(ctx.from.id);
    if (user.balance < COST_PER_GAME) {
        return ctx.editMessageText('❌ На твоем балансе недостаточно токенов для генерации!\nПригласи друзей, чтобы получить бонусы.', Markup.inlineKeyboard([[Markup.button.callback('👥 Пригласить', 'show_referral')], [Markup.button.callback('🏠 Главное меню', 'main_menu')]]));
    }

    ctx.session.gameData.engine = 'ai';
    ctx.session.step = 'awaiting_ai_prompt';
    await ctx.editMessageText(`✨ Режим Нейросети активирован!\n💰 *Стоимость: ${COST_PER_GAME} 🪙*\n\nОпиши свою игру в одном-двух предложениях (например: Мрачный рыцарь бежит по подземелью и уворачивается от шипов).`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главное меню', 'main_menu')]]) });
});

bot.action(/engine_(?!ai)(.+)/, async (ctx) => {
    ctx.session.gameData.engine = ctx.match[1];
    await ctx.editMessageText('Отлично! Теперь выбери визуальный шаблон (атмосферу) для твоей игры:', Markup.inlineKeyboard([
        [Markup.button.callback('🌌 Немые Звезды', 'biome_silent_stars')], [Markup.button.callback('🩸 Темное Фэнтези', 'biome_credo_fantasy')],
        [Markup.button.callback('🍃 Волшебный Лес', 'biome_ghibli_forest')], [Markup.button.callback('🌃 Неоновый Токио', 'biome_neon_tokyo')], [Markup.button.callback('⚙️ Ржавая Пустошь', 'biome_wasteland')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ]));
});

bot.action(/biome_(.+)/, async (ctx) => {
    ctx.session.gameData.biome = ctx.match[1];
    ctx.session.step = 'awaiting_name';
    await ctx.editMessageText('Шаблон применен! 🎨\nТеперь придумай и напиши мне название для твоей игры:');
});

async function handleAIGeneration(chatId, msgId, prompt, ctx) {
    const userId = ctx.from.id;
    const user = getUser(userId);
    const platform = ctx.session.gameData.platform || 'pc'; 
    
    user.balance -= COST_PER_GAME;
    saveDb();

    generateAIGame(prompt, platform).then(async (gameCode) => {
        if (!gameCode) {
            user.balance += COST_PER_GAME;
            saveDb();
            return bot.telegram.editMessageText(chatId, msgId, null, '❌ Ошибка генерации. Сервера Google перегружены или не хватило токенов. Токены возвращены на баланс.', Markup.inlineKeyboard([[Markup.button.callback('🔄 Попробовать снова', 'regen_ai')], [Markup.button.callback('🏠 Главное меню', 'main_menu')]]));
        }

        const gameId = `ai_${Date.now()}`;
        fs.writeFileSync(path.join(aiGamesDir, `${gameId}.html`), gameCode);
        
        const url = `${process.env.WEBAPP_URL}/ai_games/${gameId}.html`;
        
        await bot.telegram.editMessageText(chatId, msgId, null, `✅ Твоя игра успешно создана!\n💰 Списано: -${COST_PER_GAME} 🪙\n💳 Остаток: ${user.balance} 🪙`, Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('📦 Скачать Архив', `dl_ai_${gameId}`)],
            [Markup.button.callback('🔁 Перегенерировать (тот же запрос)', 'regen_ai')],
            [Markup.button.callback('📝 Новая игра (другой запрос)', 'engine_ai')],
            [Markup.button.callback('🏠 В главное меню', 'main_menu')]
        ]));
    }).catch(err => {
        user.balance += COST_PER_GAME;
        saveDb();
        bot.telegram.editMessageText(chatId, msgId, null, '❌ Критическая ошибка при генерации. Токены не списаны.', Markup.inlineKeyboard([[Markup.button.callback('🔄 Попробовать снова', 'regen_ai')], [Markup.button.callback('🏠 Главное меню', 'main_menu')]]));
    });
}

bot.action('regen_ai', async (ctx) => {
    const prompt = ctx.session?.gameData?.lastPrompt;
    if (!prompt) return ctx.answerCbQuery('❌ Прошлый запрос не найден. Создай игру заново.', { show_alert: true });

    const user = getUser(ctx.from.id);
    if (user.balance < COST_PER_GAME) {
        return ctx.answerCbQuery('❌ Недостаточно токенов для перегенерации!', { show_alert: true });
    }

    await ctx.editMessageText('✨ Призываю мощности Gemini... \n\nПерезапускаю генерацию по твоему прошлому запросу. Жди обновления сообщения! ⚡');
    handleAIGeneration(ctx.chat.id, ctx.callbackQuery.message.message_id, prompt, ctx);
});

bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'awaiting_ai_prompt') {
        const prompt = ctx.message.text;
        const chatId = ctx.chat.id;
        
        ctx.session.step = null;
        ctx.session.gameData.lastPrompt = prompt; 
        
        const msg = await ctx.reply('✨ Призываю мощности Gemini... \n\nПроцесс запущен в фоновом режиме. Пишу код... ⚡');
        handleAIGeneration(chatId, msg.message_id, prompt, ctx);
        return;
    }

    if (ctx.session?.step === 'awaiting_name') {
        ctx.session.gameData.gameName = ctx.message.text;
        ctx.session.step = 'awaiting_bg_choice';
        await ctx.reply(`Супер! Название «${ctx.message.text}» принято.\n\nДобавим на задний фон свою фотографию?`, Markup.inlineKeyboard([[Markup.button.callback('🏞 Оставить всё как есть', 'bg_choice_standard')], [Markup.button.callback('🖼 Добавить свою (PRO)', 'bg_choice_custom')]]));
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
        await ctx.editMessageText('Отлично! Отправь мне картинку, которая станет фоном твоей игры 🖼️');
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
            if (!isSafe) return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '🔞 Ого-го! Мой сканер заметил что-то неприличное. Давай выберем картинку поскромнее!');

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
        } catch (e) { ctx.reply('❌ Ошибка при загрузке картинки.'); }
    }
});

async function finishGameGeneration(ctx) {
    const data = ctx.session.gameData;
    const encName = encodeURIComponent(data.gameName);
    const encBg = data.customBgFile ? `&bg=${data.customBgFile}` : '';
    const platformParam = `&platform=${data.platform || 'pc'}`; 
    const url = `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}&name=${encName}${encBg}${platformParam}`; 
    
    await ctx.reply(`✅ Игра "${data.gameName}" успешно сгенерирована!`, Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 ИГРАТЬ', url)],
        [Markup.button.callback('📦 Скачать Архив', 'download_source')],
        [Markup.button.callback('🏠 Главное меню', 'main_menu')]
    ]));
}

bot.action(/dl_ai_(.+)/, async (ctx) => {
    const gameId = ctx.match[1]; 
    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    const zipPath = path.join(os.tmpdir(), `${gameId}.zip`);

    if (!fs.existsSync(gamePath)) return ctx.answerCbQuery('❌ Файл игры не найден!', { show_alert: true });

    try {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', async () => {
            await ctx.replyWithDocument({ source: zipPath, filename: `ai_generated_game.zip` });
            fs.unlinkSync(zipPath); 
        });
        archive.pipe(output);
        archive.file(gamePath, { name: 'index.html' });
        archive.finalize();
    } catch (e) { ctx.reply('❌ Ошибка сборки архива.'); }
});

bot.action('download_source', async (ctx) => {
    const data = ctx.session.gameData;
    const s = styles[data.biome];
    const platform = data.platform || 'pc';
    const tempDir = path.join(os.tmpdir(), `build_${Date.now()}`); 
    const zipPath = path.join(os.tmpdir(), `game_${data.engine}.zip`); 

    try {
        fse.copySync(path.join(__dirname, 'templates', `${data.engine}_core`), tempDir);
        let finalBgPath = s.img;
        if (data.customBgFile) {
            fse.copySync(path.join(uploadsDir, data.customBgFile), path.join(tempDir, 'custom_bg.jpg'));
            finalBgPath = 'custom_bg.jpg';
        }

        const indexPath = path.join(tempDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/{{GAME_TITLE}}/g, data.gameName || s.name).replace(/{{BG_IMAGE}}/g, finalBgPath).replace(/{{BG_COLOR}}/g, s.bg).replace(/{{BLOCK_COLOR}}/g, s.block).replace(/{{FONT_FAMILY}}/g, s.font).replace(/{{SHADOW}}/g, s.shadow).replace(/{{LIFE_ICON}}/g, s.life).replace(/{{SCORE_ICON}}/g, s.score).replace(/{{BOOSTER_WIDE}}/g, s.b_wide).replace(/{{BOOSTER_TRIPLE}}/g, s.b_triple).replace(/{{BOOSTER_FIRE}}/g, s.b_fire).replace(/{{BOOSTER_LIGHTNING}}/g, s.b_lightning).replace(/{{PLATFORM}}/g, platform); 
        fs.writeFileSync(indexPath, html);

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', async () => {
            await ctx.replyWithDocument({ source: zipPath, filename: `${data.gameName}.zip` });
            fse.removeSync(tempDir); fs.unlinkSync(zipPath);
        });
        archive.pipe(output); archive.directory(tempDir, false); archive.finalize();
    } catch (e) { ctx.reply('❌ Ошибка сборки архива.'); }
});

bot.launch();
