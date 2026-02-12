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
    scheduled_queue: [], // New: For one-off scheduled msgs
    last_weekly_run: ""  // New: To prevent duplicate Sunday sends
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
            // Merge defaults to prevent crashes
            cachedData = {
                questions: data.questions || [],
                groups: data.groups || [],
                history: data.history || [],
                scheduled_queue: data.scheduled_queue || [],
                last_weekly_run: data.last_weekly_run || ""
            };
            
            // Immediate Broadcast (Immediate Queue)
            if (data.broadcast_queue) sendBroadcast(data.broadcast_queue);
            
            // Check Schedules
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

// Send to ALL Driver Groups
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
    // Clear immediate queue if it exists
    if (cachedData.broadcast_queue) {
        cachedData.broadcast_queue = null;
        saveToPantry();
    }
}

// THE NEW SCHEDULER FUNCTION (Runs every minute)
async function checkSchedules() {
    const now = new Date();
    let dataChanged = false;

    // A. Weekly Sunday Survey
    const todayStr = now.toISOString().split('T')[0]; // "2023-10-27"
    const isSunday =now.getDay() === WEEKLY_DAY;
    const isTime = now.getHours() >= WEEKLY_HOUR;
    const alreadySent = cachedData.last_weekly_run === todayStr;

    if (isSunday && isTime && !alreadySent) {
        console.log("🚀 Triggering Weekly Survey!");
        const botUser = await bot.getMe();
        const surveyMsg = `📋 <b>Weekly Feedback Time!</b>\n\nPlease verify your truck status and share your feedback for the week.\n\n👉 <a href="https://t.me/${botUser.username}?start=weekly">Click here to Start Survey</a>`;
        
        // Send to all groups
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
                // Time to send!
                await sendBroadcast(item.text);
                dataChanged = true; // Queue changed
            } else {
                // Keep for later
                remainingQueue.push(item);
            }
        }
        
        // Update local queue only if items were removed
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
    
    bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}! Let's start.`);
    askQuestion(chatId);
});

function askQuestion(chatId) {
    const session = userSessions[chatId];
    const question = cachedData.questions[session.step];
    if (!question) { finishSurvey(chatId); return; }

    let options = { reply_markup: { remove_keyboard: true } };
    if (question.type === 'choice' && question.options) {
        options = { reply_markup: { keyboard: question.options.map(o => ([o])), one_time_keyboard: true, resize_keyboard: true } };
    }
    bot.sendMessage(chatId, `📝 ${question.text}`, options);
}

function handleAnswer(msg) {
    const chatId = msg.chat.id;
    const session = userSessions[chatId];
    const currentQ = cachedData.questions[session.step];
    
    if (currentQ.type === 'choice' && currentQ.options && !currentQ.options.includes(msg.text)) {
        return bot.sendMessage(chatId, "❌ Please select a button.");
    }
    session.answers.push({ question: currentQ.text, answer: msg.text });
    session.step++;
    askQuestion(chatId);
}

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

// 7. HEARTBEAT & SERVER
setInterval(loadData, 60000); // Checks Pantry & Schedule every 60s

const server = http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running!'); });
const port = process.env.PORT || 8000;
server.listen(port, () => console.log(`Health check running on ${port}`));

loadData();
