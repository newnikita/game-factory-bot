require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const express = require('express');
const fse = require('fs-extra');
const axios = require('axios');

process.on('uncaughtException', (err) => console.error('❌ Ошибка:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Ошибка сети:', err.message));

const dbPath = path.join(__dirname, 'users.json');
let usersDb = {};
const ADMIN_ID = 123456789; // Впиши сюда свой ID

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
    if (id == ADMIN_ID || (process.env.ADMIN_ID && id == process.env.ADMIN_ID)) {
        if (usersDb[id].balance < 1000000) {
            usersDb[id].balance = 1000000;
            saveDb();
        }
    }
    return usersDb[id];
}

const COST_PER_GAME = 25;
const REWARD_PER_REF = 100;

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

bot.use((ctx, next) => {
    if (!ctx.session) ctx.session = {};
    if (!ctx.session.gameData) ctx.session.gameData = {};
    return next();
});

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

async function checkImageSafety(imageUrl) {
    try {
        if (!process.env.SIGHT_USER || !process.env.SIGHT_SECRET) return true;
        const response = await axios.get('https://api.sightengine.com/1.0/check.json', {
            params: {
                'url': imageUrl,
                'models': 'nudity-2.0',
                'api_user': process.env.SIGHT_USER,
                'api_secret': process.env.SIGHT_SECRET
            }
        });
        return !(response.data.status === 'success' && response.data.nudity.none < 0.8);
    } catch (e) {
        return true;
    }
}

function selectReferenceEngine(prompt) {
    const text = prompt.toLowerCase();
    const pWords = ['прыг', 'скач', 'платформ', 'беж', 'паркур', 'гравитац', 'вверх', 'уворачива', 'вниз'];
    const sWords = ['шутер', 'стреля', 'выживан', 'оружие', 'пул', 'зомб', 'арена', 'отстрел', 'убива', 'враг'];
    
    if (sWords.some(w => text.includes(w))) return 'shooter.html';
    if (pWords.some(w => text.includes(w))) return 'platformer.html';
    return 'breaker.html';
}

