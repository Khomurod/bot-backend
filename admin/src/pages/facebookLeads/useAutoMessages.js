import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../../api";
import { emptyRule, mapPreviewResult } from "./constants";

/**
 * The auto-reply configuration: the settings row, the ordered time-window
 * rules, the fallback template, and the two live previews.
 *
 * TWO PREVIEWS, ON PURPOSE. "Now" answers *what would a lead arriving this
 * second receive* — it evaluates the whole rule set against the current time
 * in the configured timezone. "Editing" answers *what does the template I am
 * typing render to*. Collapsing them would lose the first question, which is
 * the one that catches a rule set with a gap in its coverage.
 *
 * Both previews are DEBOUNCED 400ms and are computed server-side from the
 * unsaved draft, so an admin sees the effect of an edit without saving it to
 * real leads first.
 *
 * The focus target (which rule's textarea, or the fallback) is a ref rather
 * than state because inserting a placeholder must read the caret position at
 * click time; keeping it in state would re-render the chip row and lose the
 * selection.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function useAutoMessages(setStatus) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(null);
  const [rules, setRules] = useState([]);
  const [placeholders, setPlaceholders] = useState([]);
  const [previewTarget, setPreviewTarget] = useState({ kind: "rule", index: 0 });
  const [nowPreview, setNowPreview] = useState(null);
  const [editPreview, setEditPreview] = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [sampleLead, setSampleLead] = useState({
    first_name: "John",
    full_name: "John Smith",
    phone: "+15551234567",
    email: "john@example.com",
  });

  const focusRef = useRef({ type: "rule", index: 0 });
  const fallbackRef = useRef(null);
  const ruleRefs = useRef({});

  const timezone = settings?.timezone || "America/Chicago";

  const focusRule = (index) => {
    focusRef.current = { type: "rule", index };
    setPreviewTarget({ kind: "rule", index });
  };

  const focusFallback = () => {
    focusRef.current = { type: "fallback", index: null };
    setPreviewTarget({ kind: "fallback" });
  };

  /** Insert a {token} at the caret of whichever template last had focus. */
  const insertPlaceholder = (token) => {
    const { type, index } = focusRef.current;
    if (type === "fallback" && fallbackRef.current) {
      const el = fallbackRef.current;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + token + el.value.slice(end);
      setSettings((s) => ({ ...s, fallback_template: next }));
      return;
    }
    if (type === "rule" && index != null) {
      setRules((prev) => prev.map((r, i) => {
        if (i !== index) return r;
        const el = ruleRefs.current[index];
        const current = r.message_template || "";
        if (!el) {
          return { ...r, message_template: current + token };
        }
        const start = el.selectionStart ?? current.length;
        const end = el.selectionEnd ?? current.length;
        return { ...r, message_template: current.slice(0, start) + token + current.slice(end) };
      }));
    }
  };

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFacebookLeadAutoMessages();
      const loadedRules = data.rules?.length ? data.rules : [emptyRule(0)];
      setSettings(data.settings || {
        timezone: "America/Chicago",
        is_enabled: true,
        rep_name: "Tom",
        company_name: "Wenze trucking company",
        position_label: "OTR position",
        fallback_template: "",
      });
      setRules(loadedRules);
      setPlaceholders(data.placeholders || []);
      setPreviewTarget(loadedRules.length ? { kind: "rule", index: 0 } : { kind: "fallback" });
      focusRef.current = loadedRules.length
        ? { type: "rule", index: 0 }
        : { type: "fallback", index: null };
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  const runNowPreview = useCallback(async () => {
    if (!settings) return;
    try {
      const result = await api.previewFacebookLeadAutoMessage({
        settings,
        rules,
        field_map: sampleLead,
      });
      setNowPreview(mapPreviewResult(result));
    } catch (err) {
      setNowPreview({ error: err.message });
    }
  }, [settings, rules, sampleLead]);

  const runEditPreview = useCallback(async () => {
    if (!settings) return;

    let template = "";
    let ruleLabel = "Preview";

    if (previewTarget.kind === "fallback") {
      template = settings.fallback_template || "";
      ruleLabel = "Fallback (outside hours)";
    } else {
      const rule = rules[previewTarget.index];
      if (!rule) return;
      template = rule.message_template || "";
      ruleLabel = rule.label || `Rule ${previewTarget.index + 1}`;
    }

    try {
      const result = await api.previewFacebookLeadAutoMessage({
        settings,
        rules,
        field_map: sampleLead,
        template,
        rule_label: ruleLabel,
      });
      setEditPreview(mapPreviewResult(result));
    } catch (err) {
      setEditPreview({ error: err.message });
    }
  }, [settings, rules, sampleLead, previewTarget]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const t = setTimeout(() => { void runNowPreview(); }, 400);
    return () => clearTimeout(t);
  }, [runNowPreview]);

  useEffect(() => {
    const t = setTimeout(() => { void runEditPreview(); }, 400);
    return () => clearTimeout(t);
  }, [runEditPreview]);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const payload = {
        settings,
        rules: rules.map((r, i) => ({ ...r, sort_order: i })),
      };
      const saved = await api.saveFacebookLeadAutoMessages(payload);
      setSettings(saved.settings);
      setRules(saved.rules?.length ? saved.rules : rules);
      setStatus({ type: "success", text: "Auto-message settings saved." });
      setTimeout(() => setStatus(null), 4000);
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Reset discards unsaved edits, so it asks first rather than reloading.
  const handleReset = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = () => {
    setShowResetConfirm(false);
    void loadConfig();
  };

  const toggleDay = (ruleIndex, day) => {
    setRules((prev) => prev.map((r, i) => {
      if (i !== ruleIndex) return r;
      const days = new Set(r.days_of_week || []);
      if (days.has(day)) days.delete(day);
      else days.add(day);
      return { ...r, days_of_week: [...days].sort((a, b) => a - b) };
    }));
  };

  /**
   * Reorder rules. Order IS precedence — the first matching window wins — so
   * every move renumbers sort_order, and the preview focus follows the rule
   * the admin was looking at rather than staying on a now-different row.
   */
  const moveRule = (index, direction) => {
    setRules((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((r, i) => ({ ...r, sort_order: i }));
    });
    if (previewTarget.kind === "rule" && previewTarget.index === index) {
      const newIndex = index + direction;
      focusRule(newIndex);
    } else if (previewTarget.kind === "rule" && previewTarget.index === index + direction) {
      focusRule(index);
    }
  };

  return {
    loading, saving, settings, setSettings, rules, setRules, placeholders,
    previewTarget, nowPreview, editPreview, sampleLead, setSampleLead,
    timezone, focusRule, focusFallback, insertPlaceholder,
    fallbackRef, ruleRefs,
    handleSave, handleReset, confirmReset, showResetConfirm, setShowResetConfirm,
    toggleDay, moveRule,
  };
}
