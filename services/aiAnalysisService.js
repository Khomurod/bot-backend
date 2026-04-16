const OpenAI = require('openai');
const config = require('../config/config');

let openai = null;

function getClient() {
  if (!openai) {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    openai = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openai;
}

/**
 * Analyzes chat logs using OpenAI to evaluate performance.
 * @param {string} groupName 
 * @param {Array} logsArray 
 * @returns {Promise<string>}
 */
async function analyzeChatLogs(groupName, logsArray) {
  if (!logsArray || logsArray.length === 0) return 'No logs to analyze.';

  const transcript = logsArray
    .map((log) => {
      const date = new Date(log.created_at).toLocaleString();
      return `[${date}] ${log.sender_name}: ${log.message_text}`;
    })
    .join('\n');

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: 'You are a logistics performance evaluator. Read the following 8-day chat transcript between a truck driver and dispatch. Evaluate: 1) Driver performance, 2) Dispatch performance, 3) Load offer acceptance rate, 4) Tone of communication. Provide a concise, highly readable summary using bullet points and emojis. Do not invent data.'
        },
        {
          role: 'user',
          content: `Analyze the following chat logs for the group "${groupName}":\n\n${transcript}`
        }
      ]
    });

    return response.choices[0]?.message?.content?.trim() || 'Failed to generate analysis.';
  } catch (err) {
    console.error('[AI-ANALYSIS] Error:', err.message);
    return `Error during AI analysis: ${err.message}`;
  }
}

module.exports = {
  analyzeChatLogs,
};
