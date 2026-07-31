/**
 * Public /questions page — QBQ / SOS employee questionnaire.
 *
 * Standalone bright experience (no admin chrome, no auth). Flow:
 * welcome (language) → details (name/department/team) → 10 questions with
 * back-navigation → review → submit → personal result. The server scores
 * deterministically; this page never sees pattern/weight data.
 */
import { useEffect, useState } from "react";
import "./sosPublic.css";
import { STRINGS, SOS_LANGS } from "./sosStrings";
import { getSosMeta, getSosQuestionnaire, submitSosAssessment, getSosResult } from "../../api/sos";
import { SosWelcome, SosDetails, SosStatusCard } from "./SosIntroScreens";
import SosQuestionFlow from "./SosQuestionFlow";
import SosResultScreen from "./SosResultScreen";

/** Fisher–Yates copy; called once per questionnaire load so back-nav is stable. */
function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export default function SosQuestionsPage({ isTest = false }) {
  // Separate token storage per mode: a rehearsal on /questions/test must not
  // overwrite the employee's real result token (and vice versa).
  const TOKEN_KEY = isTest ? "sosResultTokenTest" : "sosResultToken";
  const [lang, setLang] = useState("uz");
  const [screen, setScreen] = useState("welcome");
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(false);
  const [form, setForm] = useState({ fullName: "", department: "", dispatchTeamKey: "" });
  const [questions, setQuestions] = useState(null);
  const [contentVersion, setContentVersion] = useState(null);
  const [answers, setAnswers] = useState({});
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState(null);
  const t = STRINGS[lang];

  const savedToken = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;

  useEffect(() => {
    document.title = isTest ? "TEST — Savol Ortidagi Savol (SOS)" : "Savol Ortidagi Savol (SOS)";
    (async () => {
      try {
        setMeta(await getSosMeta(isTest));
      } catch (err) {
        setMetaError(true);
      }
    })();
  }, []);

  async function startQuiz(details) {
    setBusy(true);
    setSubmitError("");
    try {
      const data = await getSosQuestionnaire(details.department, isTest);
      setForm(details);
      setContentVersion(data.contentVersion);
      setQuestions(data.questions.map((q) => ({ ...q, options: shuffled(q.options) })));
      setAnswers({});
      setIndex(0);
      setScreen("quiz");
    } catch (err) {
      if (err.closed) setScreen("closed");
      else setSubmitError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(confirmDuplicate) {
    setBusy(true);
    setSubmitError("");
    try {
      const payload = {
        fullName: form.fullName,
        department: form.department,
        dispatchTeamKey: form.department === "dispatch" ? form.dispatchTeamKey : undefined,
        language: lang,
        contentVersion,
        answers: questions.map((q) => ({ questionKey: q.key, optionKey: answers[q.key] })),
        confirmDuplicate: confirmDuplicate === true,
      };
      const data = await submitSosAssessment(payload, isTest);
      try { localStorage.setItem(TOKEN_KEY, data.resultToken); } catch (_) { /* private mode */ }
      setResult(data.result);
      setScreen("result");
    } catch (err) {
      if (err.duplicate) setScreen("duplicate");
      else if (err.staleContent) setScreen("stale");
      else if (err.closed) setScreen("closed");
      else setSubmitError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openSavedResult() {
    if (!savedToken) return;
    setBusy(true);
    try {
      const stored = await getSosResult(savedToken, isTest);
      setLang(stored.language);
      setResult(stored);
      setScreen("result");
    } catch (err) {
      try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
      setSubmitError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const showLangSwitcher = screen === "welcome" || screen === "details" || screen === "quiz" || screen === "review";

  return (
    <div className="sos-root">
      <div className="sos-shell">
        <header className="sos-header">
          <div className="sos-brand">
            <div className="sos-brand-badge">SOS</div>
            <div>
              <div className="sos-brand-title">{t.appTitle}</div>
              <div className="sos-brand-sub">Savol Ortidagi Savol</div>
              {isTest && <span className="sos-test-badge">🧪 {t.testBadge}</span>}
            </div>
          </div>
          {showLangSwitcher && (
            <div className="sos-langs" role="group" aria-label={t.chooseLanguage}>
              {SOS_LANGS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  className={`sos-lang-btn${lang === l.key ? " is-active" : ""}`}
                  onClick={() => setLang(l.key)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </header>

        {isTest && <div className="sos-test-banner">🧪 {t.testNote}</div>}

        {screen === "welcome" && (
          <SosWelcome
            t={t}
            meta={meta}
            metaError={metaError}
            savedToken={savedToken}
            busy={busy}
            error={submitError}
            onStart={() => (meta && !meta.open ? setScreen("closed") : setScreen("details"))}
            onViewResult={openSavedResult}
          />
        )}

        {screen === "details" && (
          <SosDetails t={t} lang={lang} meta={meta} busy={busy} error={submitError} onBack={() => setScreen("welcome")} onContinue={startQuiz} />
        )}

        {(screen === "quiz" || screen === "review") && questions && (
          <SosQuestionFlow
            t={t}
            lang={lang}
            questions={questions}
            answers={answers}
            setAnswers={setAnswers}
            index={index}
            setIndex={setIndex}
            reviewing={screen === "review"}
            setReviewing={(r) => setScreen(r ? "review" : "quiz")}
            busy={busy}
            error={submitError}
            onSubmit={() => submit(false)}
          />
        )}

        {screen === "duplicate" && (
          <SosStatusCard
            emoji="🤔"
            title={t.duplicateTitle}
            text={t.duplicateText}
            actions={[
              { label: t.duplicateContinue, primary: true, disabled: busy, onClick: () => submit(true) },
              { label: t.duplicateCancel, onClick: () => setScreen("review") },
            ]}
            error={submitError}
          />
        )}

        {screen === "closed" && <SosStatusCard emoji="🔒" title={t.closedTitle} text={t.closedText} />}

        {screen === "stale" && (
          <SosStatusCard
            emoji="🔄"
            title={t.staleTitle}
            text={t.staleText}
            actions={[{ label: t.reload, primary: true, onClick: () => window.location.reload() }]}
          />
        )}

        {screen === "result" && result && <SosResultScreen t={t} result={result} />}
      </div>
    </div>
  );
}
