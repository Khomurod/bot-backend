/**
 * /answers/test — the test-data cleanup control.
 *
 * Deletes ONLY responses submitted through /questions/test: the server clears
 * is_test = TRUE rows exclusively, through the admin-guarded clear-test endpoint
 * whose confirmation phrase is separate from the real-data clear. Real SOS data
 * is unreachable from here.
 *
 * AUTHENTICATION — the whole point of this file:
 * the endpoint needs a FULL admin (admin.full_access). A browser may already
 * hold a token that is valid but NOT full-admin (a Trailer-department account),
 * or one that has expired. Reusing such a token used to 403/401 with no way
 * out, so the page was stuck. Now:
 *   - a stored token is only ever an OPTIMISTIC first try;
 *   - 401 (missing/expired/invalid) and 403 (valid but not full-admin) both
 *     reveal the inline login and say what to do — they never dead-end;
 *   - freshly typed credentials always win over the stored token;
 *   - the token obtained here lives in React state (memory) only. It is never
 *     written to localStorage, never logged, and the password field is cleared
 *     as soon as it has been exchanged for a token.
 */
import { useState } from "react";
import { clearSosTestData, sosAdminLogin } from "../../api/sos";

const CONFIRM_TEXT = "Faqat TEST javoblari oʻchiriladi (/questions/test orqali yuborilganlar). "
  + "Haqiqiy natijalarga tegilmaydi. Davom etasizmi?";

const TEXT = {
  needCredentials: "Toʻliq administrator login va parolini kiriting.",
  unauthorized: "Sessiya tugagan yoki token yaroqsiz. Toʻliq administrator login va parolini kiriting.",
  forbidden: "Bu hisobda yetarli ruxsat yoʻq (masalan, faqat Treyler boʻlimi hisobi). "
    + "Toʻliq administrator login va parolini kiriting.",
  loginFailed: "Kirish amalga oshmadi",
};

/** Reads the shared admin token, tolerating a blocked/absent localStorage. */
function readStoredToken() {
  try {
    const raw = localStorage.getItem("token");
    return raw && raw.trim() ? raw : null;
  } catch (_) {
    return null;
  }
}

export default function SosTestCleanup({ onCleared }) {
  const [expanded, setExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }
  // Set once the stored token has been REJECTED (401/403), or when the operator
  // opens the form themselves. While true the stored token is never retried.
  const [loginRequired, setLoginRequired] = useState(false);
  const [sessionToken, setSessionToken] = useState(null); // memory only

  const hasStoredToken = readStoredToken() !== null;
  const showLogin = loginRequired || !hasStoredToken;

  async function runCleanup() {
    if (busy) return; // double-click safe (the button is also disabled)
    if (!window.confirm(CONFIRM_TEXT)) return;
    setBusy(true);
    setMessage(null);

    const typedUsername = username.trim();
    const hasCredentials = typedUsername !== "" && password !== "";

    let token = sessionToken;
    if (hasCredentials) {
      try {
        token = await sosAdminLogin(typedUsername, password); // memory only
      } catch (err) {
        setMessage({ ok: false, text: `❌ ${TEXT.loginFailed}: ${err.message}` });
        setBusy(false);
        return;
      }
      setSessionToken(token);
      setPassword(""); // the password is not kept once exchanged for a token
      setLoginRequired(false);
    } else if (!token && !loginRequired) {
      token = readStoredToken(); // a valid FULL-admin token may be reused
    }

    if (!token) {
      setMessage({ ok: false, text: TEXT.needCredentials });
      setBusy(false);
      return;
    }

    try {
      const res = await clearSosTestData(token);
      setMessage({
        ok: true,
        text: `✅ ${res.deleted} ta TEST javobi oʻchirildi. Haqiqiy maʼlumotlarga tegilmadi.`,
      });
      if (onCleared) await onCleared();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        // Neither a missing/expired token nor an under-privileged one may block
        // the flow: drop it and surface the login.
        setSessionToken(null);
        setLoginRequired(true);
        setExpanded(true);
        setMessage({ ok: false, text: `❌ ${err.status === 403 ? TEXT.forbidden : TEXT.unauthorized}` });
      } else {
        setMessage({ ok: false, text: `❌ Oʻchirib boʻlmadi: ${err.message}` });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sos-card" style={{ border: "1.5px dashed #a78bfa", marginTop: 4 }}>
      <div className="sos-card-kicker" style={{ color: "#7c3aed" }}>Test maʼlumotlarini tozalash</div>
      <h2>🧹 TEST javoblarini oʻchirish</h2>
      <p>
        Bu tugma faqat <b>/questions/test</b> orqali yuborilgan sinov javoblarini oʻchiradi.
        Haqiqiy soʻrovnoma javoblari, natijalar va sozlamalarga mutlaqo tegilmaydi.
        Amal toʻliq administrator hisobini talab qiladi.
      </p>
      {!expanded ? (
        <button type="button" className="sos-btn sos-btn--ghost" onClick={() => setExpanded(true)}>
          Tozalash boʻlimini ochish
        </button>
      ) : (
        <div>
          {showLogin ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <input
                className="sos-input"
                style={{ maxWidth: 220 }}
                type="text"
                aria-label="Administrator login"
                placeholder="Admin login"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className="sos-input"
                style={{ maxWidth: 220 }}
                type="password"
                aria-label="Administrator parol"
                placeholder="Admin parol"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <button
              type="button"
              className="sos-toggle-link"
              style={{ display: "block", marginBottom: 8 }}
              onClick={() => setLoginRequired(true)}
            >
              Boshqa administrator hisobi bilan kirish
            </button>
          )}
          <button
            type="button"
            className="sos-btn sos-btn--primary"
            style={{ background: "#7c3aed", boxShadow: "0 6px 18px rgba(124, 58, 237, 0.35)" }}
            onClick={runCleanup}
            disabled={busy}
          >
            {busy ? "Oʻchirilmoqda…" : "TEST javoblarini oʻchirish"}
          </button>
        </div>
      )}
      {message && (
        <div className={message.ok ? "sos-note" : "sos-error"} style={{ marginTop: 12 }} role="alert">
          {message.text}
        </div>
      )}
    </div>
  );
}
