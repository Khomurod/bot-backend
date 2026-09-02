/**
 * Mount the Route Control admin router with its service and DB layers stubbed.
 *
 * Shared by tests/routeControlRoutes.test.js and
 * tests/routeControlScreenshotRoutes.test.js. It lives here so both suites
 * agree on the stub shape and the auth gate: a suite that quietly used a
 * different default auth middleware would stop testing the gate at all.
 *
 * `auth: false` switches to a middleware that actually REQUIRES the header, so
 * the 401 cases exercise the same wiring the real app has rather than a
 * bypass.
 *
 * The image fixtures are real magic-byte prefixes because the backend checks
 * BYTES, not the declared Content-Type — a spoofed type is one of the cases,
 * and a fixture of plain text would make that assertion vacuous.
 */
'use strict';

const path = require('node:path');
const express = require('express');

function loadApp({ serviceMock = {}, rcMock = {}, gmapsMock = null, telegram = { sendMessage() {} }, auth = true } = {}) {
  const routePath = path.resolve(__dirname, '../../server/routes/routeControlRoutes.js');
  const servicePath = path.resolve(__dirname, '../../services/routeControlService.js');
  const rcPath = path.resolve(__dirname, '../../database/routeControl.js');
  const gmapsPath = path.resolve(__dirname, '../../database/gmapsSettings.js');
  for (const p of [routePath, servicePath, rcPath, gmapsPath]) delete require.cache[p];
  require.cache[servicePath] = { exports: serviceMock };
  require.cache[rcPath] = { exports: rcMock };
  require.cache[gmapsPath] = {
    exports: gmapsMock || { async getGmapsConfig() { return { routeCompletionRadiusMiles: 35 }; } },
  };

  const { createRouteControlRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  const authMiddleware = auth
    ? (req, _res, next) => { req.admin = { username: 'admin' }; next(); }
    : (req, res, next) => {
      if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
      req.admin = { username: 'admin' }; return next();
    };
  app.use('/api/route-control', createRouteControlRouter({ authMiddleware, telegram }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Valid file signatures — the backend checks magic bytes, not just Content-Type.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-payload'),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-payload')]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPfake')]);

async function callMultipart(app, pathname, { payload, file, fieldName = 'screenshot', type = 'image/png' } = {}) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    if (payload !== undefined) form.append('payload', JSON.stringify(payload));
    if (file) form.append(fieldName, new Blob([file], { type }), 'route.png');
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      body: form,
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = {
  loadApp, call, callMultipart, PNG_BYTES, JPEG_BYTES, WEBP_BYTES,
};
