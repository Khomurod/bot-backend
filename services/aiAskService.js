// services/aiAskService.js
//
// "Ask the Data" — natural-language questions over the v_annotated_messages view.
//
// Flow:
//   1. User asks a question (plain English/Russian/Uzbek).
//   2. Groq returns a strict JSON *query plan* — never raw SQL.
//   3. We compile the plan into a single parameterized SELECT on
//      v_annotated_messages with a whitelist of fields and operators.
//   4. We run the query (LIMIT 200 hard cap).
//   5. Groq produces a short narrative answer using only the
//      resulting rows + cited t.me links.
//
// Nothing here constructs SQL from model free-text. Plans that violate
// the whitelist are rejected with a structured error.

const db = require('../database/db');
const { callGroqWithFallback, INTERACTIVE_MAX_RETRY_WAIT_MS } = require('./groqClient');

const ALLOWED_FIELDS = new Set([
  'sender_name',
  'group_name',
  'telegram_group_id',
  'telegram_user_id',
  'role',
  'intent',
  'sentiment',
  'urgency',
  'is_acknowledgement',
  'toxic',
  'language',
  'created_at',
  'message_text',
]);

const GROUPABLE_FIELDS = new Set([
  'sender_name',
  'group_name',
  'role',
  'intent',
  'language',
]);

const ALLOWED_OPS = new Set(['=', '!=', '>', '>=', '<', '<=', 'in', 'not_in', 'like', 'ilike', 'is_null', 'is_not_null']);
const ALLOWED_AGGS = new Set(['count', 'avg', 'min', 'max']);
const ALLOWED_SORT_DIRS = new Set(['asc', 'desc']);
const HARD_LIMIT = 200;
const DEFAULT_DAYS_WINDOW = 90;

const PLAN_SYSTEM_PROMPT = [
  'You convert a user question into a strict JSON query plan over a single view called v_annotated_messages.',
  'Fields allowed (all nullable):',
  '  sender_name (TEXT), group_name (TEXT), telegram_group_id (BIGINT), telegram_user_id (BIGINT),',
  '  role (TEXT: driver|dispatcher|admin|unknown), intent (TEXT: status_update|home_time_request|complaint|question|acknowledgement|quit_signal|breakdown|accident|eta|location|document|social|offtopic|praise|conflict|no_signal),',
  '  sentiment (INT -2..2), urgency (INT 0..3), is_acknowledgement (BOOL), toxic (BOOL),',
  '  language (TEXT en|ru|uz|other), created_at (TIMESTAMP), message_text (TEXT).',
  '',
  'Return ONE JSON object, no prose, no fences, with keys:',
  '  filters   : array of {field, op, value}. op is one of = != > >= < <= in not_in like ilike is_null is_not_null.',
  '  group_by  : optional array of fields from {sender_name, group_name, role, intent, language}.',
  '  aggregate : optional {fn: count|avg|min|max, field: one allowed field or "*"}. Default is count(*) when group_by is present.',
  '  order_by  : optional array of {field, dir: asc|desc}. For aggregates, field may be "value".',
  '  limit     : optional integer 1..200.',
  '  days_back : integer 1..365. Defaults to 90 when the user does not specify.',
  '  intent    : short natural-language description of what this plan will return (for narrative).',
  '',
  'Rules:',
  '- If the question is vague, default to the most informative plan (counts by sender_name or intent).',
  '- Never invent fields or operators.',
  '- For "home time", filter intent in ["home_time_request"]. For "complaints", intent in ["complaint"]. For "quit", intent in ["quit_signal"]. For "drivers", role = "driver".',
  '- For "this week" use days_back=7. "this month" => 30. "last 30 days" => 30.',
  '- Never return SQL. Never return code fences.',
].join('\n');

function stripFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parsePlan(text) {
  const cleaned = stripFences(text);
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) { /* fall through */ }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_) { /* noop */ }
  }
  return null;
}

function assertField(field) {
  if (!ALLOWED_FIELDS.has(String(field))) {
    throw new Error(`Field not allowed: ${field}`);
  }
}

