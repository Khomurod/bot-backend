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
// Added 'history' to our cache
let cachedData = { questions: [], groups: [], history: [] };

// 2. LOAD DATA
async function loadData() {
    try {
        const res = await fetch(PANTRY_URL);
        if (res.ok) {
            cachedData = await res.json();
            // Ensure all arrays exist
            if (!cachedData.questions) cachedData.questions = [];
            if (!cachedData.groups) cachedData.groups = [];
            if (!cachedData.history) cachedData.history = []; // New History Array
            
            // Check for pending broadcasts
            if (cachedData.broadcast_queue) {
                sendBroadcast(cachedData.broadcast_queue);
            }
        }
    } catch (e) {
        console.error("Error fetching from Pantry:", e);
    }
}

// 3. BROADCAST LOGIC
async function sendBroadcast(message) {
    console.log("Starting broadcast:", message);
    
    for (const group of cachedData.groups) {
        if (group.id === ADMIN_GROUP_ID) continue; // Skip Admin

        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to group ${group.name}:`, err.message);
            }
        }
    }

    cachedData.broadcast_queue = null;
    await saveToPantry();
}

// Helper to save data safely
async function saveToPantry() {
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
        const exists = cachedData.groups.find(g => g.id === groupId);
        
        if (!exists) {
            cachedData.groups.push({ id: groupId, name: groupName, enabled: true });
            console.log(`New Group Registered: ${groupName} (ID: ${groupId})`);
            await saveToPantry();
        }
    }
});

// 5. START SURVEY (With Welcome Message & Username Logic)
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Ignore commands inside the Admin Group
    if (chatId === ADMIN_GROUP_ID) return;

    // Refresh data
    await loadData();

    if (cachedData.questions.length === 0) {
        return bot.sendMessage(chatId, "No questions are currently set up by the admin.");
    }

    // 👤 GET USERNAME
    // If they have a @username, use it. Otherwise use First Name + Last Name
    let identifier = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name} ${msg.from.last_name || ''}`;
    identifier = identifier.trim();

    // Start session with userInfo
    userSessions[chatId] = { 
        step: 0, 
        answers: [], 
        userInfo: identifier 
    };

    // 👋 WELCOME MESSAGE
    await bot.sendMessage(chatId, `👋 <b>Hello, ${msg.from.first_name}!</b>\n\nI have a few quick questions for you. Let's get started!`, { parse_mode: "HTML" });

    askQuestion(chatId);
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

    bot.sendMessage(chatId, `📝 <b>Question ${session.step + 1}:</b>\n${question.text}`, { parse_mode: "HTML", ...options });
}

// HANDLE ANSWERS (With Validation)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text === '/start') return;
    if (msg.chat.type !== 'private') return;
    
    const session = userSessions[chatId];
    if (!session) return;

    const currentQ = cachedData.questions[session.step];

    // 🛡️ INPUT VALIDATION
    // If it is a Multiple Choice question, user MUST pick a valid option.
    if (currentQ.type === 'choice' && currentQ.options) {
        if (!currentQ.options.includes(msg.text)) {
            return bot.sendMessage(chatId, "❌ <b>Please select one of the buttons below.</b>", { parse_mode: "HTML" });
        }
    }

    // Save answer
    session.answers.push({
        question: currentQ.text,
        answer: msg.text
    });

    session.step++;
    askQuestion(chatId);
});

// 6. FINISH SURVEY (Save History & Report Username)
async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    
    bot.sendMessage(chatId, "✅ <b>Thank you!</b> Your feedback has been sent.", { parse_mode: "HTML", reply_markup: { remove_keyboard: true } });

    // Format the report for Admin
    let report = `📝 <b>New Feedback Received</b>\n`;
    report += `👤 <b>Driver:</b> ${session.userInfo}\n`; // Shows Username now!
    report += `🆔 <b>ID:</b> ${chatId}\n\n`;
    
    session.answers.forEach(a => {
        report += `<b>Q: ${a.question}</b>\n${a.answer}\n\n`;
    });

    // Send to Admin Group
    try {
        await bot.sendMessage(ADMIN_GROUP_ID, report, { parse_mode: "HTML" });
    } catch (e) {
        console.error("FAILED to send report to Admin Group.", e);
    }

    // 💾 SAVE TO HISTORY
    const historyItem = {
        date: new Date().toISOString(),
        user: session.userInfo,
        userId: chatId,
        answers: session.answers
    };
    
    cachedData.history.push(historyItem);
    await saveToPantry();

    delete userSessions[chatId];
}

// 7. HEARTBEAT
setInterval(() => {
    loadData();
}, 60000); 

// Initial Load
loadData();
console.log(`Bot is running... Admin Group ID set to: ${ADMIN_GROUP_ID}`);
