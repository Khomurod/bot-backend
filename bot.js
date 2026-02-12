require('dotenv').config(); 
const http = require('http'); 
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// 1. CONFIGURATION
const TOKEN = process.env.BOT_TOKEN || '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 
const PANTRY_ID = process.env.PANTRY_ID || '42f7bc17-4c7d-4314-9a0d-19f876d39db6'; 
const PANTRY_URL = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/driver_data`;
const ADMIN_GROUP_ID = -5275569828; 

const bot = new TelegramBot(TOKEN, { polling: true });
const userSessions = {};
let cachedData = { questions: [], groups: [], history: [] };

// --- 🛡️ STABILITY & SHUTDOWN FIXES ---

// 1. Polling Error "Airbag" (Prevents crashes on internet blips)
bot.on('polling_error', (error) => {
    // EFATAL errors are just connection resets. We ignore them.
    if (error.code !== 'EFATAL') {
        console.log(`[Polling Error] ${error.code}: ${error.message}`);
    }
});

// 2. GRACEFUL SHUTDOWN (The Zombie Killer 🧟‍♂️)
// When Koyeb restarts the app, this stops the old bot immediately.
const stopBot = () => {
    console.log("Stopping bot...");
    bot.stopPolling();
    process.exit(0);
};
process.on('SIGINT', stopBot);
process.on('SIGTERM', stopBot);

// --- END FIXES ---

// 2. LOAD DATA
async function loadData() {
    try {
        const res = await fetch(PANTRY_URL);
        if (res.ok) {
            cachedData = await res.json();
            if (!cachedData.questions) cachedData.questions = [];
            if (!cachedData.groups) cachedData.groups = [];
            if (!cachedData.history) cachedData.history = [];
            if (cachedData.broadcast_queue) sendBroadcast(cachedData.broadcast_queue);
        }
    } catch (e) {
        console.error("Error fetching from Pantry:", e);
    }
}

// 3. BROADCAST LOGIC
async function sendBroadcast(message) {
    for (const group of cachedData.groups) {
        if (group.id === ADMIN_GROUP_ID) continue; 
        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to group ${group.name}:`, err.message);
            }
        }
    }
    cachedData.broadcast_queue = null;
    saveToPantry();
}

async function saveToPantry() {
    try {
        await fetch(PANTRY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cachedData)
        });
    } catch (e) { console.error("Error saving:", e); }
}

// 4. GROUP REGISTRATION
bot.on('message', async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const groupId = msg.chat.id;
        const groupName = msg.chat.title;
        const exists = cachedData.groups.find(g => g.id === groupId);
        if (!exists) {
            cachedData.groups.push({ id: groupId, name: groupName, enabled: true });
            console.log(`New Group Registered: ${groupName}`);
            await saveToPantry();
        }
    }
});

// 5. START SURVEY
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId === ADMIN_GROUP_ID) return;
    await loadData();

    if (cachedData.questions.length === 0) return bot.sendMessage(chatId, "No questions setup.");

    let identifier = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    userSessions[chatId] = { step: 0, answers: [], userInfo: identifier };
    
    bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}! Let's start.`);
    askQuestion(chatId);
});

function askQuestion(chatId) {
    const session = userSessions[chatId];
    const question = cachedData.questions[session.step];
    if (!question) { finishSurvey(chatId); return; }

    let options = {};
    if (question.type === 'choice' && question.options) {
        options = { reply_markup: { keyboard: question.options.map(o => ([o])), one_time_keyboard: true, resize_keyboard: true } };
    } else {
        options = { reply_markup: { remove_keyboard: true } };
    }
    bot.sendMessage(chatId, `📝 ${question.text}`, options);
}

// HANDLE ANSWERS
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text === '/start' || msg.chat.type !== 'private') return;
    const session = userSessions[chatId];
    if (!session) return;

    const currentQ = cachedData.questions[session.step];
    if (currentQ.type === 'choice' && currentQ.options && !currentQ.options.includes(msg.text)) {
        return bot.sendMessage(chatId, "❌ Please select a button.");
    }

    session.answers.push({ question: currentQ.text, answer: msg.text });
    session.step++;
    askQuestion(chatId);
});

async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    bot.sendMessage(chatId, "✅ Feedback sent!", { reply_markup: { remove_keyboard: true } });

    let report = `📝 <b>Feedback:</b> ${session.userInfo}\n\n`;
    session.answers.forEach(a => report += `<b>${a.question}</b>\n${a.answer}\n\n`);
    
    try { await bot.sendMessage(ADMIN_GROUP_ID, report, { parse_mode: "HTML" }); } catch (e) {}

    cachedData.history.push({ date: new Date().toISOString(), user: session.userInfo, answers: session.answers });
    await saveToPantry();
    delete userSessions[chatId];
}

setInterval(loadData, 60000); 

// 6. HEALTH CHECK (Keep Alive)
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
});
const port = process.env.PORT || 8000;
server.listen(port, () => console.log(`Health check running on ${port}`));

loadData();
