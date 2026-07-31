/* QBQ hosted deck — presentation scaling.
 *
 * The deck component fits itself to the viewport by writing
 * `transform: scale(fit)` onto a canvas in its shadow DOM. Zoom multiplies
 * THAT number, so:
 *
 *   - the canvas keeps its `transform-origin: center center` inside a centered
 *     flexbox, which means zoom stays centered with no extra positioning;
 *   - the 16:9 canvas is scaled as a whole, so no slide layout, font size or
 *     element position is ever altered;
 *   - the host's `overflow:hidden` crops symmetrically past 100%, which is what
 *     you want on a projector.
 *
 * The component itself is generated and is not edited. Its `_fit` is wrapped on
 * the prototype, and re-fitting is triggered with an ordinary window `resize`
 * event rather than by calling a private method. Entering or leaving fullscreen
 * fires that same resize, so the chosen zoom survives both.
 *
 * Zoom is live-session state only and is never persisted.
 */
(function () {
  'use strict';

  var QBQ = (window.QBQ = window.QBQ || {});

  var MIN = 0.6;
  var MAX = 1.6;
  var STEP = 0.1;
  var zoom = 1;
  var listeners = [];
  var badgeTimer = null;

  function clamp(value) {
    var n = Number(value);
    if (!isFinite(n)) return zoom;
    // Round to the step grid so repeated in/out returns to exactly 1.
    n = Math.round(n / STEP) * STEP;
    return Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100));
  }

  function stage() {
    return document.querySelector('deck-stage');
  }

  function canvasOf(el) {
    if (!el) return null;
    if (el._canvas) return el._canvas;
    return el.shadowRoot ? el.shadowRoot.querySelector('.canvas') : null;
  }

  /** Re-apply the multiplier on top of whatever fit scale the component wrote. */
  function apply(el) {
    if (!el || el.hasAttribute('noscale')) return;
    var canvas = canvasOf(el);
    if (!canvas) return;
    var match = /scale\(\s*([0-9.]+)\s*\)/.exec(canvas.style.transform || '');
    if (!match) return;
    var fit = parseFloat(match[1]);
    if (!isFinite(fit) || fit <= 0) return;
    canvas.style.transform = 'scale(' + (fit * zoom) + ')';
  }

  function refit() {
    // The component recomputes its fit on resize; our wrapper then reapplies
    // the multiplier. No private call, no duplicated fit maths.
    window.dispatchEvent(new Event('resize'));
  }

  function ensureStyle() {
    if (document.getElementById('qbq-zoom-style')) return;
    var css = document.createElement('style');
    css.id = 'qbq-zoom-style';
    css.textContent = [
      // right:124px keeps clear of #sos-fs (right:20) and #qbq-remote-btn (right:72).
      '#qbq-zoom-badge{position:fixed;top:20px;right:124px;z-index:2147483000;',
      'font-family:"IBM Plex Mono",monospace;font-size:14px;letter-spacing:0.04em;',
      'padding:9px 13px;border-radius:10px;background:rgba(15,19,25,0.72);color:#F4F1EA;',
      'border:1px solid rgba(244,241,234,0.28);opacity:0;pointer-events:none;',
      'transition:opacity .18s ease}',
      '#qbq-zoom-badge[data-show="1"]{opacity:1}',
    ].join('');
    document.head.appendChild(css);
  }

  /** The presenter's own screen shows the zoom they (or the remote) chose. */
  function badge() {
    ensureStyle();
    var el = document.getElementById('qbq-zoom-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'qbq-zoom-badge';
      document.body.appendChild(el);
    }
    el.textContent = Math.round(zoom * 100) + '%';
    el.setAttribute('data-show', '1');
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () { el.removeAttribute('data-show'); }, 1600);
  }

  function set(value, options) {
    var next = clamp(value);
    if (next === zoom) {
      // Still surface the limit so a remote tap at 160% is not silent.
      if (!options || !options.quiet) badge();
      notify();
      return zoom;
    }
    zoom = next;
    refit();
    if (!options || !options.quiet) badge();
    notify();
    return zoom;
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](zoom);
      } catch (err) { /* one bad listener must not stop the others */ }
    }
  }

  customElements.whenDefined('deck-stage').then(function () {
    var Ctor = customElements.get('deck-stage');
    if (!Ctor || !Ctor.prototype || Ctor.prototype.__qbqZoomPatched) return;
    var original = Ctor.prototype._fit;
    if (typeof original !== 'function') return;
    Ctor.prototype._fit = function () {
      original.call(this);
      apply(this);
    };
    Ctor.prototype.__qbqZoomPatched = true;
    refit();
  });

  QBQ.zoom = {
    MIN: MIN,
    MAX: MAX,
    STEP: STEP,
    get: function () { return zoom; },
    percent: function () { return Math.round(zoom * 100); },
    set: set,
    zoomIn: function () { return set(zoom + STEP); },
    zoomOut: function () { return set(zoom - STEP); },
    reset: function () { return set(1); },
    refit: refit,
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    stage: stage,
  };
})();
