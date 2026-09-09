/**
 * The twice-weekly check: has any provider changed the deal?
 *
 * The pipeline, and the order is the whole cost model:
 *
 *   conditional GET → 304? done, free
 *     → normalise → hash → unchanged? done, no diff
 *       → line diff → not material? recorded, no alert, NO MODEL
 *         → one model call on the changed passages alone
 *           → deterministic suspension check (never the model's opinion)
 *             → finding → outbox → Telegram
 *
 * Everything before the model is string handling, and each stage can end the
 * check. That is why this can run against every provider twice a week without
 * becoming an AI workload.
 *
 * A SUSPENSION IS A COOLDOWN WITH A REASON. It writes `cooled_until` through
 * `aiProviders.recordFailure`, exactly like a rejected key does; it never
 * writes `enabled = false`. The operator's configuration is theirs, and one
 * click in the admin puts the provider back.
 */
const defaultDb = require('../../../database/pool');
const policyStore = require('../../../database/aiPolicy');
const findingsStore = require('../../../database/aiPolicyFindings');
const aiProviders = require('../../../database/aiProviders');
const aiSettings = require('../../../database/aiSettings');
const { comparePolicyText } = require('../../../lib/ai/policyDiff');
const { evaluateSuspension } = require('../../../lib/ai/policySuspension');
const { fetchPolicyPage } = require('./fetchPolicy');
const { readChange } = require('./readChange');
const { buildAlertBody } = require('./alertMessage');

function sha256(text) {
  // Required lazily so this module still loads in environments without crypto
  // configured — the watcher is optional, and nothing else should break.
  return require('node:crypto').createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Check one source. Returns what happened, for the run summary.
 *
 * @returns {'not_modified'|'unchanged'|'baseline'|'immaterial'|'finding'|'error'}
 */
async function checkSource(source, {
  settings, freeOnlyMode, fetchImpl, readImpl, now = new Date(),
}) {
  const fetched = await fetchPolicyPage({
    url: source.url,
    etag: source.etag,
    lastModified: source.lastModified,
    fetchImpl,
  });

  if (fetched.error) {
    // Not a finding. A page that is briefly unreachable says nothing about the
    // terms, and alerting on it would teach an operator to ignore the ones
    // that matter.
    await policyStore.saveSnapshot(source.id, {
      httpStatus: fetched.status, error: fetched.error,
      etag: fetched.etag, lastModified: fetched.lastModified,
    });
    return 'error';
  }

  if (fetched.notModified) {
    await policyStore.saveSnapshot(source.id, {
      httpStatus: 304, etag: fetched.etag, lastModified: fetched.lastModified,
    });
    return 'not_modified';
  }

  const hash = sha256(fetched.text);
  if (source.contentHash && hash === source.contentHash) {
    // The provider does not send ETags, but the text is identical anyway.
    await policyStore.saveSnapshot(source.id, {
      httpStatus: fetched.status, contentHash: hash,
      etag: fetched.etag, lastModified: fetched.lastModified,
    });
    return 'unchanged';
  }

  const verdict = comparePolicyText(source.normalisedText || '', fetched.text);

  // Store the new text first, whatever we decide about it: the next run must
  // diff against what is actually published now, or a change that was judged
  // immaterial would be re-reported forever.
  await policyStore.saveSnapshot(source.id, {
    httpStatus: fetched.status, contentHash: hash, normalisedText: fetched.text,
    etag: fetched.etag, lastModified: fetched.lastModified,
  });

  if (!verdict.changed) return source.normalisedText ? 'unchanged' : 'baseline';
  if (!verdict.material) return 'immaterial';

  // ── only now does a model see anything ──
  const reading = await readChange({
    passages: verdict.passages,
    topics: verdict.topics,
    providerKey: source.providerKey,
    reason: verdict.reason,
    ...(readImpl ? { run: readImpl } : {}),
  });

  // ── and the suspension decision never sees the model's output ──
  const suspension = evaluateSuspension({
    topics: verdict.topics,
    passages: verdict.passages,
    freeOnlyMode,
    autoSuspendEnabled: settings.autoSuspendEnabled === true,
  });

  const finding = await findingsStore.insertFinding({
    sourceId: source.id,
    providerKey: source.providerKey,
    sourceUrl: source.url,
    category: reading.category,
    // A matched suspension rule is serious by rule, whatever a model thought.
    severity: suspension.rule ? suspension.severity : reading.severity,
    summary: reading.summary,
    whatChanged: reading.whatChanged,
    whyItMatters: reading.whyItMatters,
    quotedPassage: verdict.passages.slice(0, 4000),
    detectedTopics: verdict.topics,
    changedChars: verdict.changedChars,
    suspendedProvider: suspension.suspend,
    suspensionRule: suspension.suspend ? suspension.rule : null,
    aiAssisted: reading.aiAssisted,
    aiModel: reading.aiModel,
  });

  if (suspension.suspend) {
    await aiProviders.recordFailure(source.providerKey, {
      message: `Policy: ${suspension.label}`,
      cooldown: {
        until: 'indefinite',
        reason: `${suspension.reason} Quoted: “${(suspension.matched || '').slice(0, 160)}”. `
          + 'Clear this once you have reviewed the provider\'s terms.',
      },
    });
  }

  if (settings.notifyEnabled && settings.notifyChatId
      && findingsStore.meetsSeverityThreshold(finding.severity, settings.notifyMinSeverity)) {
    await findingsStore.enqueueAlert({
      findingId: finding.id,
      chatId: settings.notifyChatId,
      body: buildAlertBody(finding, { suspension, now }),
    });
  }

  return 'finding';
}

/**
 * One pass over every source of every enabled provider.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]  injectable for tests — no network
 * @param {Function} [options.readImpl]   injectable for tests — no model
 */
async function runPolicyCheck({ fetchImpl, readImpl, db = defaultDb } = {}) {
  const settings = await policyStore.getWatcherSettings();
  if (!settings.enabled) {
    return { skipped: true, reason: 'The policy watcher is switched off.' };
  }

  const [sources, ai] = await Promise.all([
    policyStore.listSourcesToCheck(),
    aiSettings.getAiSettings(),
  ]);

  const summary = {
    sources: sources.length,
    notModified: 0, unchanged: 0, baseline: 0, immaterial: 0, findings: 0, errors: 0,
  };
  const bucket = {
    not_modified: 'notModified', unchanged: 'unchanged', baseline: 'baseline',
    immaterial: 'immaterial', finding: 'findings', error: 'errors',
  };

  for (const source of sources) {
    try {
      const outcome = await checkSource(source, {
        settings, freeOnlyMode: ai.freeOnlyMode, fetchImpl, readImpl,
      });
      summary[bucket[outcome]] += 1;
    } catch (err) {
      // One bad source must not cost the rest of the run.
      summary.errors += 1;
      console.error(`[POLICY] ${source.providerKey} ${source.url} failed:`, err.message);
      await policyStore.saveSnapshot(source.id, { error: err.message }).catch(() => {});
    }
  }

  await policyStore.recordRun(summary);
  if (summary.findings || summary.errors) {
    console.log(`[POLICY] ${summary.findings} finding(s), ${summary.errors} error(s) `
      + `across ${summary.sources} source(s).`);
  }
  return summary;
}

module.exports = { runPolicyCheck, checkSource, sha256 };
