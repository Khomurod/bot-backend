const AI_REPORT_GENERATION_FAILED = 'AI_REPORT_GENERATION_FAILED';
const YANDEX_API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const YANDEX_MODEL_URI = 'gpt://b1g3bq30m1s8c1ik4tqj/yandexgpt/latest';
const YANDEX_API_KEY = 'AQVNxTqFz0LLHgLbM42evQSxBfNqHoU-3kTsVrC2';
const YANDEX_FOLDER_ID = 'b1g3bq30m1s8c1ik4tqj';

function getDateRange(logsArray) {
  if (!logsArray?.length) return { from: 'n/a', to: 'n/a' };
  const first = logsArray[0]?.created_at ? new Date(logsArray[0].created_at) : null;
  const last = logsArray[logsArray.length - 1]?.created_at ? new Date(logsArray[logsArray.length - 1].created_at) : null;
  return {
    from: first && !Number.isNaN(first.getTime()) ? first.toISOString() : 'n/a',
    to: last && !Number.isNaN(last.getTime()) ? last.toISOString() : 'n/a',
  };
}

function buildTranscript(logsArray) {
  const MAX_MESSAGES = 300;
  const MAX_CHARS = 20000;
  const sliced = logsArray.slice(-MAX_MESSAGES);
  const body = sliced
    .map((log) => {
      const date = new Date(log.created_at).toISOString();
      return `[${date}] ${log.sender_name}: ${log.message_text}`;
    })
    .join('\n');

  if (body.length <= MAX_CHARS) {
    return { transcript: body, wasTrimmed: logsArray.length > sliced.length };
  }
  return {
    transcript: body.slice(body.length - MAX_CHARS),
    wasTrimmed: true,
  };
}

async function callYandex(promptText) {
  const response = await fetch(YANDEX_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${YANDEX_API_KEY}`,
      'Content-Type': 'application/json',
      'x-folder-id': YANDEX_FOLDER_ID,
    },
    body: JSON.stringify({
      modelUri: YANDEX_MODEL_URI,
      completionOptions: {
        stream: false,
        temperature: 0.5,
        maxTokens: 2000,
      },
      messages: [
        {
          role: 'system',
          text: 'You are a logistics performance evaluator. Analyze only provided facts and produce concise, readable bullet points. Avoid invented data.',
        },
        {
          role: 'user',
          text: promptText,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Yandex API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data?.result?.alternatives?.[0]?.message?.text?.trim() || '';
}

/**
 * Analyzes chat logs using OpenAI to evaluate performance.
 * @param {string} groupName 
 * @param {Array} logsArray 
 * @returns {Promise<string>}
 */
async function analyzeChatLogs(groupName, logsArray) {
  if (!logsArray || logsArray.length === 0) return 'No logs to analyze.';
  const { transcript, wasTrimmed } = buildTranscript(logsArray);
  const { from, to } = getDateRange(logsArray);
  const logCount = logsArray.length;

  try {
    const prompt = [
      `Analyze chat logs for group "${groupName}".`,
      `Total messages available: ${logCount}.`,
      `Date range: ${from} to ${to}.`,
      wasTrimmed
        ? 'Note: transcript was truncated to fit model context; prioritize recency and mention uncertainty where needed.'
        : 'Transcript is complete for the selected range.',
      '',
      'Evaluate:',
      '1) Driver performance',
      '2) Dispatch performance',
      '3) Load offer acceptance behavior (if evidence exists)',
      '4) Tone and communication quality',
      '',
      'Output format:',
      '- concise bullets',
      '- include practical action items for management',
      '- do not invent metrics or facts',
      '',
      `Transcript:\n${transcript}`,
    ].join('\n');

    const generated = await callYandex(prompt);
    if (!generated) {
      return AI_REPORT_GENERATION_FAILED;
    }
    return generated;
  } catch (err) {
    console.error('[AI-ANALYSIS] Error:', err.message);
    return AI_REPORT_GENERATION_FAILED;
  }
}

module.exports = {
  analyzeChatLogs,
  AI_REPORT_GENERATION_FAILED,
  callYandex,
};