async function generateAIGame(userPrompt, platform = 'pc', maxRetries = 5) {
    try {
        if (!process.env.GEMINI_API_KEY) throw new Error("Ключ Gemini не настроен");
        
        const selectedFile = selectReferenceEngine(userPrompt);
        let referenceCode = `\n\n=== ЭТАЛОН КОДА: ${selectedFile} ===\n`;
        const refPath = path.join(__dirname, 'references', selectedFile);
        
        if (fs.existsSync(refPath)) {
            referenceCode += fs.readFileSync(refPath, 'utf8');
        }

        const controlsMobile = "▶ УПРАВЛЕНИЕ ДЛЯ МОБИЛЬНЫХ: ИСКЛЮЧИТЕЛЬНО touch-события. ЗАПРЕЩЕНЫ мышь и клавиатура. ЗАПРЕЩЕНЫ HTML-кнопки. Используй e.preventDefault().";
        const controlsPC = "▶ УПРАВЛЕНИЕ ДЛЯ ПК: Стандартное управление с клавиатуры или клики мышью. ЗАПРЕЩЕНЫ touch-события.";
        const controlsPrompt = platform === 'mobile' ? controlsMobile : controlsPC;

        const marker = String.fromCharCode(96, 96, 96);
        const promptLines = [
            "Ты — профессиональный разработчик Canvas игр.",
            "Сделай ПОЛНОСТЬЮ РАБОЧУЮ игру в ОДНОМ файле.",
            "АБСОЛЮТНЫЕ ЗАПРЕТЫ И ПРАВИЛА:",
            "1. ЗАПРЕЩЕНО делать HTML-экраны загрузки. Игра запускается МГНОВЕННО.",
            "2. Для персонажей используй пиксель-арт (массив из 0 и цифр для цветов) через ctx.fillRect.",
            "3. ПИШИ МАКСИМАЛЬНО ПРОСТУЮ ЛОГИКУ. Без аудио, локализаций, localStorage.",
            "4. ВЫДАВАЙ ТОЛЬКО КОД. Без комментариев.",
            "5. ОБЯЗАТЕЛЬНО добавь CSS-свойство background к тегу body:",
            "background: url('{{AI_BG_IMAGE}}') center/cover no-repeat;",
            "6. Перед </html> напиши тег: [BG: 1-2 англ слова для фона].",
            "ПРАВИЛА УПРАВЛЕНИЯ: " + controlsPrompt,
            "Эталон кода для физики и архитектуры:",
            referenceCode,
            "Идея для новой игры: " + userPrompt
        ];
        const fullPrompt = promptLines.join('\n');

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        let fullCode = "";
        let history = [{ role: "user", parts: [{ text: fullPrompt }] }];
        let isFinished = false;

        for (let chunk = 0; chunk < 4; chunk++) {
            let attemptSuccess = false;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const payload = {
                        contents: history,
                        safetySettings: [
                            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                        ],
                        generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 8192 }
                    };
                    
                    const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
                    const chunkText = response.data.candidates[0].content.parts[0].text;
                    fullCode += chunkText;
                    
                    let cleanCheck = fullCode.replace(new RegExp(marker + 'html', 'gi'), '');
                    cleanCheck = cleanCheck.replace(new RegExp(marker, 'g'), '').trim();

                    if (!cleanCheck.includes('</html>') && chunk < 3) {
                        history.push({ role: "model", parts: [{ text: chunkText }] });
                        history.push({ role: "user", parts: [{ text: "Код оборвался. Продолжи СТРОГО с того символа, где остановился." }] });
                        attemptSuccess = true;
                        break;
                    } else {
                        isFinished = true;
                        attemptSuccess = true;
                        break;
                    }
                } catch (err) {
                    if (err.response && (err.response.status === 503 || err.response.status === 429)) {
                        if (attempt === maxRetries) throw err;
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                    throw err;
                }
            }
            if (isFinished || !attemptSuccess) break;
        }
        
        let finalOutput = fullCode.replace(new RegExp(marker + 'html', 'gi'), '');
        return finalOutput.replace(new RegExp(marker, 'g'), '').trim();
        
    } catch(e) { 
        return null; 
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Фабрика Игр: Статус OK'));
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
    if (['ai_games', 'uploads', 'references'].includes(engine)) return next();
    
    const biome = req.query.biome || 'silent_stars';
    const s = styles[biome] || styles['silent_stars'];
    const platform = req.query.platform || 'pc';
    const indexPath = path.join(__dirname, 'templates', `${engine}_core`, 'index.html');
    
    if (!fs.existsSync(indexPath)) return res.status(404).send("<h2>⚙️ Движок в разработке.</h2>");
    
    let html = fs.readFileSync(indexPath, 'utf8');
    const customBg = req.query.bg ? `/uploads/${req.query.bg}` : s.img;
    const gameName = req.query.name || s.name;
    
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

function getMainMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🎮 Создать игру', 'start_creation')],
        [Markup.button.callback('👤 Мой профиль / Баланс', 'show_profile')],
        [Markup.button.callback('👥 Пригласить друга', 'show_referral')],
        [Markup.button.url('🌐 Наше сообщество', 'https://t.me/your_community_link')]
    ]);
}

bot.start(async (ctx) => {
    ctx.session.gameData = {}; 
    ctx.session.step = null;
    const userId = ctx.from.id; 
    const refId = ctx.payload;
    const user = getUser(userId);
    
    if (!usersDb[userId] && refId && refId != userId && usersDb[refId]) {
        user.referredBy = refId; 
        usersDb[refId].balance += REWARD_PER_REF; 
        usersDb[refId].referrals += 1; 
        saveDb();
        try { 
            await bot.telegram.sendMessage(refId, `🎉 Зарегистрировался новый демиург!\n+${REWARD_PER_REF} 🪙`); 
        } catch (e) {}
    }
    const txt = `🌌 Добро пожаловать!\n\nГенерация стоит ${COST_PER_GAME} 🪙. На счету ${user.balance} 🪙!`;
    return ctx.reply(txt, getMainMenuKeyboard());
});

