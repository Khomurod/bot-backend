const {
  extractDriverNameFromGroupTitle,
  extractUnitFromGroupName,
  parseGroupName,
  normalizePersonName,
  tokenizePersonName,
} = require('./driverGroupTitle');

const MIN_TOKEN_LENGTH = 3;
const MIN_MATCH_SCORE = 50;

const TEST_HUB_NAME_PATTERN = /automatic updating\s*\(test\)/i;

function isTestHubGroup(group) {
  const testChatId = String(process.env.DISPATCH_ETA_TEST_GROUP_ID || '').trim();
  if (testChatId && String(group?.telegram_group_id || '') === testChatId) {
    return true;
  }
  return TEST_HUB_NAME_PATTERN.test(String(group?.group_name || ''));
}

function buildDriverCandidate(group) {
  const groupName = String(group?.group_name || '').trim();
  const fromTitle = extractDriverNameFromGroupTitle(groupName);
  const parsed = parseGroupName(groupName);
  const driverName = fromTitle || String(parsed.driver || '').trim();
  const unitNumber = extractUnitFromGroupName(groupName) || null;

  return {
    groupId: group.id,
    groupName,
    telegramGroupId: group.telegram_group_id,
    driverName,
    unitNumber,
    driverTokens: tokenizePersonName(driverName),
    normalizedDriverName: normalizePersonName(driverName),
  };
}

function scoreDriverNameMatch(query, candidate) {
  const queryNorm = normalizePersonName(query);
  if (!queryNorm || !candidate.normalizedDriverName) return 0;

  const queryTokens = tokenizePersonName(query);
  if (!queryTokens.length) return 0;

  const driverTokens = candidate.driverTokens;
  if (!driverTokens.length) return 0;

  if (queryNorm === candidate.normalizedDriverName) {
    return 100;
  }

  const allQueryTokensInDriver = queryTokens.every((t) => driverTokens.includes(t));
  if (queryTokens.length > 1 && allQueryTokensInDriver) {
    return 80;
  }

  if (queryTokens.length === 1) {
    const token = queryTokens[0];
    if (token === driverTokens[0]) return 70;
    if (token === driverTokens[driverTokens.length - 1]) return 70;
    if (token.length >= MIN_TOKEN_LENGTH && driverTokens.includes(token)) {
      return 50;
    }
  }

  return 0;
}

function searchDriverGroupsByNameInList(groups, query) {
  const candidates = [];
  for (const group of groups) {
    if (isTestHubGroup(group)) continue;

    const candidate = buildDriverCandidate(group);
    if (!candidate.driverName) continue;

    const score = scoreDriverNameMatch(query, candidate);
    if (score >= MIN_MATCH_SCORE) {
      candidates.push({ ...candidate, score });
    }
  }

  if (!candidates.length) return [];

  candidates.sort((a, b) => b.score - a.score || a.groupName.localeCompare(b.groupName));
  const topScore = candidates[0].score;
  return candidates.filter((c) => c.score === topScore);
}

async function searchDriverGroupsByName(query) {
  const db = require('../database/db');
  const groups = await db.getAllGroups();
  return searchDriverGroupsByNameInList(groups, query);
}

function formatDriverPickLabel(candidate) {
  const unit = candidate.unitNumber ? `UNIT #${candidate.unitNumber}` : 'UNIT ?';
  const name = candidate.driverName || candidate.groupName;
  return `${unit} — ${name}`;
}

module.exports = {
  MIN_MATCH_SCORE,
  isTestHubGroup,
  buildDriverCandidate,
  scoreDriverNameMatch,
  searchDriverGroupsByNameInList,
  searchDriverGroupsByName,
  formatDriverPickLabel,
};
