'use strict';

/**
 * Fixtures for the ask pass tests (`controlAskPass`, `controlOneAtATime`): one
 * finding the pass would ask about, and the dependencies it reads — stubs, no
 * database, no Telegram.
 */

function finding(over = {}) {
  return {
    id: 11, checkKey: 'identity.stale_unit_assignment', status: 'open', tier: 'auto',
    subjectType: 'group', subjectId: '49', confidence: 90, severity: 'warning',
    title: 'Truck on the profile does not match', evidence: { personId: 5 },
    firstSeenAt: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  };
}

function makeDeps(over = {}) {
  const calls = { notified: [], decisions: [] };
  return {
    calls,
    findings: { listAskCandidates: async () => [finding()] },
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 0 },
    settings: {
      getControlSettings: async () => ({
        enabled: true, maxQuestionsPerPass: 5, repeatAfterHours: 72, clarifyLimit: 1,
      }),
    },
    notify: async (n) => { calls.notified.push(n); return { recorded: true }; },
    actionForCheck: () => ({ key: 'identity.sync_unit', tier: 'auto' }),
    payloadFor: () => ({ personId: 5, unitNumber: '322' }),
    loadCheckSettings: async () => new Map([['identity.stale_unit_assignment', { mode: 'suggest' }]]),
    takeDecision: async (d) => { calls.decisions.push(d); return { id: 44 }; },
    ...over,
  };
}

module.exports = { finding, makeDeps };