bot.action('main_menu', async (ctx) => {
    ctx.session.gameData = {}; 
    ctx.session.step = null;
    try { 
        await ctx.editMessageText('🌌 Главное меню:', getMainMenuKeyboard()); 
    } catch(e) { 
        await ctx.reply('🌌 Главное меню:', getMainMenuKeyboard()); 
    }
});

bot.action('show_profile', async (ctx) => {
    const user = getUser(ctx.from.id);
    const bal = user.balance >= 1000000 ? `**БЕСКОНЕЧНОСТЬ 👑**` : `**${user.balance} 🪙**`;
    const genCount = Math.floor(user.balance / COST_PER_GAME);
    const txt = `👤 **Профиль**\n\n🆔 ID: \`${ctx.from.id}\`\n🪙 Баланс: ${bal}\n🕹️ Генераций: **${genCount}**\n👥 Друзей: **${user.referrals}**`;
    
    const kb = [[Markup.button.callback('⬅️ Назад', 'main_menu')]];
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action('show_referral', async (ctx) => {
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    const txt = `👥 **Реферальная программа**\n\nЗа 1 друга: **+${REWARD_PER_REF} 🪙**\nСсылка:\n\`${link}\``;
    
    const kb = [[Markup.button.callback('⬅️ Назад', 'main_menu')]];
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action('start_creation', async (ctx) => {
    ctx.session.step = 'platform';
    const kb = [
        [Markup.button.callback('📱 Мобильная', 'platform_mobile')],
        [Markup.button.callback('💻 ПК', 'platform_pc')],
        [Markup.button.callback('⬅️ Отмена', 'main_menu')]
    ];
    await ctx.editMessageText('Выбери платформу:', Markup.inlineKeyboard(kb));
});

bot.action(/platform_(.+)/, async (ctx) => {
    ctx.session.gameData.platform = ctx.match[1];
    const kb = [
        [Markup.button.callback('🔴 Бабл Шутер', 'engine_bubble')],
        [Markup.button.callback('🧱 Арканоид', 'engine_arkanoid')],
        [Markup.button.callback('🧩 Тетрис', 'engine_tetris')],
        [Markup.button.callback('🚀 Платформер', 'engine_platformer')],
        [Markup.button.callback('🔫 Шутер', 'engine_shooter')],
        [Markup.button.callback('✨ ИИ-Генератор', 'engine_ai')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText('Выбери движок:', Markup.inlineKeyboard(kb));
});

bot.action('engine_ai', async (ctx) => {
    if (getUser(ctx.from.id).balance < COST_PER_GAME) {
        const kb = [
            [Markup.button.callback('👥 Пригласить', 'show_referral')], 
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        return ctx.editMessageText('❌ Мало токенов!', Markup.inlineKeyboard(kb));
    }
    ctx.session.gameData.engine = 'ai'; 
    ctx.session.step = 'awaiting_ai_prompt';
    
    const kb = [[Markup.button.callback('🏠 Меню', 'main_menu')]];
    await ctx.editMessageText(`✨ Опиши свою игру в 1-2 предложениях.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action(/engine_(?!ai)(.+)/, async (ctx) => {
    ctx.session.gameData.engine = ctx.match[1];
    const kb = [
        [Markup.button.callback('🌌 Звезды', 'biome_silent_stars')],
        [Markup.button.callback('🩸 Фэнтези', 'biome_credo_fantasy')],
        [Markup.button.callback('🍃 Лес', 'biome_ghibli_forest')],
        [Markup.button.callback('🌃 Токио', 'biome_neon_tokyo')],
        [Markup.button.callback('⚙️ Пустошь', 'biome_wasteland')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ];
    await ctx.editMessageText('Выбери визуальный шаблон:', Markup.inlineKeyboard(kb));
});

bot.action(/biome_(.+)/, async (ctx) => {
    ctx.session.gameData.biome = ctx.match[1]; 
    ctx.session.step = 'awaiting_name';
    await ctx.editMessageText('Придумай название для игры:');
});

async function handleAIGeneration(chatId, msgId, prompt, ctx) {
    const user = getUser(ctx.from.id);
    user.balance -= COST_PER_GAME; 
    saveDb();
    
    try {
        let gameCode = await generateAIGame(prompt, ctx.session.gameData.platform || 'pc');
        if (!gameCode) throw new Error("Empty game code");

        // Безопасное извлечение тега: ищем маркер [BG: слово] или HTML-комментарий
        const bgMatch = gameCode.match(/(?:|\])/i);
        let bgKeyword = (bgMatch && bgMatch[1]) ? bgMatch[1].trim() : 'dark fantasy';
        
        let customBgUrl = '';

        try {
            const query = encodeURIComponent(bgKeyword);
            const apiKey = process.env.UNSPLASH_ACCESS_KEY || '';
            const unUrl = `https://api.unsplash.com/photos/random?query=${query}&orientation=landscape&client_id=${apiKey}`;
            const unRes = await axios.get(unUrl);
            
            const imgUrl = (unRes.data && unRes.data.urls) ? unRes.data.urls.regular : null;
            if (imgUrl) {
                const fileName = `bg_ai_${Date.now()}.jpg`;
                const filePath = path.join(uploadsDir, fileName);
                const writer = fs.createWriteStream(filePath);
                
                const imgStream = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
                imgStream.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
                
                customBgUrl = `/uploads/${fileName}`;
            }
        } catch (e) {
            console.log("Unsplash error skipped");
        }

        gameCode = gameCode.replace(/\{\{AI_BG_IMAGE\}\}/g, customBgUrl);
        
        const gameId = `ai_${Date.now()}`;
        fs.writeFileSync(path.join(aiGamesDir, `${gameId}.html`), gameCode);
        
        const url = `${process.env.WEBAPP_URL}/ai_games/${gameId}.html`;
        const kb = [
            [Markup.button.webApp('🎮 ИГРАТЬ', url)],
            [Markup.button.callback('📦 Архив', `dl_ai_${gameId}`)],
            [Markup.button.callback('🔁 Перегенерировать', 'regen_ai')],
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        
        const msg = `✅ Игра создана!\n💳 Остаток: ${user.balance} 🪙`;
        await bot.telegram.editMessageText(chatId, msgId, null, msg, Markup.inlineKeyboard(kb));
        
    } catch (err) {
        console.error(err);
        user.balance += COST_PER_GAME; 
        saveDb();
        const kb = [
            [Markup.button.callback('🔄 Повторить', 'regen_ai')], 
            [Markup.button.callback('🏠 Меню', 'main_menu')]
        ];
        await bot.telegram.editMessageText(chatId, msgId, null, '❌ Ошибка генерации.', Markup.inlineKeyboard(kb));
    }
}

bot.action('regen_ai', async (ctx) => {
    const p = ctx.session?.gameData?.lastPrompt;
    if (!p) return ctx.answerCbQuery('❌ Запрос не найден.', { show_alert: true });
    if (getUser(ctx.from.id).balance < COST_PER_GAME) return ctx.answerCbQuery('❌ Мало токенов!', { show_alert: true });
    
    await ctx.editMessageText('✨ Призываю Gemini... Перезапускаю!');
    handleAIGeneration(ctx.chat.id, ctx.callbackQuery.message.message_id, p, ctx);
});

bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'awaiting_ai_prompt') {
        ctx.session.step = null; 
        ctx.session.gameData.lastPrompt = ctx.message.text;
        const msg = await ctx.reply('✨ Призываю Gemini... Пишу код... ⚡');
        handleAIGeneration(ctx.chat.id, msg.message_id, ctx.message.text, ctx);
    } else if (ctx.session?.step === 'awaiting_name') {
        ctx.session.gameData.gameName = ctx.message.text; 
        ctx.session.step = 'awaiting_bg_choice';
        const kb = [
            [Markup.button.callback('🏞 Оставить как есть', 'bg_choice_standard')], 
            [Markup.button.callback('🖼 Своя картинка', 'bg_choice_custom')]
        ];
        await ctx.reply(`Фон?`, Markup.inlineKeyboard(kb));
    }
});

bot.action('bg_choice_standard', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') { 
        ctx.session.gameData.customBgFile = null; 
        ctx.session.step = null; 
        await ctx.editMessageText('✅ Собираю...'); 
        finishGameGeneration(ctx); 
    }
});

bot.action('bg_choice_custom', async (ctx) => {
    if (ctx.session?.step === 'awaiting_bg_choice') { 
        ctx.session.step = 'awaiting_photo'; 
        await ctx.editMessageText('Отправь фото 🖼️'); 
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.session?.step === 'awaiting_photo') {
        const msg = await ctx.reply('⏳ Проверяю...');
        try {
            const url = (await ctx.telegram.getFileLink(ctx.message.photo.pop().file_id)).href;
            if (!(await checkImageSafety(url))) {
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '🔞 Отклонено.');
            }
            const fileName = `bg_${Date.now()}.jpg`; 
            const writer = fs.createWriteStream(path.join(uploadsDir, fileName));
            const response = await axios({ url, method: 'GET', responseType: 'stream' });
            
            response.data.pipe(writer);
            writer.on('finish', () => { 
                ctx.session.gameData.customBgFile = fileName; 
                ctx.session.step = null; 
                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); 
                finishGameGeneration(ctx); 
            });
        } catch (e) { 
            ctx.reply('❌ Ошибка.'); 
        }
    }
});

async function finishGameGeneration(ctx) {
    const data = ctx.session.gameData;
    const bgParam = data.customBgFile ? `&bg=${data.customBgFile}` : '';
    const platform = data.platform || 'pc';
    const nameEnc = encodeURIComponent(data.gameName);
    
    const url = `${process.env.WEBAPP_URL}/${data.engine}/?biome=${data.biome}&name=${nameEnc}${bgParam}&platform=${platform}`;
    const kb = [
        [Markup.button.webApp('🎮 ИГРАТЬ', url)], 
        [Markup.button.callback('📦 Архив', 'download_source')], 
        [Markup.button.callback('🏠 Меню', 'main_menu')]
    ];
    await ctx.reply(`✅ Игра "${data.gameName}" готова!`, Markup.inlineKeyboard(kb));
}

bot.action(/dl_ai_(.+)/, async (ctx) => {
    const gameId = ctx.match[1];
    const zipPath = path.join(os.tmpdir(), `${gameId}.zip`);
    const gamePath = path.join(aiGamesDir, `${gameId}.html`);
    
    if (!fs.existsSync(gamePath)) return ctx.answerCbQuery('❌ Не найдено!', { show_alert: true });
    
    try {
        let html = fs.readFileSync(gamePath, 'utf8');
        const bgMatch = html.match(/\/uploads\/(bg_ai_\d+\.jpg)/);
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(zipPath);
        
        output.on('close', async () => { 
            await ctx.replyWithDocument({ source: zipPath, filename: `ai_game.zip` }); 
            fs.unlinkSync(zipPath); 
        });
        archive.pipe(output);
        
        if (bgMatch && fs.existsSync(path.join(uploadsDir, bgMatch[1]))) {
            archive.file(path.join(uploadsDir, bgMatch[1]), { name: bgMatch[1] });
            archive.append(html.replace(/\/uploads\//g, ''), { name: 'index.html' });
        } else {
            archive.append(html, { name: 'index.html' });
        }
        archive.finalize();
    } catch (e) { 
        ctx.reply('❌ Ошибка.'); 
    }
});

bot.action('download_source', async (ctx) => {
    const data = ctx.session.gameData; 
    const s = styles[data.biome]; 
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
                   .replace(/{{PLATFORM}}/g, data.platform || 'pc');
        
        fs.writeFileSync(indexPath, html);
        const archive = archiver('zip', { zlib: { level: 9 } }); 
        const output = fs.createWriteStream(zipPath);
        
        output.on('close', async () => { 
            await ctx.replyWithDocument({ source: zipPath, filename: `${data.gameName}.zip` }); 
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
