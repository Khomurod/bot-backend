/**
 * Shared harness for the SOS HTTP route suites.
 *
 * Mounts the real routers exactly like server/api.js does (admin behind auth,
 * then the test router, then the real one) with the SERVICE LAYER STUBBED, so the
 * route tests exercise wiring, validation, auth gating, error mapping and the
 * per-IP submit throttle without a database.
 *
 * Extracted so tests/sosRoutes.test.js and tests/sosSubmitThrottle.test.js share
 * one copy — the throttle is module-level state in the router, so each caller
 * gets a FRESH router instance (the require cache is primed and then cleared).
 */

const http = require('node:http');
const path = require('node:path');
const express = require('express');

const SERVICE_PATH = path.resolve(__dirname, '../../services/sosAssessment/index.js');
const ROUTES_PATH = path.resolve(__dirname, '../../server/routes/sosRoutes.js');

function serviceError(code, message, status, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.extra = extra;
  return err;
}

function defaultServiceStub(calls) {
  const track = (name, args) => calls && calls.push({ name, args });
  return {
    getMeta: async (isTest) => { track('getMeta', { isTest }); return { open: true, isTest: isTest === true, contentVersion: 1, departments: [], dispatchTeams: [{ id: 1, name: 'Team Alpha' }] }; },
    getQuestionnaire: async (dept, isTest) => { track('getQuestionnaire', { dept, isTest }); return { contentVersion: 1, department: dept, questions: [] }; },
    submitAssessment: async (input) => { track('submitAssessment', { isTest: input.isTest }); return { resultToken: 'a'.repeat(32), result: { language: 'uz' } }; },
    getResultByToken: async (token, isTest) => { track('getResultByToken', { token, isTest }); throw serviceError('NOT_FOUND', 'Result not found', 404); },
    getPublicSummary: async (isTest) => { track('getPublicSummary', { isTest }); return { open: true, total: 0, company: {}, departments: [], dispatchTeams: [] }; },
    getAdminStatus: async () => ({ open: true, testOpen: true, real: { total: 2 }, test: { total: 1 } }),
    getAdminSubmissionDetail: async (id) => (id === 7
      ? { id: 7, fullName: 'Jane Doe', isTest: false, answers: [] }
      : Promise.reject(serviceError('NOT_FOUND', 'Submission not found', 404))),
    listSubmissions: async ({ mode }) => {
      track('listSubmissions', { mode });
      const all = [
        {
          id: 1, isTest: false, fullName: '=cmd|danger', department: 'hr', dispatchTeamName: null, language: 'uz',
          primaryPattern: 'ownership', secondaryPattern: null, duplicateCount: 1,
          patternScores: { victim: 0, complaint: 0, waiting: 1, blame: 0, ownership: 6, builder: 3 },
          createdAt: new Date('2026-07-30T12:00:00Z'),
        },
        {
          id: 2, isTest: true, fullName: 'Test Person', department: 'hr', dispatchTeamName: null, language: 'uz',
          primaryPattern: 'builder', secondaryPattern: null, duplicateCount: 1,
          patternScores: { victim: 0, complaint: 0, waiting: 0, blame: 0, ownership: 4, builder: 6 },
          createdAt: new Date('2026-07-30T13:00:00Z'),
        },
      ];
      if (mode === 'all') return all;
      return all.filter((r) => r.isTest === (mode === 'test'));
    },
    setOpen: async (open, isTest) => { track('setOpen', { open, isTest }); return { isOpen: isTest ? true : open, testIsOpen: isTest ? open : true, updatedAt: new Date('2026-07-30T12:00:00Z') }; },
    deleteSubmission: async (id) => id === 7,
    clearSubmissions: async (isTest) => { track('clearSubmissions', { isTest }); return isTest ? 3 : 9; },
  };
}

function loadRouters(stubOverrides = {}, calls) {
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  require.cache[SERVICE_PATH] = {
    id: SERVICE_PATH,
    filename: SERVICE_PATH,
    loaded: true,
    exports: { ...defaultServiceStub(calls), ...stubOverrides },
  };
  const routers = require(ROUTES_PATH);
  delete require.cache[ROUTES_PATH];
  delete require.cache[SERVICE_PATH];
  return routers;
}

/** Mounts routers exactly like server/api.js: admin, then test, then real. */
async function withServer(stubOverrides, fn, calls) {
  const { publicRouter, publicTestRouter, adminRouter } = loadRouters(stubOverrides, calls);
  const app = express();
  app.use(express.json());
  const fakeAuth = (req, res, next) => {
    if (req.headers.authorization === 'Bearer good-token') { req.admin = { username: 'tester' }; return next(); }
    return res.status(401).json({ error: 'Unauthorized' });
  };
  app.use('/api/sos/admin', fakeAuth, adminRouter);
  app.use('/api/sos/test', publicTestRouter);
  app.use('/api/sos', publicRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const authHeaders = { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' };

module.exports = { withServer, loadRouters, serviceError, defaultServiceStub, authHeaders };
