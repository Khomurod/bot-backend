require('dotenv').config(); 
const http = require('http'); 
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// 1. CONFIGURATION
const TOKEN = process.env.BOT_TOKEN || '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 
const PANTRY_ID = process.env.PANTRY_ID || '42f7bc17-4c7d-4314-9a0d-19f876d39db6'; 
const PANTRY_URL = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/driver_data`;
const ADMIN_GROUP_ID = -5275569828; 

// CONFIG: Weekly Survey Time (0 = Sunday, 10 = 10 AM UTC)
const WEEKLY_DAY = 0; 
const WEEKLY_HOUR = 10; 

const bot = new TelegramBot(TOKEN, { polling: true });
const userSessions = {};

// DATA STORE
let cachedData = { 
    questions: [], 
    groups: [], 
    history: [], 
    scheduled_queue: [], 
    last_weekly_run: ""  
};

// --- 🛡️ STABILITY FIXES ---
bot.on('polling_error', (error) => {
    if (error.code !== 'EFATAL') console.log(`[Polling Error] ${error.code}: ${error.message}`);
});
const stopBot = () => {
    console.log("Stopping bot...");
    bot.stopPolling();
    process.exit(0);
};
process.on('SIGINT', stopBot);
process.on('SIGTERM', stopBot);

// --- 2. DATA LOADING & SAVING ---
async function loadData() {
    try {
        const res = await fetch(PANTRY_URL);
        if (res.ok) {
            const data = await res.json();
            cachedData = {
                questions: data.questions || [],
                groups: data.groups || [],
                history: data.history || [],
                scheduled_queue: data.scheduled_queue || [],
                last_weekly_run: data.last_weekly_run || ""
            };
            
            if (data.broadcast_queue) sendBroadcast(data.broadcast_queue);
            checkSchedules();
        }
    } catch (e) {
        console.error("Error fetching from Pantry:", e);
    }
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

// --- 3. BROADCASTING & SCHEDULING ---
async function sendBroadcast(message) {
    console.log("Sending Broadcast:", message);
    for (const group of cachedData.groups) {
        if (group.id === ADMIN_GROUP_ID) continue; 
        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to ${group.name}:`, err.message);
            }
        }
    }
    if (cachedData.broadcast_queue) {
        cachedData.broadcast_queue = null;
        saveToPantry();
    }
}

async function checkSchedules() {
    const now = new Date();
    let dataChanged = false;

    // A. Weekly Sunday Survey
    const todayStr = now.toISOString().split('T')[0]; 
    const isSunday =now.getDay() === WEEKLY_DAY;
    const isTime = now.getHours() >= WEEKLY_HOUR;
    const alreadySent = cachedData.last_weekly_run === todayStr;

    if (isSunday && isTime && !alreadySent) {
        console.log("🚀 Triggering Weekly Survey!");
        const botUser = await bot.getMe();
        const surveyMsg = `📋 <b>Weekly Feedback Time!</b>\n\nPlease verify your truck status and share your feedback for the week.\n\n👉 <a href="https://t.me/${botUser.username}?start=weekly">Click here to Start Survey</a>`;
        
        for (const group of cachedData.groups) {
            if (group.id === ADMIN_GROUP_ID) continue;
            if (group.enabled) {
                try {
                    await bot.sendMessage(group.id, surveyMsg, { parse_mode: "HTML" });
                } catch (e) {}
            }
        }
        
        cachedData.last_weekly_run = todayStr;
        dataChanged = true;
    }

    // B. Scheduled Messages
    if (cachedData.scheduled_queue.length > 0) {
        const remainingQueue = [];
        for (const item of cachedData.scheduled_queue) {
            const scheduledTime = new Date(item.time);
            if (now >= scheduledTime) {
                await sendBroadcast(item.text);
                dataChanged = true; 
            } else {
                remainingQueue.push(item);
            }
        }
        if (remainingQueue.length !== cachedData.scheduled_queue.length) {
            cachedData.scheduled_queue = remainingQueue;
            dataChanged = true;
        }
    }

    if (dataChanged) await saveToPantry();
}

// --- 4. CORE BOT FUNCTIONS ---

bot.on('message', async (msg) => {
    // Group Registration
    if (['group', 'supergroup'].includes(msg.chat.type)) {
        const exists = cachedData.groups.find(g => g.id === msg.chat.id);
        if (!exists) {
            cachedData.groups.push({ id: msg.chat.id, name: msg.chat.title, enabled: true });
            console.log(`New Group: ${msg.chat.title}`);
            await saveToPantry();
        }
    }
    // Handle Answers
    if (msg.chat.type === 'private' && userSessions[msg.chat.id]) {
        if (msg.text === '/start') return;
        handleAnswer(msg);
    }
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId === ADMIN_GROUP_ID) return;
    await loadData();
    if (cachedData.questions.length === 0) return bot.sendMessage(chatId, "No questions setup.");

    let identifier = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    userSessions[chatId] = { step: 0, answers: [], userInfo: identifier };
    
    // RESTORED: The nice HTML Welcome Message
    await bot.sendMessage(chatId, `👋 <b>Hello, ${msg.from.first_name}!</b>\n\nI have a few quick questions for you. Let's get started!`, { parse_mode: "HTML" });
    
    askQuestion(chatId);
});

function askQuestion(chatId) {
    const session = userSessions[chatId];
    const question = cachedData.questions[session.step];
    if (!question) { finishSurvey(chatId); return; }

    let options = {}; // Reset options object
    if (question.type === 'choice' && question.options) {
        options = { 
            reply_markup: { 
                keyboard: question.options.map(o => ([o])), 
                one_time_keyboard: true, 
                resize_keyboard: true 
            } 
        };
    } else {
        options = { reply_markup: { remove_keyboard: true } };
    }
    
    // RESTORED: The "Question X:" prefix and Bold text
    // Merging parse_mode into the options object
    const finalOptions = { ...options, parse_mode: "HTML" };
    
    bot.sendMessage(chatId, `📝 <b>Question ${session.step + 1}:</b>\n${question.text}`, finalOptions);
}

function handleAnswer(msg) {
    const chatId = msg.chat.id;
    const session = userSessions[chatId];
    const currentQ = cachedData.questions[session.step];
    
    if (currentQ.type === 'choice' && currentQ.options && !currentQ.options.includes(msg.text)) {
        return bot.sendMessage(chatId, "❌ <b>Please select one of the buttons below.</b>", { parse_mode: "HTML" });
    }
    session.answers.push({ question: currentQ.text, answer: msg.text });
    session.step++;
    askQuestion(chatId);
}

async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    bot.sendMessage(chatId, "✅ <b>Thank you!</b> Your feedback has been sent.", { parse_mode: "HTML", reply_markup: { remove_keyboard: true } });

    let report = `📝 <b>New Feedback Received</b>\n`;
    report += `👤 <b>Driver:</b> ${session.userInfo}\n`;
    report += `🆔 <b>ID:</b> ${chatId}\n\n`;
    
    session.answers.forEach(a => report += `<b>Q: ${a.question}</b>\n${a.answer}\n\n`);
    
    try { await bot.sendMessage(ADMIN_GROUP_ID, report, { parse_mode: "HTML" }); } catch (e) {}

    cachedData.history.push({ date: new Date().toISOString(), user: session.userInfo, answers: session.answers });
    await saveToPantry();
    delete userSessions[chatId];
}

setInterval(loadData, 60000); 

const server = http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running!'); });
const port = process.env.PORT || 8000;
server.listen(port, () => console.log(`Health check running on ${port}`));

loadData();
