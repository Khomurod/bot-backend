/**
 * HTTP API assembly.
 *
 * This file owns the Express app: global middleware (CORS, body parsers,
 * static admin build, FleetView mount), auth middleware construction, and the
 * mounting of every feature route module in a stable, order-sensitive
 * sequence. Route handlers themselves live under server/routes/.
 *
 * Route modules receive their external collaborators (db, config, bot send
 * functions, AI services…) as injected dependencies from here. That keeps the
 * test suite's module-cache stubbing working: tests swap db/config/bot in
 * require.cache and re-require THIS file, which re-requires those modules and
 * hands the fresh (stubbed) references down to the cached route factories.
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const db = require('../database/db');
const { bot, sendQuestionToGroups, sendTestQuestion, sendBroadcastTest, sendBroadcastToGroups, sendConfirmationBroadcast, sendConfirmationBroadcastTest } = require('../bot/bot');
const { translateBatch } = require('../services/translationService');
const { generateDriverReport, generateCompanyReport, AI_REPORT_GENERATION_FAILED, callGroq } = require('../services/aiAnalysisService');
const { generateInsightReport } = require('../services/aiInsightsService');
const { ensureAnnotationsForRange } = require('../services/aiAnnotationService');
const { renderInsightReportForTelegram } = require('../services/insightRenderer');
const { buildTelegramMessageUrl } = require('../services/telegramUrl');
const {
  sanitizeCompanyReportHtmlForTelegram,
  sendTelegramHtmlChunks,
} = require('../services/telegramHtml');
const { processMessage: processScheduledMessage } = require('../services/schedulerService');
const { listBroadcastPlaceholders } = require('../services/broadcastTemplateService');
const {
  normalizeActiveFilter,
  resolveBroadcastTargetGroups,
} = require('../services/broadcastTargetService');

const {
  createAuthMiddleware,
  createInternalSharedSecretGuard,
  createProxyAuthGuard,
} = require('./middleware/auth');

const dispatchRoutes = require('./routes/dispatchRoutes');
const { createFacebookLeadsRouter } = require('./routes/facebookLeadsRoutes');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createHealthRoutes } = require('./routes/healthRoutes');
const { createLeadsProxyRoutes } = require('./routes/leadsProxyRoutes');
const { createFacebookConnectRoutes } = require('./routes/facebookConnectRoutes');
const { createMediaUploadRoutes } = require('./routes/mediaUploadRoutes');
const { createDriverGroupsRoutes } = require('./routes/driverGroupsRoutes');
const { createDriverProfilesRoutes } = require('./routes/driverProfilesRoutes');
const { createMileageBonusRoutes } = require('./routes/mileageBonusRoutes');
const { createQuestionsRoutes } = require('./routes/questionsRoutes');
const { createBroadcastRoutes } = require('./routes/broadcastRoutes');
const { createScheduledMessagesRoutes } = require('./routes/scheduledMessagesRoutes');
const { createLeadsRoutes } = require('./routes/leadsRoutes');
const { createAiReportsRoutes } = require('./routes/aiReportsRoutes');
const { createMessageManagerRoutes } = require('./routes/messageManagerRoutes');
const { createEmployeeBirthdayRoutes } = require('./routes/employeeBirthdayRoutes');

const adminBuildDir = path.join(__dirname, '..', 'admin', 'build');
const adminSpaIndexPath = path.join(adminBuildDir, 'index.html');

const app = express();

// ─── CORS ───
// In testing we default to permissive; production should set CORS_ALLOWED_ORIGINS
// to an explicit allow-list (comma-separated). Origin is honored via config.
const corsOptions = config.corsAllowAll
  ? { origin: true }
  : {
      origin(origin, cb) {
        // Non-browser requests (curl, server-to-server) have no Origin header.
        if (!origin) return cb(null, true);
        if (config.corsAllowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin ${origin} not allowed by CORS policy`));
      },
    };
app.use(cors(corsOptions));
app.set('trust proxy', 1); // Render terminates TLS upstream; needed for rate-limit + IP logs.

// ─── Auth middleware (shared by every admin route module) ───
const authMiddleware = createAuthMiddleware(config);
const internalSharedSecretGuard = createInternalSharedSecretGuard(config);
const proxyAuthGuard = createProxyAuthGuard(config);

// ─── Leads-Bot Proxy + Indeed intake (MUST be before express.json()) ───
// The proxy preserves the raw body for Facebook's X-Hub-Signature-256
// verification; the Indeed route carries a base64 résumé PDF with its own
// larger JSON parser.
app.use(createLeadsProxyRoutes({ internalSharedSecretGuard }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Serve admin panel static files (production build)
app.use('/admin', express.static(adminBuildDir));

// ─── Fleet Operations Platform (self-contained module, mounted at /update) ───
// This is the only place linking the fleet module to the host app. It adds the
// /api/v1/* API and the /update/* SPA and touches nothing else in this file.
// A FleetView initialization failure must never take down the main app.
try {
  require('./fleet').mountFleet(app);
} catch (fleetMountError) {
  console.error('[FLEET] mount failed — main app continues without FleetView:', fleetMountError);
}

// ─── Auth ───
app.use(createAuthRoutes({ db, config, authMiddleware }));

// ─── Health checks, site root, presentation, Meta compliance pages ───
app.use(createHealthRoutes({ db, config }));

// ─── Facebook internal endpoints + connect/OAuth flow + leads log ───
app.use(createFacebookConnectRoutes({ db, internalSharedSecretGuard, proxyAuthGuard }));

// ─── Media Upload ───
// `stagingTelegram` is exposed so tests can stub its `callApi` to drive the
// upload route without touching the network (re-exported below).
const { router: mediaUploadRouter, stagingTelegram } = createMediaUploadRoutes({ config, authMiddleware });
app.use(mediaUploadRouter);

// ─── Feature routers on dedicated path prefixes ───

// Dispatch routes expose live GPS, Telegram group IDs, and send-to-Telegram
// actions — they must never be reachable without an admin token.
app.use('/api/dispatch', authMiddleware, dispatchRoutes);
app.use('/api/facebook-leads', createFacebookLeadsRouter({ authMiddleware }));

// ─── Driver Raise Approval (75¢/mile) ───
// Admin router is mounted on the more specific path FIRST so /api/raise/admin/*
// is never captured by the public router's /:token route.
const { publicRouter: raisePublicRouter, adminRouter: raiseAdminRouter } = require('./routes/raiseRoutes');
app.use('/api/raise/admin', raiseAdminRouter);
app.use('/api/raise', raisePublicRouter);

// ─── Driver Home-Time Tracking ───
const { createHomeTimeRouter } = require('./routes/homeTimeRoutes');
app.use('/api/home-time', createHomeTimeRouter({ authMiddleware }));

const { createFuelMonitorRouter } = require('./routes/fuelMonitorRoutes');
app.use('/api/fuel-monitor', createFuelMonitorRouter({ authMiddleware, telegram: bot.telegram }));

const { createLiveLocationsRouter } = require('./routes/liveLocationsRoutes');
app.use('/api/live-locations', createLiveLocationsRouter({ authMiddleware }));

const { createBotUsersRouter } = require('./routes/botUsersRoutes');
app.use('/api/bot-users', createBotUsersRouter({ authMiddleware }));

const { createSettingsRouter } = require('./routes/settingsRoutes');
app.use('/api/settings', createSettingsRouter({ authMiddleware, telegram: bot.telegram }));

const { createRouteControlRouter } = require('./routes/routeControlRoutes');
app.use('/api/route-control', createRouteControlRouter({ authMiddleware, telegram: bot.telegram }));

const { createRecruiterRouter } = require('./routes/recruiterRoutes');
app.use('/api/recruiters', createRecruiterRouter({ authMiddleware }));

const { createBotMessagesRouter } = require('./routes/botMessagesRoutes');
app.use('/api/bot-messages', createBotMessagesRouter({ authMiddleware, telegram: bot.telegram }));

// GET /api/groups/:groupId/members — users the bot has seen in a group, for
// the Driver Groups "Driver Username" dropdown. Only defines /:groupId/members,
// so the driver-group routes mounted after still match everything else.
const { createGroupMembersRouter } = require('./routes/groupMembersRoutes');
app.use('/api/groups', createGroupMembersRouter({ authMiddleware }));

// ─── Feature route modules (full paths, mounted at the app root) ───
app.use(createDriverGroupsRoutes({ db, authMiddleware }));
app.use(createDriverProfilesRoutes({ db, config, authMiddleware }));
app.use(createMileageBonusRoutes({ authMiddleware }));
app.use(createQuestionsRoutes({
  db,
  authMiddleware,
  sendQuestionToGroups,
  sendTestQuestion,
  translateBatch,
}));
app.use(createBroadcastRoutes({
  db,
  authMiddleware,
  sendBroadcastToGroups,
  sendBroadcastTest,
  sendConfirmationBroadcast,
  sendConfirmationBroadcastTest,
  resolveBroadcastTargetGroups,
  normalizeActiveFilter,
  listBroadcastPlaceholders,
}));
app.use(createScheduledMessagesRoutes({
  db,
  authMiddleware,
  processScheduledMessage,
  normalizeActiveFilter,
}));
app.use(createLeadsRoutes({ db, authMiddleware }));
app.use(createAiReportsRoutes({
  db,
  config,
  authMiddleware,
  bot,
  generateDriverReport,
  generateCompanyReport,
  AI_REPORT_GENERATION_FAILED,
  callGroq,
  generateInsightReport,
  ensureAnnotationsForRange,
  buildTelegramMessageUrl,
  renderInsightReportForTelegram,
  sanitizeCompanyReportHtmlForTelegram,
  sendTelegramHtmlChunks,
}));
app.use(createMessageManagerRoutes({ authMiddleware, bot }));
app.use(createEmployeeBirthdayRoutes({ db, config, authMiddleware, bot }));

// ─── Catch-all for admin SPA (/admin and public /dispatch share one build) ───
app.get(['/admin', '/admin/*', '/dispatch', '/dispatch/*', '/raise', '/raise/*', '/recruiters', '/recruiters/*'], (req, res) => {
  if (!fs.existsSync(adminSpaIndexPath)) {
    return res.status(503).type('text/plain').send(
      'Admin UI build is missing (admin/build/index.html). '
      + 'From repo root run: cd admin && npm install && npm run build. '
      + 'On Render, use the Blueprint buildCommand in render.yaml or equivalent.',
    );
  }
  res.sendFile(adminSpaIndexPath);
});

// ─── Start server function ───
let httpServer = null;

function startServer() {
  httpServer = app.listen(config.port, () => {
    console.log(`[API] Server running on port ${config.port}`);
  });
}

function stopServer() {
  if (!httpServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      httpServer = null;
      console.log('[API] HTTP server closed.');
      resolve();
    });
  });
}

// `stagingTelegram` is exported so tests can stub its `callApi` to drive the
// upload route without touching the network.
module.exports = { app, startServer, stopServer, stagingTelegram };
