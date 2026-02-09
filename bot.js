require('dotenv').config(); // If you are using .env, otherwise this is ignored

const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// CONFIGURATION
const TOKEN = '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 
const PANTRY_ID = '42f7bc17-4c7d-4314-9a0d-19f876d39db6'; 
const PANTRY_URL = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/driver_data`;

const bot = new TelegramBot(TOKEN, { polling: true });

const userSessions = {};
let cachedData = { questions: [], groups: [] };

// LOAD DATA
async function loadData() {
    try {
        constTv res = await fetch(PANTRY_URL);
        if (res.ok) {
            cachedData = await res.json();
            if (!cachedData.questions) cachedData.questions = [];
            if (!cachedData.groups) cachedData.groups = [];
            
            // CHECK FOR BROADCASTS
            if (cachedData.broadcast_queue) {
                sendBroadcast(cachedData.broadcast_queue);
            }
        }
    } catch (e) {
        console.error("Error fetching from Pantry:", e);
    }
}

// BROADCAST LOGIC (Sends ONLY to Drivers)
async function sendBroadcast(message) {
    console.log("Starting broadcast...");
    
    for (const group of cachedData.groups) {
        // Send to Enabled groups that are NOT admins (Drivers only)
        if (group.enabled && !group.is_admin) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to group ${group.name}:`, err.message);
            }
        }
    }

    cachedData.broadcast_queue = null;
    await fetch(PANTRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cachedData)
    });
}

// GROUP REGISTRATION
bot.on('message', async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const groupId = msg.chat.id;
        const groupName = msg.chat.title;

        const exists = cachedData.groups.find(g => g.id === groupId);
        if (!exists) {
            // New groups default to DRIVER (is_admin: false)
            cachedData.groups.push({ id: groupId, name: groupName, enabled: true, is_admin: false });
            console.log(`New Group Registered: ${groupName}`);
            
            await fetch(PANTRY_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cachedData)
            });
        }
    }
});

// START SURVEY
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    loadData().then(() => {
        if (cachedData.questions.length === 0) {
            return bot.sendMessage(chatId, "No questions are currently set up by the admin.");
        }
        userSessions[chatId] = { step: 0, answers: [] };
        askQuestion(chatId);
    });
});

function askQuestion(chatId) {
    const session = userSessions[chatId];
    const question = cachedData.questions[session.step];

    if (!question) {
        finishSurvey(chatId);
        return;
    }

    let options = {};
    if (question.type === 'choice' && question.options && question.options.length > 0) {
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

    bot.sendMessage(chatId, `Question ${session.step + 1}:\n${question.text}`, options);
}

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text === '/start') return;
    if (msg.chat.type !== 'private') return;
    
    const session = userSessions[chatId];
    if (!session) return;

    const currentQ = cachedData.questions[session.step];
    session.answers.push({
        question: currentQ.text,
        answer: msg.text
    });

    session.step++;
    askQuestion(chatId);
});

async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    bot.sendMessage(chatId, "Thank you! Your feedback has been sent to the admins. ✅", { reply_markup: { remove_keyboard: true } });

    let report = `📝 <b>New Feedback Received</b>\n`;
    report += `From: ${chatId}\n\n`;
    session.answers.forEach(a => {
        report += `<b>Q: ${a.question}</b>\n${a.answer}\n\n`;
    });

    // Send ONLY to Admin Groups
    cachedData.groups.forEach(g => {
        if (g.enabled && g.is_admin) {
            bot.sendMessage(g.id, report, { parse_mode: "HTML" });
        }
    });

    delete userSessions[chatId];
}

loadData();
console.log("Bot is running...");