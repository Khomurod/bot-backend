const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// 1. CONFIGURATION
const TOKEN = '8245365754:AAHqhtzDzyE-NWdYpBmff_L-mGq1SprnuWo'; 
const PANTRY_ID = '42f7bc17-4c7d-4314-9a0d-19f876d39db6'; 
const PANTRY_URL = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/driver_data`;

const bot = new TelegramBot(TOKEN, { polling: true });

// Store session data: { chatId: { step: 0, answers: [] } }
const userSessions = {};
let cachedData = { questions: [], groups: [] };

// 2. LOAD DATA FROM PANTRY
async function loadData() {
    try {
        const res = await fetch(PANTRY_URL);
        if (res.ok) {
            cachedData = await res.json();
            // Handle empty data cases
            if (!cachedData.questions) cachedData.questions = [];
            if (!cachedData.groups) cachedData.groups = [];
            
            console.log(`Loaded ${cachedData.questions.length} questions and ${cachedData.groups.length} groups.`);
            
            // CHECK FOR BROADCASTS
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
    
    // Send to all enabled groups
    for (const group of cachedData.groups) {
        if (group.enabled) {
            try {
                await bot.sendMessage(group.id, `📢 ANNOUNCEMENT:\n\n${message}`);
            } catch (err) {
                console.error(`Failed to send to group ${group.name}:`, err.message);
            }
        }
    }

    // Clear queue in Pantry
    cachedData.broadcast_queue = null;
    await fetch(PANTRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cachedData)
    });
}

// 4. GROUP REGISTRATION (Automatic)
bot.on('message', async (msg) => {
    // If message is from a group, save the group ID
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const groupId = msg.chat.id;
        const groupName = msg.chat.title;

        const exists = cachedData.groups.find(g => g.id === groupId);
        if (!exists) {
            cachedData.groups.push({ id: groupId, name: groupName, enabled: true });
            console.log(`New Group Registered: ${groupName}`);
            
            // Save to Pantry
            await fetch(PANTRY_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cachedData)
            });
        }
    }
});

// 5. INTERACTION LOGIC (/start)
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    // Refresh data to make sure we have latest questions
    loadData().then(() => {
        if (cachedData.questions.length === 0) {
            return bot.sendMessage(chatId, "No questions are currently set up by the admin.");
        }

        // Start session
        userSessions[chatId] = { step: 0, answers: [] };
        askQuestion(chatId);
    });
});

function askQuestion(chatId) {
    const session = userSessions[chatId];
    const question = cachedData.questions[session.step];

    if (!question) {
        // End of survey
        finishSurvey(chatId);
        return;
    }

    // Prepare options if it's multiple choice
    let options = {};
    if (question.type === 'choice' && question.options && question.options.length > 0) {
        options = {
            reply_markup: {
                keyboard: question.options.map(o => ([o])), // Rows of buttons
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
    if (msg.text === '/start') return; // Ignore start command
    if (msg.chat.type !== 'private') return; // Ignore groups for feedback
    
    const session = userSessions[chatId];
    if (!session) return; // No active survey

    // Save answer
    const currentQ = cachedData.questions[session.step];
    session.answers.push({
        question: currentQ.text,
        answer: msg.text
    });

    // Move to next
    session.step++;
    askQuestion(chatId);
});

async function finishSurvey(chatId) {
    const session = userSessions[chatId];
    bot.sendMessage(chatId, "Thank you! Your feedback has been sent to the admins. ✅", { reply_markup: { remove_keyboard: true } });

    // Format the report
    let report = `📝 <b>New Feedback Received</b>\n`;
    report += `From: ${chatId}\n\n`;
    session.answers.forEach(a => {
        report += `<b>Q: ${a.question}</b>\n${a.answer}\n\n`;
    });

    // Send to all enabled Admin Groups
    cachedData.groups.forEach(g => {
        if (g.enabled) {
            bot.sendMessage(g.id, report, { parse_mode: "HTML" });
        }
    });

    // Clear session
    delete userSessions[chatId];
}

// Initial Load
loadData();
console.log("Bot is running...");