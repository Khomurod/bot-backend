require('dotenv').config(); 
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');

// --- 1. CONFIGURATION ---
const TOKEN = process.env.BOT_TOKEN || '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 
const PANTRY_URL = `https://getpantry.cloud/apiv1/pantry/42f7bc17-4c7d-4314-9a0d-19f876d39db6/basket/driver_data`;

const bot = new TelegramBot(TOKEN, { polling: true });

// --- DATA STORE ---
let cachedData = { 
    questions: [], 
    groups: [], 
    history: [], 
    scheduled_queue: [], 
    last_weekly_run: "",
    broadcast_queue: null,
    sessions: {},
    // NEW: The weekly schedule is now stored and managed here! Default is Friday (5) at 16:00
    weekly_schedule: { day: 5, hour: 16 }
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

// --- 2. CLOUD DATA LOADING & SAVING ---
async function loadData() {
    try {
        const res = await fetch(PANTRY_URL);
        if (res.ok) {
            const data = await res.json();
            
            cachedData = { ...cachedData, ...data };
            if (!cachedData.sessions) cachedData.sessions = {};
            if (!cachedData.weekly_schedule) cachedData.weekly_schedule = { day: 5, hour: 16 };
            
            if (cachedData.broadcast_queue) {
                // If the immediate broadcast was triggered, we assume it's just text
                await sendBroadcast(cachedData.broadcast_queue, false);
            }
            checkSchedules();
        }
    } catch (e) {
        console.error("Error reading from Pantry cloud database:", e);
    }
}

async function saveToDatabase() {
    try {
        await fetch(PANTRY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cachedData)
        });
    } catch (e) { 
        console.error("Error saving to Pantry cloud database:", e); 
    }
}

function getAdminGroupIds() {
    return cachedData.groups.filter(g => g.is_admin === true).map(g => g.id);
}

// --- 3. BROADCASTING & SCHEDULING ---

// NEW: Supports attaching the survey button if includeSurvey is true
async function sendBroadcast(message, includeSurvey = false) {
    console.log("Sending Broadcast:", message);
    
    let options = {};
    if (includeSurvey) {
        const botUser = await bot.getMe();
        const botLink = `https://t.me/${botUser.username}?start=weekly`;
        options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📝 Take the Survey", url: botLink }]
                ]
            }
        };
    }

    for (const group of cachedData.groups) {
        if (group.is_admin) continue; 
        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`, options);
            } catch (err) {
                console.error(`Failed to send to ${group.name}:`, err.message);
            }
        }
    }
    
    cachedData.broadcast_queue = null;
    await saveToDatabase();
    console.log("Broadcast sent.");
}

async function checkSchedules() {
    const now = new Date();
    let dataChanged = false;

    // A. Dynamic Weekly Target
    const todayStr = now.toISOString().split('T')[0]; 
    const targetDay = cachedData.weekly_schedule.day;
    const targetHour = cachedData.weekly_schedule.hour;
    
    const isTargetDay = now.getDay() === targetDay;
    const isTime = now.getHours() >= targetHour;
    const alreadySent = cachedData.last_weekly_run === todayStr;

    if (isTargetDay && isTime && !alreadySent) {
        console.log("🚀 Triggering Weekly Survey!");
        const surveyText = "Hey, hope your week is going well. Please take the small survey clicking on the button below, that'd help us improve our services. Thank you";
        
        await sendBroadcast(surveyText, true);
        
        cachedData.last_weekly_run = todayStr;
        dataChanged = true;
    }

    // B. Custom Scheduled Queue
    if (cachedData.scheduled_queue && cachedData.scheduled_queue.length > 0) {
        const remainingQueue = [];
        for (const item of cachedData.scheduled_queue) {
            const scheduledTime = new Date(item.time);
            if (now >= scheduledTime) {
                // Attach the survey button if the admin checked the box!
                await sendBroadcast(item.text, item.includeSurvey);
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
    if (['group', 'supergroup'].includes(msg.chat.type)) {
        const exists = cachedData.groups.find(g => g.id === msg.chat.id);
        if (!exists) {
            cachedData.groups.push({ id: msg.chat.id, name: msg.chat.title, enabled: true, is_admin: false });
            console.log(`New Group: ${msg.chat.title}`);
            await saveToDatabase();
        }
    }
    if (msg.chat.type === 'private' && cachedData.sessions && cachedData.sessions[msg.chat.id]) {
        if (msg.text === '/start') return;
        handleAnswer(msg);
    }
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const adminIds = getAdminGroupIds();
    
    if (adminIds.includes(chatId)) return;
    
    await loadData();
    if (cachedData.questions.length === 0) return bot.sendMessage(chatId, "No questions setup.");

    let identifier = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    
    if (!cachedData.sessions) cachedData.sessions = {};
    cachedData.sessions[chatId] = { step: 0, answers: [], userInfo: identifier };
    await saveToDatabase();
    
    await bot.sendMessage(chatId, `👋 Hello, ${msg.from.first_name}!\n\nI have a few quick questions for you. Let's get started!`);
    
    askQuestion(chatId);
});

function askQuestion(chatId) {
    const session = cachedData.sessions[chatId];
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

async function handleAnswer(msg) {
    const chatId = msg.chat.id;
    const session = cachedData.sessions[chatId];
    const currentQ = cachedData.questions[session.step];
    
    if (currentQ.type === 'choice' && currentQ.options && !currentQ.options.includes(msg.text)) {
        return bot.sendMessage(chatId, "❌ Please select one of the buttons below.");
    }
    session.answers.push({ question: currentQ.text, answer: msg.text });
    session.step++;
    
    await saveToDatabase(); 
    askQuestion(chatId);
}

async function finishSurvey(chatId) {
    const session = cachedData.sessions[chatId];
    bot.sendMessage(chatId, "✅ Thank you! Your feedback has been sent.", { reply_markup: { remove_keyboard: true } });

    let report = `📝 New Feedback Received\n`;
    report += `👤 Driver: ${session.userInfo}\n`;
    report += `🆔 ID: ${chatId}\n\n`;
    
    session.answers.forEach(a => report += `Q: ${a.question}\n${a.answer}\n\n`);
    
    const adminIds = getAdminGroupIds();
    if (adminIds.length === 0) {
        console.log("Warning: No Admin groups are set up to receive this report!");
    } else {
        for (const adminId of adminIds) {
            try { await bot.sendMessage(adminId, report); } catch (e) {}
        }
    }

    cachedData.history.push({ date: new Date().toISOString(), user: session.userInfo, answers: session.answers });
    
    delete cachedData.sessions[chatId];
    await saveToDatabase();
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
