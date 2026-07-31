/* QBQ hosted deck — admin session for saving edits.
 *
 * Reading the presentation is public; saving is not. This module is the only
 * place that holds a token, and it holds nothing else: no credentials are ever
 * kept, nothing is written into the document, and the page ships with no secret
 * of any kind baked into it.
 *
 * Token sources, in order:
 *   1. this tab's own session (a save earlier in the same visit),
 *   2. an admin already signed in to /admin in this browser,
 *   3. the login prompt.
 */
(function () {
  'use strict';

  var QBQ = (window.QBQ = window.QBQ || {});
  var TAB_KEY = 'qbq.token';
  var ADMIN_KEY = 'token'; // the key admin/src/api.js already uses
  var pending = null;

  function read(storage, key) {
    try {
      return window[storage].getItem(key) || '';
    } catch (err) {
      return ''; // private mode / blocked storage — the prompt still works
    }
  }

  function token() {
    return read('sessionStorage', TAB_KEY) || read('localStorage', ADMIN_KEY);
  }

  function setToken(value) {
    try {
      window.sessionStorage.setItem(TAB_KEY, value);
    } catch (err) {
      /* fall back to keeping it only in this closure via cached() */
    }
    cached = value;
  }

  var cached = '';

  function currentToken() {
    return token() || cached;
  }

  function clear() {
    cached = '';
    try {
      window.sessionStorage.removeItem(TAB_KEY);
    } catch (err) {
      /* nothing else to do */
    }
  }

  function ensureStyle() {
    if (document.getElementById('qbq-auth-style')) return;
    var css = document.createElement('style');
    css.id = 'qbq-auth-style';
    css.textContent = [
      '#qbq-login{position:fixed;inset:0;z-index:2147483640;display:flex;align-items:center;',
      'justify-content:center;background:rgba(10,13,18,0.72);font-family:"IBM Plex Sans",sans-serif}',
      '#qbq-login form{width:min(92vw,380px);background:#F4F1EA;color:#12161C;border-radius:14px;',
      'padding:26px;box-shadow:0 24px 70px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:14px}',
      '#qbq-login h2{margin:0;font-family:"Archivo",sans-serif;font-size:21px;line-height:1.25}',
      '#qbq-login p{margin:0;font-size:14px;line-height:1.5;color:#4C525B}',
      '#qbq-login label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#4C525B}',
      '#qbq-login input{font:inherit;font-size:16px;padding:11px 12px;border:1px solid #C9C4BA;',
      'border-radius:9px;background:#fff;color:#12161C}',
      '#qbq-login input:focus{outline:2px solid #F5B23D;outline-offset:1px;border-color:#F5B23D}',
      '#qbq-login .qbq-row{display:flex;gap:10px;margin-top:4px}',
      '#qbq-login button{flex:1;font:inherit;font-size:15px;padding:11px 14px;border:none;',
      'border-radius:9px;cursor:pointer}',
      '#qbq-login button[type=submit]{background:#12161C;color:#F4F1EA}',
      '#qbq-login button[data-qbq-cancel]{background:#E2DED5;color:#12161C}',
      '#qbq-login [data-qbq-error]{display:none;font-size:13px;color:#B4271F;line-height:1.45}',
      '#qbq-login[data-error="1"] [data-qbq-error]{display:block}',
    ].join('');
    document.head.appendChild(css);
  }

  /**
   * Ask for credentials and exchange them for a token.
   *
   * Resolves with a token, or null when the presenter cancels. Credentials go
   * straight to the existing /api/auth/login endpoint and are never stored,
   * echoed into the DOM, or logged.
   */
  function requestLogin(message) {
    if (pending) return pending;
    ensureStyle();

    pending = new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.id = 'qbq-login';
      overlay.innerHTML = [
        '<form novalidate>',
        '<h2>Administrator sifatida kiring</h2>',
        '<p data-qbq-reason>O‘zgarishni saqlash uchun administrator huquqi kerak.</p>',
        '<label>Foydalanuvchi nomi<input name="username" autocomplete="username" required></label>',
        '<label>Parol<input name="password" type="password" autocomplete="current-password" required></label>',
        '<span data-qbq-error></span>',
        '<div class="qbq-row">',
        '<button type="button" data-qbq-cancel>Bekor qilish</button>',
        '<button type="submit">Kirish</button>',
        '</div>',
        '</form>',
      ].join('');

      if (message) overlay.querySelector('[data-qbq-reason]').textContent = message;
      var form = overlay.querySelector('form');
      var error = overlay.querySelector('[data-qbq-error]');
      var submit = overlay.querySelector('button[type=submit]');

      function close(result) {
        window.removeEventListener('keydown', onKey, true);
        overlay.remove();
        pending = null;
        resolve(result);
      }

      function onKey(e) {
        // Stop arrows/space reaching the deck while the prompt is open.
        e.stopPropagation();
        if (e.key === 'Escape') close(null);
      }

      overlay.querySelector('[data-qbq-cancel]').addEventListener('click', function () {
        close(null);
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var username = form.username.value.trim();
        var password = form.password.value;
        if (!username || !password) {
          overlay.setAttribute('data-error', '1');
          error.textContent = 'Foydalanuvchi nomi va parolni kiriting.';
          return;
        }
        submit.disabled = true;
        submit.textContent = 'Tekshirilmoqda…';
        fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username, password: password }),
        })
          .then(function (res) {
            return res.json().then(function (data) {
              return { ok: res.ok, data: data };
            });
          })
          .then(function (out) {
            if (!out.ok || !out.data || !out.data.token) {
              throw new Error('login failed');
            }
            setToken(out.data.token);
            close(out.data.token);
          })
          .catch(function () {
            overlay.setAttribute('data-error', '1');
            error.textContent = 'Login yoki parol noto‘g‘ri. Qaytadan urinib ko‘ring.';
            submit.disabled = false;
            submit.textContent = 'Kirish';
            form.password.value = '';
            form.password.focus();
          });
      });

      window.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      form.username.focus();
    });

    return pending;
  }

  QBQ.auth = {
    token: currentToken,
    setToken: setToken,
    clear: clear,
    requestLogin: requestLogin,
  };
})();
