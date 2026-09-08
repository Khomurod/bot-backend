'use strict';

/* global mqttLite -- defined by remote-mqtt.js, loaded before this file. */

/*
 * Presenter remote — pairing, the QR scanner and the slide controls.
 *
 * Extracted from server/public/remote.html when the page passed the
 * repository's 500-line limit. Unchanged apart from `mqttLite` and
 * `RC_KEEPALIVE` now living in remote-mqtt.js.
 *
 * THE PROTOCOL IS FIXED BY THE PRESENTATION FILE. The broker list, its order,
 * the topic names and the message shapes must match the deck exactly, or the
 * phone and the laptop never see each other. Do not "tidy" any of it.
 */

(function () {
  'use strict';

  /**
   * Public brokers, tried in order — the first one that CONNACKs wins.
   *
   * Three of them because one being unreachable from a hotel network or a
   * carrier that blocks the port is the normal case, not the exception.
   * The presentation uses this same list, so a phone and a laptop that pick
   * different brokers would never see each other: KEEP THE ORDER IDENTICAL.
   */
  var RC_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  var RC_NS = 'wzl/rc/';

  var RC_PING_MS = 7000;          // application-level hello/ping cadence
  var RC_CONNECT_TIMEOUT = 6000;  // per broker, before trying the next one
  var RC_RETRY_MIN = 1500;        // backoff floor after a link that once worked
  var RC_RETRY_MAX = 15000;       // and its ceiling

  var el = function (id) { return document.getElementById(id); };

  /* ---------- remote side ---------- */

  var rrClient = null;
  var rrCode = '';
  var rrBroker = 0;
  var rrPingTimer = null;
  var rrConnectTimer = null;
  var rrPaired = false;
  var rrEverPaired = false;
  var rrRetryDelay = RC_RETRY_MIN;
  var rrTotal = 0;
  var rrIndex = -1;
  var rrGiveUp = false;

  var rcRemote = el('rcRemote');

  function rrMsg(text) {
    var target = rcRemote.dataset.view === 'pad' ? el('rrMsgPad') : el('rrMsgJoin');
    target.textContent = text || '';
  }

  function rrLink(state, label) {
    rcRemote.dataset.link = state;
    el('rrLink').textContent = label;
  }

  function rrTopic(kind) { return RC_NS + rrCode + '/' + kind; }

  /** Phone → presentation. Silently a no-op when the link is down. */
  function rrSend(action, value) {
    if (!rrClient || !rrClient.alive) return;
    var msg = { type: 'cmd', action: action, at: Date.now() };
    if (value !== undefined && value !== null) msg.value = value;
    rrClient.publish(rrTopic('cmd'), JSON.stringify(msg));
  }

  function rrClearTimers() {
    if (rrPingTimer) { clearInterval(rrPingTimer); rrPingTimer = null; }
    if (rrConnectTimer) { clearTimeout(rrConnectTimer); rrConnectTimer = null; }
  }

  /**
   * Connect to RC_BROKERS[rrBroker], falling through to the next on failure.
   *
   * What happens when the whole list fails depends on whether this code ever
   * worked. Never paired: stop and say so, because the likely cause is a wrong
   * code or no internet, and the join screen's Connect button is right there.
   * Paired before: keep sweeping on a backoff — the presenter is mid-talk and
   * cannot be asked to do anything.
   */
  function rrConnect() {
    if (!rrCode) return;
    rrClearTimers();
    if (rrClient) { rrClient.close(false); rrClient = null; }

    if (rrBroker >= RC_BROKERS.length) {
      rrBroker = 0;
      if (rrEverPaired) {
        // This code worked before, so the deck is probably still up and the
        // network is not. Keep sweeping with a backoff rather than stranding a
        // presenter mid-talk on a pad whose only button is Disconnect.
        rrLink('off', 'Reconnecting…');
        rrMsg('No connection to the presentation. Still trying…');
        rrRetryDelay = Math.min(rrRetryDelay * 2, RC_RETRY_MAX);
        rrConnectTimer = setTimeout(function () { if (rrCode) rrConnect(); }, rrRetryDelay);
        return;
      }
      rrGiveUp = true;
      rrLink('off', 'No connection');
      rrMsg('Could not reach any broker. Check the phone’s internet, then tap Connect again.');
      return;
    }

    var url = RC_BROKERS[rrBroker];
    rrLink('wait', 'Connecting…');
    rrMsg('Connecting to the presentation…');

    var client = null;
    var wasAlive = false;
    var handlers = {
      onConnect: function () {
        if (client !== rrClient) return;
        wasAlive = true;
        if (rrConnectTimer) { clearTimeout(rrConnectTimer); rrConnectTimer = null; }
        rrGiveUp = false;
        rrRetryDelay = RC_RETRY_MIN;
        client.subscribe(rrTopic('state'));
        rrSend('hello');
        rrPingTimer = setInterval(function () { rrSend('ping'); }, RC_PING_MS);
        rrLink('wait', 'Waiting for the deck');
        rrMsg('Connected. Waiting for the presentation to answer…');
      },
      onMessage: function (topic, text) {
        if (client !== rrClient) return;
        rrOnState(text);
      },
      onError: function () { /* onclose does the failover; avoid doing it twice */ },
      onClose: function () {
        if (client !== rrClient) return;
        rrClearTimers();
        // `wasAlive`, not `rrPaired`: a broker that accepted us and then dropped
        // is worth retrying from the top of the list, even if the deck had gone
        // (a `bye` clears rrPaired while the socket is still perfectly good).
        if (wasAlive) {
          rrPaired = false;
          rrBroker = 0;
          rrLink('off', 'Reconnecting…');
          rrMsg('Link dropped. Reconnecting…');
          rrConnectTimer = setTimeout(function () { if (rrCode) rrConnect(); }, RC_RETRY_MIN);
        } else {
          rrBroker += 1;
          rrConnect();
        }
      }
    };

    try {
      client = mqttLite(url, handlers);
    } catch (e) {
      // `new WebSocket` throws synchronously on a URL a browser will not open.
      // Unguarded this ended the failover instead of trying the next broker.
      rrBroker += 1;
      rrConnect();
      return;
    }
    rrClient = client;

    // A socket that opens but never CONNACKs is the failure mode that hangs a
    // presenter on a blank screen; treat silence as a dead broker.
    rrConnectTimer = setTimeout(function () {
      if (client !== rrClient || client.alive) return;
      client.close(false);
    }, RC_CONNECT_TIMEOUT);
  }

  /** Presentation → phone. */
  function rrOnState(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'bye') {
      rrPaired = false;
      rrLink('off', 'Presentation closed');
      rrMsg('The presentation was closed. Reopen it and scan the code again.');
      return;
    }
    if (msg.type !== 'state') return;

    // The first state is the pairing signal: the deck has answered.
    var firstState = !rrPaired;
    rrPaired = true;
    rrEverPaired = true;
    rrStopCam();
    rcRemote.dataset.view = 'pad';
    rrLink('on', 'Connected');
    if (firstState) rrMsg('');

    rrTotal = Number(msg.total) || 0;
    rrIndex = Number(msg.index) || 0;
    el('rrPos').textContent = rrTotal ? (rrIndex + 1) + ' / ' + rrTotal : String(rrIndex + 1);
    el('rrTitle').textContent = msg.title || '—';
    // The deck tells us which way full screen can go, so only offer that one.
    rcRemote.dataset.fs = msg.fullscreen ? 'on' : 'off';
    if (msg.presenting === false) rrMsg('The presentation is not in presenting mode.');
    rrDots();
  }

  /** One tappable square per slide — this is what `goto` is for. */
  function rrDots() {
    var box = el('rrDots');
    if (!rrTotal) { box.textContent = ''; return; }
    if (box.childElementCount !== rrTotal) {
      box.textContent = '';
      for (var i = 0; i < rrTotal; i += 1) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = String(i + 1);
        b.dataset.goto = String(i);
        b.setAttribute('aria-label', 'Go to slide ' + (i + 1));
        box.appendChild(b);
      }
    }
    Array.prototype.forEach.call(box.children, function (b, i) {
      if (i === rrIndex) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
  }

  function rrJoinWith(code) {
    var clean = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 4);
    if (clean.length !== 4) {
      rrMsg('Enter the four-digit code shown on the presentation.');
      return;
    }
    rrCode = clean;
    el('rrCode').value = clean;
    rrPaired = false;
    rrBroker = 0;
    rrGiveUp = false;
    rrRetryDelay = RC_RETRY_MIN;
    rrConnect();
  }

  function rrLeave() {
    rrSend('bye');
    rrClearTimers();
    if (rrClient) { rrClient.close(true); rrClient = null; }
    rrCode = '';
    rrPaired = false;
    rrEverPaired = false;
    rrRetryDelay = RC_RETRY_MIN;
    rrTotal = 0;
    rrIndex = -1;
    rcRemote.dataset.view = 'join';
    rrLink('idle', 'Not connected');
    rrMsg('Disconnected.');
  }

  /* ---------- QR scanner ---------- */

  var rrStream = null;
  var rrScanRaf = 0;
  var rrDetector = null;
  var rrCanvas = null;

  function rrStopCam() {
    if (!rrStream && !rrScanRaf) return;
    if (rrScanRaf) { cancelAnimationFrame(rrScanRaf); rrScanRaf = 0; }
    if (rrStream) {
      // Every track, or the phone keeps its camera light on after pairing.
      rrStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* gone */ } });
      rrStream = null;
    }
    el('rrVid').srcObject = null;
    el('rrScan').dataset.cam = 'off';
    el('rrCamBtn').textContent = 'Start camera';
  }

  async function rrStartCam() {
    if (rrStream) { rrStopCam(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      rrMsg('This browser cannot open the camera. Type the code instead.');
      return;
    }
    try {
      rrStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false
      });
    } catch (e) {
      // Denied, or no camera. Typing the code is always available.
      rrMsg('Camera not available. Type the four-digit code instead.');
      return;
    }
    var vid = el('rrVid');
    vid.srcObject = rrStream;
    try { await vid.play(); } catch (e) { /* autoplay attr covers it */ }
    el('rrScan').dataset.cam = 'on';
    el('rrCamBtn').textContent = 'Stop camera';
    rrMsg('Point the camera at the QR code on the presentation.');
    await rrPrepareDetector();
    rrScanLoop();
  }

  /** Native detector where it exists; jsQR only as the fallback. */
  async function rrPrepareDetector() {
    if (rrDetector) return;
    if (window.BarcodeDetector) {
      try {
        var formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.indexOf('qr_code') >= 0) {
          rrDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return;
        }
      } catch (e) { /* fall through to jsQR */ }
    }
    if (!window.jsQR) {
      await new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
        s.onload = resolve;
        s.onerror = resolve;   // resolve either way; the code field still works
        document.head.appendChild(s);
      });
    }
    if (!window.jsQR) rrMsg('QR scanning is unavailable here. Type the code instead.');
  }

  function rrScanLoop() {
    var vid = el('rrVid');
    var busy = false;
    var step = async function () {
      if (!rrStream) return;
      rrScanRaf = requestAnimationFrame(step);
      if (busy || vid.readyState < 2) return;
      busy = true;
      try {
        var found = rrDetector ? await rrDetectNative(vid) : rrDetectJsQR(vid);
        if (found) rrOnScan(found);
      } catch (e) { /* one bad frame is not an error */ }
      busy = false;
    };
    rrScanRaf = requestAnimationFrame(step);
  }

  async function rrDetectNative(vid) {
    var hits = await rrDetector.detect(vid);
    return hits && hits.length ? hits[0].rawValue : '';
  }

  function rrDetectJsQR(vid) {
    if (!window.jsQR) return '';
    if (!rrCanvas) rrCanvas = document.createElement('canvas');
    var w = vid.videoWidth, h = vid.videoHeight;
    if (!w || !h) return '';
    // Downscale: a phone camera frame is far more pixels than a QR needs, and
    // full-resolution scanning drops the frame rate to a crawl.
    var scale = Math.min(1, 640 / Math.max(w, h));
    rrCanvas.width = Math.round(w * scale);
    rrCanvas.height = Math.round(h * scale);
    var ctx = rrCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(vid, 0, 0, rrCanvas.width, rrCanvas.height);
    var data = ctx.getImageData(0, 0, rrCanvas.width, rrCanvas.height);
    var hit = window.jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' });
    return hit ? hit.data : '';
  }

  /** Pull the code out of whatever the QR encoded. */
  function rrOnScan(raw) {
    var text = String(raw || '');
    var m = text.match(/[#?&]c=([0-9A-Za-z]{4})/) || text.match(/\b(\d{4})\b/);
    if (!m) return;
    rrStopCam();
    rrJoinWith(m[1]);
  }

  /* ---------- wiring ---------- */

  function rrCodeFromUrl() {
    var hay = (location.hash || '') + '&' + (location.search || '');
    var m = hay.match(/[#?&]c=([0-9A-Za-z]{4})/);
    return m ? m[1] : '';
  }

  function rrInit() {
    // This document IS the remote: no host-side rc* controls, no "back to the
    // report" link, and the report's own remote styling applies.
    document.body.dataset.remote = '1';

    el('rrJoinBtn').addEventListener('click', function () { rrJoinWith(el('rrCode').value); });
    el('rrCode').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') rrJoinWith(el('rrCode').value);
    });
    el('rrCamBtn').addEventListener('click', function () { rrStartCam(); });
    el('rrBye').addEventListener('click', rrLeave);

    el('rrPad').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.dataset.act) rrSend(btn.dataset.act);
      else if (btn.dataset.goto !== undefined) rrSend('goto', Number(btn.dataset.goto));
    });

    // A phone that locked its screen mid-talk comes back to a dead socket.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !rrCode || rrGiveUp) return;
      if (!rrClient || !rrClient.alive) { rrBroker = 0; rrConnect(); }
    });

    // A code arriving in the hash AFTER load is the same request as one that
    // was there on load: a phone whose camera app reuses this tab for a second
    // QR, or a page restored from the back/forward cache, changes the hash
    // without re-running this function.
    window.addEventListener('hashchange', function () {
      var next = rrCodeFromUrl();
      if (next && next !== rrCode) rrJoinWith(next);
    });

    // Scanned from the presentation's QR: connect with no taps at all.
    var code = rrCodeFromUrl();
    if (code) rrJoinWith(code);
    else rrMsg('Scan the QR code on the presentation, or type its four-digit code.');
  }

  window.addEventListener('pagehide', function () {
    if (rrClient) rrClient.close(true);
    rrStopCam();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rrInit);
  } else {
    rrInit();
  }
})();
