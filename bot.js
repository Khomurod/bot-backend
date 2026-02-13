require('dotenv').config(); 
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// --- 1. CONFIGURATION ---
const TOKEN = process.env.BOT_TOKEN || '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 

// CONFIG: Weekly Survey Time (5 = Friday, 16 = 4:00 PM UTC)
const WEEKLY_DAY = 5; 
const WEEKLY_HOUR = 16; 

const bot = new TelegramBot(TOKEN, { polling: true });
const userSessions = {};
const DB_FILE = path.join(__dirname, 'database.json');

// --- DATA STORE ---
let cachedData = { 
    questions: [], 
    groups: [], 
    history: [], 
    scheduled_queue: [], 
    last_weekly_run: "",
    broadcast_queue: null 
};

// --- STABILITY FIXES ---
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

// --- 2. LOCAL DATA LOADING & SAVING ---
async function loadData() {
    try {
        const data = await fs.readFile(DB_FILE, 'utf8');
        cachedData = JSON.parse(data);
        
        if (cachedData.broadcast_queue) {
            await sendBroadcast(cachedData.broadcast_queue);
        }
        checkSchedules();
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log("No database file found, creating a new one...");
            await saveToDatabase();
        } else {
            console.error("Error reading database:", e);
        }
    }
}

async function saveToDatabase() {
    try {
        await fs.writeFile(DB_FILE, JSON.stringify(cachedData, null, 2));
    } catch (e) { 
        console.error("Error saving to database:", e); 
    }
}

// --- HELPER: GET ADMIN GROUPS ---
function getAdminGroupIds() {
    return cachedData.groups.filter(g => g.is_admin === true).map(g => g.id);
}

// --- 3. BROADCASTING & SCHEDULING ---
async function sendBroadcast(message) {
    console.log("Sending Broadcast:", message);
    for (const group of cachedData.groups) {
        if (group.is_admin) continue; // Skip admin groups
        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to ${group.name}:`, err.message);
            }
        }
    }
    
    cachedData.broadcast_queue = null;
    await saveToDatabase();
    console.log("Broadcast queue cleared.");
}

async function checkSchedules() {
    const now = new Date();
    let dataChanged = false;

    const todayStr = now.toISOString().split('T')[0]; 
    const isTargetDay = now.getDay() === WEEKLY_DAY;
    const isTime = now.getHours() >= WEEKLY_HOUR;
    const alreadySent = cachedData.last_weekly_run === todayStr;

    if (isTargetDay && isTime && !alreadySent) {
        console.log("🚀 Triggering Weekly Survey!");
        const botUser = await bot.getMe();
        const botLink = `https://t.me/${botUser.username}?start=weekly`;

        const surveyText = "Hey, hope your week is going well. Please take the small survey clicking on the button below, that'd help us improve our services. Thank you";

        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📝 Take the Survey", url: botLink }]
                ]
            }
        };
        
        for (const group of cachedData.groups) {
            if (group.is_admin) continue; // Skip admin groups
            if (group.enabled) {
                try {
                    await bot.sendMessage(group.id, surveyText, options);
                } catch (e) {
                    console.error(`Failed to send to group ${group.id}`);
                }
            }
        }
        
        cachedData.last_weekly_run = todayStr;
        dataChanged = true;
    }

    if (cachedData.scheduled_queue && cachedData.scheduled_queue.length > 0) {
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

    if (dataChanged) await saveToDatabase();
}

// --- 4. CORE BOT FUNCTIONS ---
bot.on('message', async (msg) => {
    // Group Registration
    if (['group', 'supergroup'].includes(msg.chat.type)) {
        const exists = cachedData.groups.find(g => g.id === msg.chat.id);
        if (!exists) {
            // New groups default to Drivers (is_admin: false)
            cachedData.groups.push({ id: msg.chat.id, name: msg.chat.title, enabled: true, is_admin: false });
            console.log(`New Group: ${msg.chat.title}`);
            await saveToDatabase();
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
    const adminIds = getAdminGroupIds();
    
    // Ignore if an admin group somehow triggers /start
    if (adminIds.includes(chatId)) return;
    
    await loadData();
    if (cachedData.questions.length === 0) return bot.sendMessage(chatId, "No questions setup.");

    let identifier = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    userSessions[chatId] = { step: 0, answers: [], userInfo: identifier };
    
    await bot.sendMessage(chatId, `👋 Hello, ${msg.from.first_name}!\n\nI have a few quick questions for you. Let's get started!`);
    
    askQuestion(chatId);
});

function askQuestion(chatId) {
    const session = userSessions[chatId];
    const question = cachedData.questions[session.step];
    if (!question) { finishSurvey(chatId); return; }

    let options = {}; 
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
    
    bot.sendMessage(chatId, `📝 Question ${session.step + 1}:\n${question.text}`, options);
}

function handleAnswer(msg) {
    const chatId = msg.chat.id;
    const session = userSessions[chatId];
    const currentQ = cachedData.questions[session.step];
    
    if (currentQ.type === 'choice' && currentQ.options && !currentQ.options.includes(msg.text)) {
        return bot.sendMessage(chatId, "❌ Please select one of the buttons below.");
    }
    session.answers.push({ question: currentQ.text, answer: msg.text });
    session.step++;
    askQuestion(chatId);
}

async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    bot.sendMessage(chatId, "✅ Thank you! Your feedback has been sent.", { reply_markup: { remove_keyboard: true } });

    let report = `📝 New Feedback Received\n`;
    report += `👤 Driver: ${session.userInfo}\n`;
    report += `🆔 ID: ${chatId}\n\n`;
    
    session.answers.forEach(a => report += `Q: ${a.question}\n${a.answer}\n\n`);
    
    // Send report to ALL groups marked as Admin
    const adminIds = getAdminGroupIds();
    if (adminIds.length === 0) {
        console.log("Warning: No Admin groups are set up to receive this report!");
    } else {
        for (const adminId of adminIds) {
            try { await bot.sendMessage(adminId, report); } catch (e) {}
        }
    }

    cachedData.history.push({ date: new Date().toISOString(), user: session.userInfo, answers: session.answers });
    await saveToDatabase();
    delete userSessions[chatId];
}

// --- 5. SECURE API SERVER ---
const app = express();
app.use(cors()); 
app.use(express.json());

app.get('/api/data', (req, res) => {
    res.json(cachedData);
});

app.post('/api/data', async (req, res) => {
    try {
        cachedData = { ...cachedData, ...req.body };
        await saveToDatabase();
        res.json({ success: true, message: "Data saved securely" });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to save data" });
    }
});

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Secure API and Bot running on port ${port}`));

setInterval(loadData, 60000); 
loadData();
