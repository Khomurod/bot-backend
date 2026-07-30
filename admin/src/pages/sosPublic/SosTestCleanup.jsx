/**
 * /answers/test — the test-data cleanup control.
 *
 * Deletes ONLY responses submitted through /questions/test (the server clears
 * is_test = TRUE rows exclusively, via the admin-guarded clear-test endpoint
 * whose confirmation phrase is separate from the real-data clear). The action
 * requires an administrator: if an admin token is already in this browser
 * (the admin panel shares the origin), it is reused; otherwise the control
 * shows an inline admin login whose token is kept in memory only. There is no
 * unauthenticated destructive API and no secret in this code.
 */
import { useState } from "react";
import { clearSosTestData, sosAdminLogin } from "../../api/sos";

export default function SosTestCleanup({ onCleared }) {
  const [expanded, setExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }

  const storedToken = (() => {
    try { return localStorage.getItem("token"); } catch (_) { return null; }
  })();

  async function runCleanup() {
    if (busy) return; // double-click safe
    if (!window.confirm("Faqat TEST javoblari oʻchiriladi (/questions/test orqali yuborilganlar). Haqiqiy natijalarga tegilmaydi. Davom etasizmi?")) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      let token = storedToken;
      if (!token) {
        if (!username.trim() || !password) {
          setMessage({ ok: false, text: "Administrator login va parolini kiriting." });
          setBusy(false);
          return;
        }
        token = await sosAdminLogin(username.trim(), password); // kept in memory only
      }
      const res = await clearSosTestData(token);
      setPassword("");
      setMessage({ ok: true, text: `✅ ${res.deleted} ta TEST javobi oʻchirildi. Haqiqiy maʼlumotlarga tegilmadi.` });
      if (onCleared) await onCleared();
    } catch (err) {
      setMessage({ ok: false, text: `❌ Oʻchirib boʻlmadi: ${err.message}` });
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
        Amal administrator hisobini talab qiladi.
      </p>
      {!expanded ? (
        <button type="button" className="sos-btn sos-btn--ghost" onClick={() => setExpanded(true)}>
          Tozalash boʻlimini ochish
        </button>
      ) : (
        <div>
          {!storedToken && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <input
                className="sos-input"
                style={{ maxWidth: 220 }}
                type="text"
                placeholder="Admin login"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className="sos-input"
                style={{ maxWidth: 220 }}
                type="password"
                placeholder="Admin parol"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
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