function assertOp(op) {
  const o = String(op).toLowerCase();
  if (!ALLOWED_OPS.has(o)) throw new Error(`Operator not allowed: ${op}`);
  return o;
}

/**
 * Compile a plan into { sql, params, plan }.
 * Throws on invalid plans. Pure function — safe to test.
 */
function compilePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('Invalid plan');

  const params = [];
  const where = [];

  // Time window — always enforced to avoid unbounded scans.
  const daysBack = Number.isFinite(Number(plan.days_back))
    ? Math.min(365, Math.max(1, Math.round(Number(plan.days_back))))
    : DEFAULT_DAYS_WINDOW;
  params.push(daysBack);
  where.push(`created_at >= NOW() - make_interval(days => $${params.length})`);

  // Filters
  const filters = Array.isArray(plan.filters) ? plan.filters : [];
  for (const f of filters) {
    if (!f || typeof f !== 'object') continue;
    assertField(f.field);
    // created_at is already handled by the days_back window above.
    // The model often hallucinates SQL expressions (e.g. "now() - interval '30 days'")
    // as filter values, which PostgreSQL rejects as invalid timestamps.
    if (String(f.field) === 'created_at') continue;
    const op = assertOp(f.op);
    const field = String(f.field);
    if (op === 'is_null') { where.push(`${field} IS NULL`); continue; }
    if (op === 'is_not_null') { where.push(`${field} IS NOT NULL`); continue; }
    if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(f.value) || !f.value.length) continue;
      const placeholders = f.value.map((v) => { params.push(v); return `$${params.length}`; });
      where.push(`${field} ${op === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`);
      continue;
    }
    if (op === 'like' || op === 'ilike') {
      params.push(String(f.value).slice(0, 200));
      where.push(`${field} ${op.toUpperCase()} $${params.length}`);
      continue;
    }
    params.push(f.value);
    where.push(`${field} ${op} $${params.length}`);
  }

  // Group by / aggregate
  const groupBy = Array.isArray(plan.group_by)
    ? plan.group_by.filter((g) => GROUPABLE_FIELDS.has(String(g)))
    : [];

  const hasAgg = plan.aggregate && typeof plan.aggregate === 'object';
  let aggFn = 'count';
  let aggField = '*';
  if (hasAgg) {
    const fn = String(plan.aggregate.fn || 'count').toLowerCase();
    if (!ALLOWED_AGGS.has(fn)) throw new Error(`Aggregate fn not allowed: ${fn}`);
    aggFn = fn;
    if (plan.aggregate.field && plan.aggregate.field !== '*') {
      assertField(plan.aggregate.field);
      aggField = String(plan.aggregate.field);
    }
  }

  let selectClause;
  if (groupBy.length || hasAgg) {
    const groupCols = groupBy.length ? groupBy.join(', ') : null;
    const aggExpr = aggFn === 'count'
      ? (aggField === '*' ? 'COUNT(*)::INT' : `COUNT(${aggField})::INT`)
      : `${aggFn.toUpperCase()}(${aggField})`;
    selectClause = groupCols ? `${groupCols}, ${aggExpr} AS value` : `${aggExpr} AS value`;
  } else {
    selectClause = 'chat_log_id, telegram_group_id, telegram_message_id, created_at, group_name, sender_name, role, intent, sentiment, urgency, is_acknowledgement, toxic, language, message_text';
  }

  // Order by
  let orderClause = '';
  if (Array.isArray(plan.order_by) && plan.order_by.length) {
    const parts = [];
    for (const o of plan.order_by) {
      if (!o || !o.field) continue;
      const dir = ALLOWED_SORT_DIRS.has(String(o.dir || 'desc').toLowerCase())
        ? String(o.dir || 'desc').toLowerCase().toUpperCase()
        : 'DESC';
      if (o.field === 'value' && (groupBy.length || hasAgg)) {
        parts.push(`value ${dir}`);
      } else {
        assertField(o.field);
        parts.push(`${o.field} ${dir}`);
      }
    }
    if (parts.length) orderClause = `ORDER BY ${parts.join(', ')}`;
  } else if (groupBy.length || hasAgg) {
    orderClause = 'ORDER BY value DESC';
  } else {
    orderClause = 'ORDER BY created_at DESC';
  }

  const limit = Math.min(
    HARD_LIMIT,
    Math.max(1, Number.isFinite(Number(plan.limit)) ? Math.round(Number(plan.limit)) : HARD_LIMIT)
  );
  params.push(limit);

  const groupClause = groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : '';
  const sql = `
    SELECT ${selectClause}
      FROM v_annotated_messages
     WHERE ${where.join(' AND ')}
     ${groupClause}
     ${orderClause}
     LIMIT $${params.length}
  `;

  return { sql, params, plan: { ...plan, days_back: daysBack, limit } };
}

