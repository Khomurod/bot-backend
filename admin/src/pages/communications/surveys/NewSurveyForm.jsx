import React from "react";

import * as api from "../../../api";

// The server's rule (server/routes/helpers/surveyBodyHelpers.js), checked here first.
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const OTHER_LANGUAGES = [
  { key: "ru", label: "Russian" },
  { key: "uz", label: "Uzbek" },
];
const filled = (text) => text.trim() !== "";

/**
 * Write a new survey: the question and its answer buttons in English, then the
 * Russian and Uzbek versions every driver group of that language will see.
 *
 * "Translate" fills Russian and Uzbek from the English (`POST /api/translate`,
 * the same helper Send Message uses); both stay editable, and a person can type
 * them by hand when the AI is not configured. If the English changes after
 * translating, the form says so — it never re-translates on its own and so
 * never overwrites a correction somebody typed.
 *
 * SAVING DOES NOT SEND. A saved survey appears in the list with "Not sent yet";
 * sending it to every active driver group is a separate, confirmed action on
 * its card. The test send goes to the management group only, in English, and
 * answers to it are not recorded.
 */
export default function NewSurveyForm({ onSaved, onCancel }) {
  const [question, setQuestion] = React.useState("");
  const [options, setOptions] = React.useState(["", ""]);
  const [other, setOther] = React.useState({
    ru: { question: "", options: ["", ""] },
    uz: { question: "", options: ["", ""] },
  });
  const [translatedFrom, setTranslatedFrom] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [note, setNote] = React.useState(null);

  const englishSnapshot = JSON.stringify([question.trim(), ...options.map((o) => o.trim())]);
  const englishReady = filled(question) && options.length >= MIN_OPTIONS && options.every(filled);
  const otherReady = OTHER_LANGUAGES.every(({ key }) => (
    filled(other[key].question) && other[key].options.length === options.length && other[key].options.every(filled)
  ));
  const stale = translatedFrom !== null && translatedFrom !== englishSnapshot;

  const touch = () => { setError(null); setNote(null); };
  const setOption = (index, value) => { touch(); setOptions((prev) => prev.map((o, i) => (i === index ? value : o))); };
  const patchLanguage = (lang, patch) => { touch(); setOther((prev) => ({ ...prev, [lang]: { ...prev[lang], ...patch(prev[lang]) } })); };

  const addOption = () => {
    touch();
    setOptions((prev) => [...prev, ""]);
    setOther((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, options: [...v.options, ""] }])));
  };
  // Removing an answer removes it in every language, so the three stay aligned.
  const removeOption = (index) => {
    touch();
    setOptions((prev) => prev.filter((_, i) => i !== index));
    setOther((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, options: v.options.filter((_, i) => i !== index) }])));
  };

  const run = async (kind, work) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (err) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const translate = () => run("translate", async () => {
    const rows = await api.translateTexts([question.trim(), ...options.map((o) => o.trim())]);
    setOther(Object.fromEntries(OTHER_LANGUAGES.map(({ key }) => [key, {
      question: rows[0]?.[key] || "",
      options: options.map((_, i) => rows[i + 1]?.[key] || ""),
    }])));
    setTranslatedFrom(englishSnapshot);
    setNote("Translated. Check the Russian and Uzbek before saving — you can edit them.");
  });

  const sendTest = () => run("test", async () => {
    await api.sendTestQuestion(question.trim(), options.map((o) => o.trim()));
    setNote("Sent to the management group, in English. Answers to a test are not recorded.");
  });

  const save = () => run("save", async () => {
    const languages = [["en", { question, options }], ...OTHER_LANGUAGES.map(({ key }) => [key, other[key]])];
    const created = await api.createQuestion({
      translations: languages.map(([language, v]) => ({ language, question_text: v.question.trim() })),
      options: options.map((_, i) => ({
        option_order: i + 1,
        translations: languages.map(([language, v]) => ({ language, option_text: v.options[i].trim() })),
      })),
    });
    onSaved(created);
  });

  return (
    <form className="card" aria-label="New survey" style={{ marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); if (englishReady && otherReady) save(); }}>
      <h3 style={{ marginTop: 0 }}>New survey</h3>
      <p style={{ color: "var(--text-secondary)", marginTop: 0, fontSize: 13 }}>
        Each driver group gets it in its own language; a driver answers by tapping one button, once.
        Saving does not send it.
      </p>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>English</legend>
        <div className="form-group">
          <label htmlFor="survey-q-en">Question (English)</label>
          <textarea id="survey-q-en" className="form-input" rows={2} value={question} onChange={(e) => { touch(); setQuestion(e.target.value); }} />
        </div>
        {options.map((text, i) => (
          <div key={i} className="form-group" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label htmlFor={`survey-o-en-${i}`}>{`Option ${i + 1} (English)`}</label>
              <input id={`survey-o-en-${i}`} className="form-input" value={text} onChange={(e) => setOption(i, e.target.value)} />
            </div>
            {options.length > MIN_OPTIONS && (
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove option ${i + 1}`} onClick={() => removeOption(i)}>Remove</button>
            )}
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={addOption}>Add option</button>
        )}
      </fieldset>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!englishReady || busy !== null} onClick={translate}>
          {busy === "translate" ? "Translating…" : "Translate to Russian and Uzbek"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!englishReady || busy !== null} onClick={sendTest}>
          {busy === "test" ? "Sending…" : "Send test to management group"}
        </button>
      </div>
      {stale && (
        <div className="alert alert-warning" style={{ marginBottom: 8 }}>
          The English changed after translating. Translate again, or check the Russian and Uzbek yourself.
        </div>
      )}

      {OTHER_LANGUAGES.map(({ key, label }) => (
        <fieldset key={key} style={{ border: 0, padding: 0, margin: "8px 0" }}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>{label}</legend>
          <div className="form-group">
            <label htmlFor={`survey-q-${key}`}>{`Question (${label})`}</label>
            <textarea id={`survey-q-${key}`} className="form-input" rows={2} value={other[key].question}
              onChange={(e) => { const v = e.target.value; patchLanguage(key, () => ({ question: v })); }} />
          </div>
          {options.map((_, i) => (
            <div key={i} className="form-group">
              <label htmlFor={`survey-o-${key}-${i}`}>{`Option ${i + 1} (${label})`}</label>
              <input id={`survey-o-${key}-${i}`} className="form-input" value={other[key].options[i] || ""}
                onChange={(e) => { const v = e.target.value; patchLanguage(key, (cur) => ({ options: cur.options.map((o, j) => (j === i ? v : o)) })); }} />
            </div>
          ))}
        </fieldset>
      ))}

      {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
      {note && <div className="alert alert-success" role="status" style={{ marginBottom: 8 }}>{note}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!englishReady || !otherReady || busy !== null}>
          {busy === "save" ? "Saving…" : "Save survey"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={onCancel}>Cancel</button>
        {!(englishReady && otherReady) && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {!englishReady ? `Write the question and at least ${MIN_OPTIONS} options in English.` : "Fill in the Russian and Uzbek versions."}
          </span>
        )}
      </div>
    </form>
  );
}
