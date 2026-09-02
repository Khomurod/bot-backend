/**
 * Load services/dispatchPinnedContextService with its collaborators mocked.
 *
 * Shared by tests/dispatchPinnedContext*.test.js. It lives here rather than
 * being copied into each suite so the mock DEFAULTS stay in one place: a suite
 * that silently disagreed about what an un-stubbed database call returns would
 * pass while testing a different world than its sibling.
 *
 * The Groq and Gemini stubs SPREAD the real modules first, so a case that only
 * overrides one function still gets genuine behaviour for the rest — that is
 * what keeps the provider-race tests honest about which side actually resolved.
 */
'use strict';

const path = require('node:path');

const { purgeModulePackage } = require('./purgeDataLayer');

function loadPinnedContextWithMocks({ parserMock, dbMock, groqMock, geminiMock } = {}) {
  const servicePath = path.resolve(__dirname, '../../services/dispatchPinnedContextService.js');
  const parserPath = path.resolve(__dirname, '../../server/services/dispatchParserService.js');
  const dbPath = path.resolve(__dirname, '../../database/db.js');
  const groqPath = path.resolve(__dirname, '../../services/groqClient.js');
  const geminiPath = path.resolve(__dirname, '../../services/geminiClient.js');

  // The service is a façade over services/pinnedContext/*; purging only the
  // façade would leave those siblings bound to the PREVIOUS case's mocks.
  purgeModulePackage(servicePath, path.resolve(__dirname, '../../services/pinnedContext'),
    [parserPath, dbPath, groqPath, geminiPath]);

  const realGroq = require('../../services/groqClient');
  const realGemini = require('../../services/geminiClient');

  require.cache[groqPath] = {
    exports: {
      ...realGroq,
      ...(groqMock || {}),
      callGroqWithFallback: groqMock?.callGroqWithFallback || realGroq.callGroqWithFallback,
    },
  };
  require.cache[geminiPath] = {
    exports: {
      ...realGemini,
      ...(geminiMock || {}),
      GEMINI_API_KEY: geminiMock?.GEMINI_API_KEY !== undefined
        ? geminiMock.GEMINI_API_KEY
        : (process.env.GEMINI_API_KEY || 'test-gemini-key'),
      callGeminiGenerateContent: geminiMock?.callGeminiGenerateContent || realGemini.callGeminiGenerateContent,
      getPinnedContextGeminiModels: geminiMock?.getPinnedContextGeminiModels
        || realGemini.getPinnedContextGeminiModels,
    },
  };
  require.cache[parserPath] = {
    exports: parserMock || {
      extractRateConRawTextFromFile: async () => ({ text: '', usedPdfOcr: false }),
    },
  };
  const defaultDb = {
    getGroupPinnedMessageSnapshot: async () => null,
    getChatLogsForGroup: async () => [],
    getGroupRecentLoads: async () => [],
    hasGroupRecentLoadForMessage: async () => false,
    hasAnyGroupRecentLoadForMessages: async () => false,
  };
  require.cache[dbPath] = {
    exports: { ...defaultDb, ...(dbMock || {}) },
  };
  return require(servicePath);
}

module.exports = { loadPinnedContextWithMocks };
