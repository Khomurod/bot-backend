/* QBQ hosted deck — presenter side of the phone remote.
 *
 * Nothing is listenable until the presenter explicitly opens a session, so a
 * visitor who finds /qbq/remote has nothing to connect to. Opening one mints a
 * short pairing code; the phone trades that code for a token and the two ends
 * talk over Server-Sent Events.
 *
 * Commands are applied through the component's PUBLIC api (next/prev) and the
 * shared zoom module — the same central state the keyboard, the overlay buttons
 * and the slide rail already drive. The presenter then reports the resulting
 * slide and zoom back, which is what keeps the phone correct when navigation
 * happens locally.
 */
(function () {
  'use strict';

  var QBQ = (window.QBQ = window.QBQ || {});

  var session = null;      // { sessionId, presenterToken }
  var source = null;       // EventSource
  var lastCommandId = 0;   // presenter-side duplicate guard
  var stateTimer = null;
  var lastStateAt = 0;
  var panel = null;

  /** Floor between two state reports; see pushState for why it is leading-edge. */
  var STATE_MIN_INTERVAL_MS = 120;

  function stage() {
    return document.querySelector('deck-stage');
  }

  // ─── UI ───────────────────────────────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById('qbq-remote-style')) return;
    var css = document.createElement('style');
    css.id = 'qbq-remote-style';
    css.textContent = [
      '#qbq-remote-btn{position:fixed;top:20px;right:72px;z-index:2147483000;width:42px;height:42px;',
      'padding:0;display:flex;align-items:center;justify-content:center;background:rgba(15,19,25,0.5);',
      'border:1px solid rgba(244,241,234,0.3);border-radius:10px;color:#F4F1EA;cursor:pointer;',
      'opacity:0.45;transition:opacity .2s ease,background .2s ease}',
      '#qbq-remote-btn:hover{opacity:1;background:rgba(15,19,25,0.9)}',
      '#qbq-remote-btn[data-live="1"]{opacity:1;border-color:#84C7CD;color:#84C7CD}',
      '#qbq-remote-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8}',
      'html[data-fs="1"] #qbq-remote-btn{display:none}',
      '#qbq-remote{position:fixed;top:74px;right:20px;z-index:2147483400;width:min(92vw,320px);',
      'background:#F4F1EA;color:#12161C;border-radius:14px;padding:20px;display:none;',
      'box-shadow:0 20px 60px rgba(0,0,0,0.45);font-family:"IBM Plex Sans",sans-serif}',
      '#qbq-remote[data-open="1"]{display:block}',
      '#qbq-remote h3{margin:0 0 6px;font-family:"Archivo",sans-serif;font-size:17px}',
      '#qbq-remote p{margin:0 0 12px;font-size:13px;line-height:1.5;color:#4C525B}',
      '#qbq-remote .qbq-code{font-family:"IBM Plex Mono",monospace;font-size:34px;letter-spacing:0.16em;',
      'text-align:center;padding:14px 8px;background:#12161C;color:#F5B23D;border-radius:10px;',
      'margin-bottom:10px;user-select:all}',
      '#qbq-remote .qbq-status{font-size:13px;margin-bottom:12px;color:#4C525B}',
      '#qbq-remote .qbq-status b{color:#12161C}',
      '#qbq-remote .qbq-row{display:flex;gap:8px}',
      '#qbq-remote button{flex:1;font:inherit;font-size:14px;padding:10px;border:none;border-radius:9px;cursor:pointer}',
      '#qbq-remote button[data-qbq-new]{background:#E2DED5;color:#12161C}',
      '#qbq-remote button[data-qbq-end]{background:#12161C;color:#F4F1EA}',
    ].join('');
    document.head.appendChild(css);
  }

  function ensureUi() {
    ensureStyle();
    if (panel) return panel;

    var button = document.createElement('button');
    button.id = 'qbq-remote-btn';
    button.type = 'button';
    button.title = 'Masofaviy boshqaruv';
    button.setAttribute('aria-label', 'Masofaviy boshqaruv');
    button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">'
      + '<rect x="6" y="1.6" width="8" height="16.8" rx="2.2"></rect>'
      + '<line x1="8.6" y1="15.4" x2="11.4" y2="15.4"></line></svg>';
    button.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    document.body.appendChild(button);

    panel = document.createElement('div');
    panel.id = 'qbq-remote';
    panel.innerHTML = [
      '<h3>Masofaviy boshqaruv</h3>',
      '<p>Telefonda <b>/qbq/remote</b> sahifasini oching va shu kodni kiriting.</p>',
      '<div class="qbq-code" data-qbq-code>——————</div>',
      '<div class="qbq-status" data-qbq-status></div>',
      '<div class="qbq-row">',
      '<button type="button" data-qbq-new>Yangi kod</button>',
      '<button type="button" data-qbq-end>Tugatish</button>',
      '</div>',
    ].join('');
    panel.querySelector('[data-qbq-new]').addEventListener('click', newCode);
    panel.querySelector('[data-qbq-end]').addEventListener('click', endSession);
    document.body.appendChild(panel);
    return panel;
  }

  function setStatus(text) {
    ensureUi();
    panel.querySelector('[data-qbq-status]').innerHTML = text;
  }

  function setCode(code) {
    ensureUi();
    panel.querySelector('[data-qbq-code]').textContent = code || '——————';
  }

  function markLive(live) {
    var button = document.getElementById('qbq-remote-btn');
    if (button) button.setAttribute('data-live', live ? '1' : '0');
  }

  // ─── Session ──────────────────────────────────────────────────────────────

  function toggle() {
    ensureUi();
    if (panel.getAttribute('data-open') === '1') {
      panel.removeAttribute('data-open');
      return;
    }
    panel.setAttribute('data-open', '1');
    if (!session) openSession();
  }

  function openSession() {
    setStatus('Sessiya ochilmoqda…');
    fetch('/api/qbq/session', { method: 'POST' })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res); })
      .then(function (data) {
        session = { sessionId: data.sessionId, presenterToken: data.presenterToken };
        setCode(data.code);
        setStatus('Telefon ulanishini kutmoqda…');
        connect();
        pushState();
      })
      .catch(function () {
        setStatus('Sessiya ochilmadi. Qaytadan urinib ko‘ring.');
      });
  }

  function newCode() {
    if (!session) return openSession();
    return fetch('/api/qbq/session/code', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.presenterToken },
    })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res); })
      .then(function (data) { setCode(data.code); })
      .catch(function () { setStatus('Yangi kod olinmadi.'); });
  }

  function endSession() {
    if (!session) {
      if (panel) panel.removeAttribute('data-open');
      return;
    }
    var token = session.presenterToken;
    teardown();
    fetch('/api/qbq/disconnect', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    }).catch(function () { /* the session expires on its own regardless */ });
    setCode(null);
    setStatus('Sessiya tugatildi.');
    if (panel) panel.removeAttribute('data-open');
  }

  function teardown() {
    if (source) { source.close(); source = null; }
    session = null;
    lastCommandId = 0;
    markLive(false);
  }

  function connect() {
    if (!session) return;
    if (source) source.close();
    source = new EventSource('/api/qbq/stream?token=' + encodeURIComponent(session.presenterToken));
    source.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (err) { return; }
      if (!data) return;
      if (data.type === 'command') return applyCommand(data);
      if (data.type === 'remote') {
        markLive(data.connected);
        setStatus(data.connected
          ? 'Telefon ulandi. <b>Boshqaruv faol.</b>'
          : 'Telefon uzildi.');
        if (data.connected) pushState();
        return;
      }
      if (data.type === 'ended') teardown();
    };
    source.onerror = function () {
      // EventSource retries by itself; say so rather than looking dead.
      setStatus('Ulanish tiklanmoqda…');
    };
  }

  // ─── Commands in, state out ───────────────────────────────────────────────

  function applyCommand(command) {
    // The server already drops a replayed seq; this is the second, independent
    // guard, so one tap can never move two slides.
    if (!command || typeof command.id !== 'number' || command.id <= lastCommandId) return;
    lastCommandId = command.id;
    var deck = stage();
    if (command.action === 'next' && deck) deck.next();
    else if (command.action === 'prev' && deck) deck.prev();
    else if (command.action === 'zoomIn' && QBQ.zoom) QBQ.zoom.zoomIn();
    else if (command.action === 'zoomOut' && QBQ.zoom) QBQ.zoom.zoomOut();
    else if (command.action === 'reset' && QBQ.zoom) QBQ.zoom.reset();
    pushState();
  }

  function snapshot() {
    var deck = stage();
    return {
      slide: deck ? deck.index : 0,
      total: deck ? deck.length : 0,
      zoom: QBQ.zoom ? QBQ.zoom.get() : 1,
    };
  }

  function sendState() {
    if (!session) return;
    lastStateAt = Date.now();
    fetch('/api/qbq/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.presenterToken,
      },
      body: JSON.stringify(snapshot()),
    }).catch(function () { /* the next change re-sends it */ });
  }

  /**
   * Report the deck's state, coalesced so a held arrow key is not a burst of
   * POSTs — but on the LEADING edge, so the first change goes out immediately.
   *
   * That distinction matters in practice: if the presenter's tab is not the
   * focused one, browsers throttle background timers to about a second, and a
   * trailing-edge-only throttle would leave the phone a visible step behind.
   * Sending first and coalescing after keeps the readout prompt either way.
   */
  function pushState() {
    if (!session) return;
    var since = Date.now() - lastStateAt;
    if (since >= STATE_MIN_INTERVAL_MS) {
      sendState();
      return;
    }
    if (stateTimer) return;
    stateTimer = setTimeout(function () {
      stateTimer = null;
      sendState();
    }, STATE_MIN_INTERVAL_MS - since);
  }

  // Local navigation — keyboard, overlay buttons, slide rail — all end up here,
  // which is how the phone stays in step without knowing how the move happened.
  document.addEventListener('slidechange', pushState, true);
  customElements.whenDefined('deck-stage').then(function () {
    var deck = stage();
    if (deck) deck.addEventListener('slidechange', pushState);
  });
  if (QBQ.zoom) QBQ.zoom.onChange(pushState);

  QBQ.remoteLink = {
    open: openSession,
    end: endSession,
    applyCommand: applyCommand,
    snapshot: snapshot,
    isLive: function () { return Boolean(session); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUi);
  } else {
    ensureUi();
  }
})();