const ANSWER_SYSTEM_PROMPT = [
  'You answer the user briefly given a structured query result.',
  'You receive: original question, query plan, and up to 50 result rows.',
  'Write 2-4 short sentences in plain HTML (<b>, <i>, <br>).',
  'Cite at most 5 specific Telegram message links from rows that have telegram_group_id + telegram_message_id (build https://t.me/c/<abs(telegram_group_id)-1000000000000>/<telegram_message_id>).',
  'Never invent numbers, drivers, or links. If rows are empty, say so.',
  'Output JSON only with key "html".',
].join('\n');

function buildMessageLink(row) {
  if (!row.telegram_group_id || !row.telegram_message_id) return null;
  const tgid = Number(row.telegram_group_id);
  if (!Number.isFinite(tgid)) return null;
  const abs = Math.abs(tgid);
  const stripped = abs > 1000000000000 ? abs - 1000000000000 : abs;
  return `https://t.me/c/${stripped}/${row.telegram_message_id}`;
}

function parseAnswer(text) {
  const cleaned = stripFences(text);
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.html === 'string') return obj.html.slice(0, 4000);
  } catch (_) { /* noop */ }
  return cleaned.slice(0, 2000);
}

async function askData(question) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Empty question');
  if (q.length > 500) throw new Error('Question too long (max 500 chars)');

  // 1. Plan
  const { text: planText } = await callGroqWithFallback(`Question: ${q}`, {
    systemText: PLAN_SYSTEM_PROMPT,
    temperature: 0.1,
    maxTokens: 700,
    maxRetryWaitMs: INTERACTIVE_MAX_RETRY_WAIT_MS,
  });
  const rawPlan = parsePlan(planText);
  if (!rawPlan) {
    throw new Error(`Model did not return a valid plan. Raw: ${planText.slice(0, 200)}`);
  }

  // 2. Compile
  const compiled = compilePlan(rawPlan);

  // 3. Execute
  const { rows } = await db.query(compiled.sql, compiled.params);

  // 4. Narrate (keep context small: up to 50 rows with only essential cols)
  const rowsForModel = rows.slice(0, 50).map((r) => {
    const link = buildMessageLink(r);
    const base = { ...r };
    if (link) base.link = link;
    if (typeof base.message_text === 'string') base.message_text = base.message_text.slice(0, 240);
    return base;
  });

  const { text: answerText } = await callGroqWithFallback(
    JSON.stringify({
      question: q,
      plan: compiled.plan,
      row_count: rows.length,
      rows: rowsForModel,
    }),
    {
      systemText: ANSWER_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 800,
      maxRetryWaitMs: INTERACTIVE_MAX_RETRY_WAIT_MS,
    }
  );
  const html = parseAnswer(answerText);

  return {
    question: q,
    plan: compiled.plan,
    sql: compiled.sql.replace(/\s+/g, ' ').trim(),
    row_count: rows.length,
    rows,
    answer_html: html,
  };
}

module.exports = {
  askData,
  compilePlan,
  parsePlan,
  buildMessageLink,
  ALLOWED_FIELDS,
  ALLOWED_OPS,
  HARD_LIMIT,
};
