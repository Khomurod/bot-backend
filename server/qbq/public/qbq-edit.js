/* QBQ hosted deck — double-click text editing with edits saved in PostgreSQL.
 *
 * This is the hosted twin of the offline file's save-to-disk editor. The
 * INTERACTION is deliberately identical — double-click text, type, click the
 * amber pill (or Ctrl/Cmd+S), Escape to cancel — because presenters already
 * know it. Only the destination changed: instead of rewriting the whole HTML
 * document to a file, one element's plain text goes to the server.
 *
 * Nothing is kept in localStorage, and the server is the only source of truth:
 * reopening /qbq re-reads every override from the database.
 */
(function () {
  'use strict';

  var QBQ = (window.QBQ = window.QBQ || {});
  var BOOT = window.__QBQ__ || {};
  var TEXT_SEL = 'h1,h2,h3,h4,p,span,div,li,td,th';

  var target = null;
  var dirty = false;
  var pill = null;
  var hideTimer = null;

  // ─── Element addressing ───────────────────────────────────────────────────
  // Mirrors the component's own slide filter (_collectSlides) so a stored
  // slide index means the same thing here and in the deck.

  function slides() {
    var stage = document.querySelector('deck-stage');
    if (!stage) return [];
    return Array.prototype.filter.call(stage.children, function (el) {
      var t = el.tagName;
      return t !== 'TEMPLATE' && t !== 'SCRIPT' && t !== 'STYLE';
    });
  }

  function pathOf(el) {
    var list = slides();
    var parts = [];
    var node = el;
    while (node && list.indexOf(node) < 0) {
      var parent = node.parentElement;
      if (!parent) return null;
      parts.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    var slideIndex = list.indexOf(node);
    if (slideIndex < 0 || !parts.length) return null;
    return 's' + slideIndex + '.' + parts.join('.');
  }

  function elementAt(path) {
    var m = /^s(\d+)((?:\.\d+)+)$/.exec(String(path || ''));
    if (!m) return null;
    var node = slides()[Number(m[1])];
    if (!node) return null;
    var steps = m[2].slice(1).split('.');
    for (var i = 0; i < steps.length; i++) {
      node = node.children[Number(steps[i])];
      if (!node) return null;
    }
    return node;
  }

  /**
   * Write text without ever touching innerHTML.
   *
   * Stored content is plain text (the server strips markup), and it is put back
   * as text nodes plus real <br> elements. There is no path by which a stored
   * value becomes markup, let alone script.
   */
  function applyText(el, text) {
    var lines = String(text).split('\n');
    el.textContent = '';
    for (var i = 0; i < lines.length; i++) {
      if (i) el.appendChild(document.createElement('br'));
      if (lines[i]) el.appendChild(document.createTextNode(lines[i]));
    }
  }

  /** Only leaf text may be saved — see refusal message in save(). */
  function isLeafText(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].tagName !== 'BR') return false;
    }
    return true;
  }

  function applyOverrides(list) {
    var applied = 0;
    (list || []).forEach(function (row) {
      var el = elementAt(row.elementPath);
      if (!el) return; // deck structure moved on; the row is simply inert
      applyText(el, row.content);
      applied += 1;
    });
    return applied;
  }

  // ─── Save pill + messages ─────────────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById('qbq-edit-style')) return;
    var css = document.createElement('style');
    css.id = 'qbq-edit-style';
    css.textContent = [
      '#sos-save[data-state="error"]{background:#E0705F;color:#fff}',
      '#qbq-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:2147483500;',
      'max-width:min(90vw,520px);padding:12px 18px;border-radius:10px;font-family:"IBM Plex Sans",sans-serif;',
      'font-size:15px;line-height:1.45;box-shadow:0 10px 34px rgba(0,0,0,0.4);opacity:0;',
      'pointer-events:none;transition:opacity .18s ease}',
      '#qbq-toast[data-show="1"]{opacity:1}',
      '#qbq-toast[data-kind="ok"]{background:#84C7CD;color:#12161C}',
      '#qbq-toast[data-kind="error"]{background:#E0705F;color:#fff}',
    ].join('');
    document.head.appendChild(css);
  }

  var toastTimer = null;

  function toast(kind, message) {
    ensureStyle();
    var el = document.getElementById('qbq-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'qbq-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.setAttribute('data-kind', kind);
    el.textContent = message;
    el.setAttribute('data-show', '1');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.removeAttribute('data-show');
    }, kind === 'error' ? 5200 : 2800);
  }

  function buildPill() {
    if (pill) return pill;
    ensureStyle();
    pill = document.createElement('button');
    pill.id = 'sos-save';
    pill.type = 'button';
    pill.title = 'O‘zgarishni saqlash';
    pill.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h11l3 3v11H3z"></path>'
      + '<path d="M6.5 3v5h7V3"></path><path d="M6.5 17v-5h7v5"></path></svg>'
      + '<span data-sos-save-label>Saqlash</span>';
    pill.addEventListener('mousedown', function (e) { e.preventDefault(); });
    pill.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      save();
    });
    document.body.appendChild(pill);
    return pill;
  }

  function place() {
    var p = buildPill();
    var w = p.offsetWidth || 130;
    var h = p.offsetHeight || 42;
    var x = window.innerWidth - w - 22;
    var y = window.innerHeight - h - 22;
    if (target && target.isConnected) {
      var r = target.getBoundingClientRect();
      if (r.width || r.height) {
        x = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
        y = r.top - h - 12;
        if (y < 12) y = Math.min(r.bottom + 12, window.innerHeight - h - 12);
      }
    }
    p.style.left = Math.round(x) + 'px';
    p.style.top = Math.round(y) + 'px';
  }

  var LABELS = { dirty: 'Saqlash', saving: 'Saqlanmoqda…', saved: 'Saqlandi', error: 'Xato' };

  function show(state) {
    var p = buildPill();
    p.setAttribute('data-show', '1');
    p.setAttribute('data-state', state || 'dirty');
    var label = p.querySelector('[data-sos-save-label]');
    if (label) label.textContent = LABELS[state] || LABELS.dirty;
    place();
  }

  function hideLater(ms) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (pill) pill.removeAttribute('data-show');
    }, ms);
  }

  function stopEditing() {
    if (!target) return;
    target.removeAttribute('contenteditable');
    target.removeAttribute('spellcheck');
    target = null;
  }

  // ─── Editing ──────────────────────────────────────────────────────────────

  document.addEventListener('dblclick', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    // Same guard as the offline deck: no accidental editing while presenting.
    if (document.documentElement.getAttribute('data-fs') === '1') return;
    if (el.closest('#sos-fs') || el.closest('#sos-save')) return;
    if (el.closest('#qbq-login') || el.closest('#qbq-remote')) return;
    if (!el.matches(TEXT_SEL)) el = el.closest(TEXT_SEL);
    if (!el || !el.closest('section')) return;
    if (target && target !== el) stopEditing();
    target = el;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.focus();
    try {
      var sel = window.getSelection();
      var range = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : null;
      if (range && sel) {
        sel.removeAllRanges();
        sel.addRange(range);
        if (sel.modify) { sel.modify('move', 'backward', 'word'); sel.modify('extend', 'forward', 'word'); }
      }
    } catch (err) { /* selection is a nicety, not a requirement */ }
    if (dirty) show('dirty');
  });

  document.addEventListener('input', function (e) {
    if (!e.target || !e.target.isContentEditable) return;
    target = e.target;
    dirty = true;
    if (hideTimer) clearTimeout(hideTimer);
    show('dirty');
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.isContentEditable) {
      // Arrows and space belong to the caret while editing, not to the deck.
      e.stopPropagation();
    }
    if (e.key === 'Escape' && target) { target.blur(); stopEditing(); }
    if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
      if (dirty) { e.preventDefault(); save(); }
    }
  }, true);

  document.addEventListener('focusout', function (e) {
    if (e.target === target) {
      setTimeout(function () {
        if (target && !target.matches(':focus')) stopEditing();
      }, 0);
    }
  }, true);

  window.addEventListener('resize', function () {
    if (pill && pill.getAttribute('data-show')) place();
  });

  // ─── Save ─────────────────────────────────────────────────────────────────

  var ERRORS = {
    CONTENT_EMPTY: 'Matn bo‘sh bo‘lishi mumkin emas. O‘zgarish saqlanmadi.',
    CONTENT_TOO_LONG: 'Matn juda uzun. O‘zgarish saqlanmadi.',
    INVALID_ELEMENT_PATH: 'Bu elementni saqlab bo‘lmaydi. O‘zgarish saqlanmadi.',
    RATE_LIMITED: 'Juda ko‘p urinish. Bir oz kutib, qaytadan urinib ko‘ring.',
    SAVE_FAILED: 'Serverda xatolik. Avvalgi saqlangan matn o‘zgarmadi.',
  };

  function postSave(body, token) {
    return fetch('/api/qbq/content', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (token || ''),
      },
      body: JSON.stringify(body),
    });
  }

  function save() {
    var el = target;
    if (!el || !el.isConnected) {
      toast('error', 'Tahrirlanadigan matn topilmadi.');
      return;
    }
    if (!isLeafText(el)) {
      show('error');
      toast('error', 'Bu blok ichida boshqa elementlar bor. Aynan o‘zgartirmoqchi bo‘lgan matnni ikki marta bosing.');
      return;
    }
    var elementPath = pathOf(el);
    if (!elementPath) {
      show('error');
      toast('error', ERRORS.INVALID_ELEMENT_PATH);
      return;
    }

    var body = { elementPath: elementPath, content: el.innerText };
    show('saving');

    function attempt(token, allowPrompt) {
      return postSave(body, token).then(function (res) {
        if (res.status === 401 || res.status === 403) {
          if (!allowPrompt) throw { handled: true, code: 'AUTH' };
          QBQ.auth.clear();
          return QBQ.auth
            .requestLogin('O‘zgarishni saqlash uchun administrator huquqi kerak.')
            .then(function (fresh) {
              if (!fresh) throw { handled: true, code: 'CANCELLED' };
              return attempt(fresh, false);
            });
        }
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw { handled: true, code: data.code || 'SAVE_FAILED' };
          return data;
        });
      });
    }

    attempt(QBQ.auth.token(), true)
      .then(function () {
        dirty = false;
        stopEditing();
        show('saved');
        hideLater(2600);
        toast('ok', 'O‘zgarish saqlandi. Sahifani yangilasangiz ham qoladi.');
      })
      .catch(function (err) {
        // The element keeps the presenter's typing so nothing is lost, and the
        // previously saved version on the server is untouched.
        show('dirty');
        if (err && err.code === 'CANCELLED') {
          toast('error', 'Saqlanmadi: administrator sifatida kirilmadi.');
          return;
        }
        if (err && err.code === 'AUTH') {
          toast('error', 'Saqlanmadi: administrator huquqi yo‘q.');
          return;
        }
        toast('error', (err && ERRORS[err.code]) || ERRORS.SAVE_FAILED);
      });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  applyOverrides(BOOT.overrides);

  QBQ.edit = {
    pathOf: pathOf,
    elementAt: elementAt,
    applyText: applyText,
    applyOverrides: applyOverrides,
    isLeafText: isLeafText,
    save: save,
  };
})();
