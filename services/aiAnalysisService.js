const AI_REPORT_GENERATION_FAILED = 'AI_REPORT_GENERATION_FAILED';
const YANDEX_API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const YANDEX_MODEL_URI = 'gpt://b1g3bq30m1s8c1ik4tqj/yandexgpt/latest';
const YANDEX_API_KEY = 'AQVNxTqFz0LLHgLbM42evQSxBfNqHoU-3kTsVrC2';
const YANDEX_FOLDER_ID = 'b1g3bq30m1s8c1ik4tqj';
const REPORT_DELIMITER = '|||';

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
          text: [
            'You are a strict logistics auditor for a trucking company.',
            'Analyze only provided evidence from driver-updater chats.',
            'You must identify operational, compliance, and communication red flags.',
            `Return EXACTLY two sections separated by "${REPORT_DELIMITER}" and nothing else.`,
            'Section 1: 2-3 sentence overall summary for management.',
            'Section 2: driver-by-driver breakdown, each line must mention red flags or say "Clear".',
            'Do not invent facts, percentages, or events not present in transcript.',
          ].join(' '),
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
      '1) Driver-updater interaction quality',
      '2) Communication consistency and responsiveness',
      '3) Dispatch/load handling behavior (if evidence exists)',
      '4) Operational red flags (delays, non-responsiveness, conflict, risky behavior)',
      '',
      `Output rules (MANDATORY):`,
      `- Return exactly two parts separated by ${REPORT_DELIMITER}`,
      '- Part 1: Overall summary in 2-3 sentences',
      '- Part 2: Driver-by-driver breakdown, one line per driver, each line ends with either "Red Flags: <items>" or "Clear"',
      '- Do not add markdown fences, labels, or extra separators',
      '',
      `Transcript:\n${transcript}`,
    ].join('\n');

    let generated = await callYandex(prompt);
    if (generated && !generated.includes(REPORT_DELIMITER)) {
      generated = await callYandex(
        [
          `Reformat the following content into EXACTLY two sections separated by ${REPORT_DELIMITER}.`,
          'Section 1: 2-3 sentence overall summary.',
          'Section 2: driver-by-driver lines with "Red Flags: ..." or "Clear".',
          'Return only the final reformatted text.',
          '',
          generated,
        ].join('\n')
      );
    }
    if (!generated || !generated.includes(REPORT_DELIMITER)) {
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
