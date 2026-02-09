require('dotenv').config(); 

const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// 1. CONFIGURATION
const TOKEN = '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 
const PANTRY_ID = '42f7bc17-4c7d-4314-9a0d-19f876d39db6'; 
const PANTRY_URL = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/driver_data`;

// 🔒 HARDCODED ADMIN ID (Your Group)
const ADMIN_GROUP_ID = -5275569828; 

const bot = new TelegramBot(TOKEN, { polling: true });

const userSessions = {};
let cachedData = { questions: [], groups: [] };

// 2. LOAD DATA
async function loadData() {
    try {
        const res = await fetch(PANTRY_URL);
        if (res.ok) {
            cachedData = await res.json();
            if (!cachedData.questions) cachedData.questions = [];
            if (!cachedData.groups) cachedData.groups = [];
            
            // Check for pending broadcasts
            if (cachedData.broadcast_queue) {
                sendBroadcast(cachedData.broadcast_queue);
            }
        }
    } catch (e) {
        console.error("Error fetching from Pantry:", e);
    }
}

// 3. BROADCAST LOGIC (Sends ONLY to Drivers)
async function sendBroadcast(message) {
    console.log("Starting broadcast...");
    
    for (const group of cachedData.groups) {
        // SKIP the Admin Group (Don't spam yourself)
        if (group.id === ADMIN_GROUP_ID) continue;

        // Send to Enabled groups
        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to group ${group.name}:`, err.message);
            }
        }
    }

    // Clear queue
    cachedData.broadcast_queue = null;
    await fetch(PANTRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cachedData)
    });
}

// 4. GROUP REGISTRATION
bot.on('message', async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const groupId = msg.chat.id;
        const groupName = msg.chat.title;

        // Check if group is already saved
        const exists = cachedData.groups.find(g => g.id === groupId);
        
        if (!exists) {
            // Register new group
            cachedData.groups.push({ id: groupId, name: groupName, enabled: true });
            console.log(`New Group Registered: ${groupName} (ID: ${groupId})`);
            
            // Save to Pantry
            await fetch(PANTRY_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cachedData)
            });
        }
    }
});

// 5. START SURVEY
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    // Ignore commands inside the Admin Group (so you don't trigger the bot while chatting)
    if (chatId === ADMIN_GROUP_ID) return;

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

// HANDLE ANSWERS
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text === '/start') return;
    if (msg.chat.type !== 'private') return; // Only accept feedback in private chat
    
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

// 6. FINISH SURVEY & REPORT TO ADMIN
async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    bot.sendMessage(chatId, "Thank you! Your feedback has been sent to the admins. ✅", { reply_markup: { remove_keyboard: true } });

    // Format the report
    let report = `📝 <b>New Feedback Received</b>\n`;
    report += `From: User ID ${chatId}\n\n`;
    session.answers.forEach(a => {
        report += `<b>Q: ${a.question}</b>\n${a.answer}\n\n`;
    });

    // 🚀 SEND DIRECTLY TO YOUR HARDCODED ADMIN GROUP
    try {
        await bot.sendMessage(ADMIN_GROUP_ID, report, { parse_mode: "HTML" });
        console.log("Report sent to Admin Group");
    } catch (e) {
        console.error("FAILED to send report to Admin Group. Check ID!", e);
    }

    delete userSessions[chatId];
}

loadData();
console.log(`Bot is running... Admin Group ID set to: ${ADMIN_GROUP_ID}`);