/**
 * /questions — one-question-per-screen flow with progress bar, back
 * navigation, and the final review step before submission. Options arrive
 * pre-shuffled from the orchestrator (stable during back-navigation).
 */

export default function SosQuestionFlow({
  t, lang, questions, answers, setAnswers, index, setIndex,
  reviewing, setReviewing, busy, error, onSubmit,
}) {
  const total = questions.length;

  if (reviewing) {
    return (
      <div className="sos-card">
        <h1>{t.reviewTitle}</h1>
        <p>{t.reviewText}</p>
        {error ? <div className="sos-error" role="alert">{error}</div> : null}
        <div className="sos-btn-row">
          <button
            type="button"
            className="sos-btn sos-btn--ghost"
            disabled={busy}
            onClick={() => { setReviewing(false); setIndex(total - 1); }}
          >
            {t.back}
          </button>
          <button type="button" className="sos-btn sos-btn--primary" onClick={onSubmit} disabled={busy}>
            {busy ? t.submitting : t.submit}
          </button>
        </div>
        {busy && <div className="sos-spinner" aria-hidden="true" />}
      </div>
    );
  }

  const question = questions[index];
  const selected = answers[question.key];

  function choose(optionKey) {
    setAnswers({ ...answers, [question.key]: optionKey });
  }

  function next() {
    if (!selected) return;
    if (index + 1 >= total) setReviewing(true);
    else setIndex(index + 1);
  }

  function back() {
    if (index > 0) setIndex(index - 1);
  }

  return (
    <div className="sos-card">
      <div className="sos-progress">
        <div className="sos-progress-top">
          <span>{t.progress(index + 1, total)}</span>
          <span>{Math.round(((index) / total) * 100)}%</span>
        </div>
        <div className="sos-progress-bar">
          <div className="sos-progress-fill" style={{ width: `${((index + (selected ? 1 : 0.35)) / total) * 100}%` }} />
        </div>
      </div>

      <div className="sos-question-text">{question.text[lang]}</div>

      <div className="sos-options" role="radiogroup" aria-label={question.text[lang]}>
        {question.options.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected === option.key}
            className={`sos-option${selected === option.key ? " is-selected" : ""}`}
            onClick={() => choose(option.key)}
          >
            {option.text[lang]}
          </button>
        ))}
      </div>

      <div className="sos-btn-row">
        <button type="button" className="sos-btn sos-btn--ghost" onClick={back} disabled={index === 0}>
          {t.back}
        </button>
        <button type="button" className="sos-btn sos-btn--primary" onClick={next} disabled={!selected}>
          {t.next}
        </button>
      </div>
    </div>
  );
}
