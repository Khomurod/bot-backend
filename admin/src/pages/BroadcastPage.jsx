import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

const TEMPLATE_TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;
const DEFAULT_BROADCAST_PLACEHOLDER_KEYS = [
  'driver_name',
  'first_name',
  'last_name',
  'unit_number',
  'driver_type',
  'status',
  'language',
  'date_of_birth',
  'date_of_start',
];

function extractUnknownTokens(text, allowedKeys) {
  const source = String(text || '');
  const unknown = new Set();
  let match = TEMPLATE_TOKEN_PATTERN.exec(source);
  while (match) {
    const key = String(match[1] || '').toLowerCase();
    if (!allowedKeys.has(key)) unknown.add(key);
    match = TEMPLATE_TOKEN_PATTERN.exec(source);
  }
  TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
  return [...unknown];
}

function PlaceholderChips({ placeholders, onInsert }) {
  if (!Array.isArray(placeholders) || placeholders.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
      {placeholders.map((p) => (
        <button
          key={p.key}
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', border: '1px solid var(--border)' }}
          title={p.description || p.label || p.key}
          onClick={() => onInsert(`{${p.key}}`)}
        >
          {`{${p.key}}`}
        </button>
      ))}
    </div>
  );
}

export default function BroadcastPage() {
  // Tabs
  const [broadcastTab, setBroadcastTab] = useState('regular'); // 'regular' | 'confirmation'

  // Common Target Selection
  const [targetType, setTargetType] = useState('all'); // 'all' | 'specific_drivers' | 'language_groups'
  const [targetActiveFilter, setTargetActiveFilter] = useState('active'); // 'all' | 'active' | 'inactive'
  const [selectedDriverIds, setSelectedDriverIds] = useState([]);
  const [selectedLanguages, setSelectedLanguages] = useState([]);
  const [driverGroups, setDriverGroups] = useState([]);
  const [broadcastPlaceholders, setBroadcastPlaceholders] = useState([]);

  // Regular Broadcast State
  const [message, setMessage] = useState('');
  const [messageRu, setMessageRu] = useState('');
  const [messageUz, setMessageUz] = useState('');
  const [forceLanguage, setForceLanguage] = useState(null);
  const [broadcastMediaItems, setBroadcastMediaItems] = useState([]);
  const [broadcastMediaPosition, setBroadcastMediaPosition] = useState('above');
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [status, setStatus] = useState(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleType, setScheduleType] = useState('one_time');
  const [scheduledAtChicago, setScheduledAtChicago] = useState('');
  const [weeklyDayOfWeek, setWeeklyDayOfWeek] = useState('1');
  const [weeklyTimeChicago, setWeeklyTimeChicago] = useState('09:00');

  // History State
  const [regularHistory, setRegularHistory] = useState([]);
  const [regularHistoryLoading, setRegularHistoryLoading] = useState(false);
  const [expandedRegularBroadcast, setExpandedRegularBroadcast] = useState(null);
  const [regularDeliveries, setRegularDeliveries] = useState({});

  // Confirmation Broadcast State
  const [confMessage, setConfMessage] = useState('');
  const [confMessageRu, setConfMessageRu] = useState('');
  const [confMessageUz, setConfMessageUz] = useState('');
  const [confMediaItems, setConfMediaItems] = useState([]);
  const [confMediaPosition, setConfMediaPosition] = useState('above');
  const [confirmationButtons, setConfirmationButtons] = useState([{ label_en: 'Yes', label_ru: 'Да', label_uz: 'Ha' }]);
  const [confSending, setConfSending] = useState(false);
  const [confTesting, setConfTesting] = useState(false);
  const [confTranslating, setConfTranslating] = useState(false);
  const [confBtnTranslating, setConfBtnTranslating] = useState(false);
  const [confStatus, setConfStatus] = useState(null);

  // Conf History
  const [confHistory, setConfHistory] = useState([]);
  const [confHistoryLoading, setConfHistoryLoading] = useState(false);
  const [expandedConfBroadcast, setExpandedConfBroadcast] = useState(null);
  const [confDeliveries, setConfDeliveries] = useState({});
  const [confClicks, setConfClicks] = useState({});
  const [expandedClicks, setExpandedClicks] = useState(null);
  const [activeRegularField, setActiveRegularField] = useState('en');
  const [activeConfirmationField, setActiveConfirmationField] = useState('en');

  // Refs for toolbars
  const regTextareaRef = useRef(null);
  const regRuRef = useRef(null);
  const regUzRef = useRef(null);
  const confTextareaRef = useRef(null);
  const confRuRef = useRef(null);
  const confUzRef = useRef(null);

  // Toolbar setup
  const regFmt = useFormattingToolbar(regTextareaRef, message, setMessage);
  const regFmtRu = useFormattingToolbar(regRuRef, messageRu, setMessageRu);
  const regFmtUz = useFormattingToolbar(regUzRef, messageUz, setMessageUz);
  const confFmt = useFormattingToolbar(confTextareaRef, confMessage, setConfMessage);
  const confFmtRu = useFormattingToolbar(confRuRef, confMessageRu, setConfMessageRu);
  const confFmtUz = useFormattingToolbar(confUzRef, confMessageUz, setConfMessageUz);

  const allowedPlaceholderKeys = useMemo(
    () => {
      const dynamic = (broadcastPlaceholders || [])
        .map((p) => String(p.key || '').toLowerCase())
        .filter(Boolean);
      return new Set(dynamic.length > 0 ? dynamic : DEFAULT_BROADCAST_PLACEHOLDER_KEYS);
    },
    [broadcastPlaceholders]
  );

  const regularUnknownTokens = useMemo(() => {
    const unknown = new Set([
      ...extractUnknownTokens(message, allowedPlaceholderKeys),
      ...extractUnknownTokens(messageRu, allowedPlaceholderKeys),
      ...extractUnknownTokens(messageUz, allowedPlaceholderKeys),
    ]);
    return [...unknown];
  }, [message, messageRu, messageUz, allowedPlaceholderKeys]);

  const confirmationUnknownTokens = useMemo(() => {
    const unknown = new Set([
      ...extractUnknownTokens(confMessage, allowedPlaceholderKeys),
      ...extractUnknownTokens(confMessageRu, allowedPlaceholderKeys),
      ...extractUnknownTokens(confMessageUz, allowedPlaceholderKeys),
    ]);
    return [...unknown];
  }, [confMessage, confMessageRu, confMessageUz, allowedPlaceholderKeys]);

  useEffect(() => {
    (async () => {
      try {
        const [groups, placeholders] = await Promise.all([
          api.getGroupsManage(),
          api.getBroadcastPlaceholders(),
        ]);
        setDriverGroups(groups.filter(g => g.group_type === 'driver'));
        setBroadcastPlaceholders(Array.isArray(placeholders) ? placeholders : []);
      } catch (err) { console.error(err); }
    })();
    loadRegularHistory();
    loadConfHistory();
  }, []);

  const loadRegularHistory = async () => {
    setRegularHistoryLoading(true);
    try {
      const data = await api.getBroadcastHistory('regular');
      setRegularHistory(data);
    } catch (err) { console.error(err); }
    setRegularHistoryLoading(false);
  };

  const loadConfHistory = async () => {
    setConfHistoryLoading(true);
    try {
      const data = await api.getBroadcastHistory('confirmation');
      setConfHistory(data);
    } catch (err) { console.error(err); }
    setConfHistoryLoading(false);
  };

  const toggleRegularDeliveries = async (id) => {
    if (expandedRegularBroadcast === id) {
      setExpandedRegularBroadcast(null);
      return;
    }
    setExpandedRegularBroadcast(id);
    if (!regularDeliveries[id]) {
      try {
        const data = await api.getBroadcastDeliveries(id);
        setRegularDeliveries(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const toggleConfDeliveries = async (id) => {
    if (expandedConfBroadcast === id) {
      setExpandedConfBroadcast(null);
      return;
    }
    setExpandedConfBroadcast(id);
    if (!confDeliveries[id]) {
      try {
        const data = await api.getBroadcastDeliveries(id);
        setConfDeliveries(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const toggleConfClicks = async (id) => {
    if (expandedClicks === id) {
      setExpandedClicks(null);
      return;
    }
    setExpandedClicks(id);
    if (!confClicks[id]) {
      try {
        const data = await api.getConfirmationClicks(id);
        setConfClicks(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const getClickSummary = (clicks) => {
    const summary = {};
    clicks.forEach(c => {
      const label = c.button_label || `Button ${Number(c.button_index) + 1}`;
      summary[label] = (summary[label] || 0) + 1;
    });
    return Object.entries(summary);
  };

  const toggleDriverId = (id) => {
    setSelectedDriverIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleLanguage = (lang) => {
    setSelectedLanguages(prev => prev.includes(lang) ? prev.filter(x => x !== lang) : [...prev, lang]);
  };

  const insertTokenIntoEditor = (kind, token) => {
    const regularMap = {
      en: { ref: regTextareaRef, value: message, setter: setMessage },
      ru: { ref: regRuRef, value: messageRu, setter: setMessageRu },
      uz: { ref: regUzRef, value: messageUz, setter: setMessageUz },
    };
    const confirmationMap = {
      en: { ref: confTextareaRef, value: confMessage, setter: setConfMessage },
      ru: { ref: confRuRef, value: confMessageRu, setter: setConfMessageRu },
      uz: { ref: confUzRef, value: confMessageUz, setter: setConfMessageUz },
    };
    const map = kind === 'confirmation' ? confirmationMap : regularMap;
    const activeKey = kind === 'confirmation' ? activeConfirmationField : activeRegularField;
    const target = map[activeKey] || map.en;
    const el = target.ref.current;
    if (!el) {
      target.setter((prev) => `${prev || ''}${token}`);
      return;
    }
    const start = el.selectionStart ?? (target.value || '').length;
    const end = el.selectionEnd ?? (target.value || '').length;
    const next = `${target.value.slice(0, start)}${token}${target.value.slice(end)}`;
    target.setter(next);
    setTimeout(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  const handleAutoTranslate = async () => {
    if (!message.trim()) return;
    setTranslating(true);
    try {
      const { ru, uz } = await api.translateBroadcast(message);
      setMessageRu(ru);
      setMessageUz(uz);
    } catch (err) {
      setStatus({ type: 'error', text: 'Translation failed: ' + err.message });
    } finally {
      setTranslating(false);
    }
  };

  const handleConfAutoTranslate = async () => {
    if (!confMessage.trim()) return;
    setConfTranslating(true);
    try {
      const { ru, uz } = await api.translateBroadcast(confMessage);
      setConfMessageRu(ru);
      setConfMessageUz(uz);
    } catch (err) {
      setConfStatus({ type: 'error', text: 'Translation failed: ' + err.message });
    } finally {
      setConfTranslating(false);
    }
  };

  const handleConfAutoTranslateButtons = async () => {
    setConfBtnTranslating(true);
    try {
      const updated = await Promise.all(confirmationButtons.map(async btn => {
        if (!btn.label_en.trim()) return btn;
        const { ru, uz } = await api.translateBroadcast(btn.label_en);
        return { ...btn, label_ru: ru, label_uz: uz };
      }));
      setConfirmationButtons(updated);
    } catch (err) {
      setConfStatus({ type: 'error', text: 'Button translation failed: ' + err.message });
    } finally {
      setConfBtnTranslating(false);
    }
  };

  const addConfButton = () => setConfirmationButtons([...confirmationButtons, { label_en: '', label_ru: '', label_uz: '' }]);
  const removeConfButton = (i) => setConfirmationButtons(confirmationButtons.filter((_, idx) => idx !== i));
  const updateConfButton = (i, field, val) => {
    const updated = [...confirmationButtons];
    updated[i][field] = val;
    setConfirmationButtons(updated);
  };

  const normalizeMediaItems = (items) => (
    Array.isArray(items)
      ? items.flatMap((m) => (Array.isArray(m) ? m : [m])).filter(Boolean)
      : []
  );

  const weeklyDayOptions = [
    { value: '1', label: 'Monday' },
    { value: '2', label: 'Tuesday' },
    { value: '3', label: 'Wednesday' },
    { value: '4', label: 'Thursday' },
    { value: '5', label: 'Friday' },
    { value: '6', label: 'Saturday' },
    { value: '7', label: 'Sunday' },
  ];

  const clearRegularComposer = () => {
    setMessage('');
    setMessageRu('');
    setMessageUz('');
    setBroadcastMediaItems([]);
    setBroadcastMediaPosition('above');
    setScheduleType('one_time');
    setScheduledAtChicago('');
    setWeeklyDayOfWeek('1');
    setWeeklyTimeChicago('09:00');
  };

  const validateRegularTargeting = () => {
    if (targetType === 'specific_drivers' && selectedDriverIds.length === 0) {
      setStatus({ type: 'error', text: 'Please select at least one driver.' });
      return false;
    }
    if (targetType === 'language_groups' && selectedLanguages.length === 0) {
      setStatus({ type: 'error', text: 'Please select at least one language.' });
      return false;
    }
    return true;
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    if (regularUnknownTokens.length > 0) {
      setStatus({
        type: 'error',
        text: `Unknown placeholders: ${regularUnknownTokens.map((t) => `{${t}}`).join(', ')}`,
      });
      return;
    }
    if (!validateRegularTargeting()) return;

    setSending(true);
    setStatus(null);
    try {
      const result = await api.sendBroadcast({
        type: 'regular',
        messageEn: message,
        messageRu,
        messageUz,
        forceLanguage,
        targetType,
        targetActiveFilter,
        selectedDriverIds,
        selectedLanguages,
        mediaItems: normalizeMediaItems(broadcastMediaItems),
        mediaPosition: broadcastMediaPosition,
      });
      setStatus({ type: 'success', text: `Broadcast sent! Sent: ${result.sent}, Failed: ${result.failed}` });
      clearRegularComposer();
      loadRegularHistory();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  };

  const handleTest = async () => {
    if (!message.trim()) return;
    if (regularUnknownTokens.length > 0) {
      setStatus({
        type: 'error',
        text: `Unknown placeholders: ${regularUnknownTokens.map((t) => `{${t}}`).join(', ')}`,
      });
      return;
    }
    setTesting(true);
    setStatus(null);
    try {
      await api.testBroadcast({
        type: 'regular',
        messageEn: message,
        messageRu,
        messageUz,
        forceLanguage,
        mediaItems: normalizeMediaItems(broadcastMediaItems),
        mediaPosition: broadcastMediaPosition,
      });
      setStatus({ type: 'success', text: 'Test broadcast sent to the management group.' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSchedule = async () => {
    if (!message.trim()) return;
    if (regularUnknownTokens.length > 0) {
      setStatus({
        type: 'error',
        text: `Unknown placeholders: ${regularUnknownTokens.map((t) => `{${t}}`).join(', ')}`,
      });
      return;
    }
    if (!validateRegularTargeting()) return;
    if (scheduleType === 'one_time' && !scheduledAtChicago) {
      return setStatus({ type: 'error', text: 'Please choose a Central Time date and time.' });
    }
    if (scheduleType === 'weekly' && (!weeklyDayOfWeek || !weeklyTimeChicago)) {
      return setStatus({ type: 'error', text: 'Please choose a weekday and time for the recurring schedule.' });
    }

    setScheduling(true);
    setStatus(null);
    try {
      const result = await api.createScheduledMessage({
        messageEn: message,
        messageRu,
        messageUz,
        forceLanguage,
        targetType,
        targetActiveFilter,
        selectedDriverIds,
        selectedLanguages,
        mediaItems: normalizeMediaItems(broadcastMediaItems),
        mediaPosition: broadcastMediaPosition,
        scheduleType,
        scheduledAtChicago,
        weeklyDayOfWeek: Number(weeklyDayOfWeek),
        weeklyTimeChicago,
        scheduleTimezone: 'America/Chicago',
      });

      const successText = scheduleType === 'weekly'
        ? `Recurring schedule saved. Next run: ${result.scheduled_at_chicago}.`
        : `Message scheduled for ${result.scheduled_at_chicago} Central.`;
      setStatus({ type: 'success', text: successText });
      clearRegularComposer();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setScheduling(false);
    }
  };

  const handleConfSend = async () => {
    if (!confMessage.trim()) return;
    if (confirmationUnknownTokens.length > 0) {
      setConfStatus({
        type: 'error',
        text: `Unknown placeholders: ${confirmationUnknownTokens.map((t) => `{${t}}`).join(', ')}`,
      });
      return;
    }
    if (targetType === 'specific_drivers' && selectedDriverIds.length === 0) {
      return setConfStatus({ type: 'error', text: 'Please select at least one driver.' });
    }
    if (targetType === 'language_groups' && selectedLanguages.length === 0) {
      return setConfStatus({ type: 'error', text: 'Please select at least one language.' });
    }
    setConfSending(true);
    setConfStatus(null);
    try {
      const result = await api.sendBroadcast({
        type: 'confirmation',
        messageEn: confMessage,
        messageRu: confMessageRu,
        messageUz: confMessageUz,
        buttons: confirmationButtons,
        mediaItems: normalizeMediaItems(confMediaItems),
        mediaPosition: confMediaPosition,
        targetType,
        targetActiveFilter,
        selectedDriverIds,
        selectedLanguages,
        forceLanguage,
      });
      setConfStatus({ type: 'success', text: `Confirmation broadcast sent! Sent: ${result.sent}, Failed: ${result.failed}` });
      setConfMessage(''); setConfMessageRu(''); setConfMessageUz('');
      setConfMediaItems([]);
      loadConfHistory();
    } catch (err) {
      setConfStatus({ type: 'error', text: err.message });
    } finally {
      setConfSending(false);
    }
  };

  const handleConfTest = async () => {
    if (!confMessage.trim()) return;
    if (confirmationUnknownTokens.length > 0) {
      setConfStatus({
        type: 'error',
        text: `Unknown placeholders: ${confirmationUnknownTokens.map((t) => `{${t}}`).join(', ')}`,
      });
      return;
    }
    setConfTesting(true);
    setConfStatus(null);
    try {
      await api.testBroadcast({
        type: 'confirmation',
        messageEn: confMessage,
        messageRu: confMessageRu,
        messageUz: confMessageUz,
        buttons: confirmationButtons,
        mediaItems: normalizeMediaItems(confMediaItems),
        mediaPosition: confMediaPosition,
        forceLanguage,
      });
      setConfStatus({ type: 'success', text: 'Test confirmation sent to the management group.' });
    } catch (err) {
      setConfStatus({ type: 'error', text: err.message });
    } finally {
      setConfTesting(false);
    }
  };

  const formatDate = (d) => new Date(d).toLocaleString();
  const truncate = (s, n) => s?.length > n ? s.substring(0, n) + '...' : s;

  return (
    <div>
      <div className="page-header">
        <h2>📢 Broadcast Center</h2>
        <p>Send messages and media to multiple driver groups</p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
        <button className={`nav-item ${broadcastTab === 'regular' ? 'active' : ''}`} onClick={() => setBroadcastTab('regular')} style={{ padding: '8px 20px', fontSize: 14 }}>Regular Broadcast</button>
        <button className={`nav-item ${broadcastTab === 'confirmation' ? 'active' : ''}`} onClick={() => setBroadcastTab('confirmation')} style={{ padding: '8px 20px', fontSize: 14 }}>Confirmation (Buttons)</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>🎯 Audience &amp; language</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Force Language:</label>
            <select className="form-input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }} value={forceLanguage || ''} onChange={(e) => setForceLanguage(e.target.value || null)}>
              <option value="">🔄 Auto (Group Default)</option>
              <option value="en">🇺🇸 EN</option>
              <option value="ru">🇷🇺 RU</option>
              <option value="uz">🇺🇿 UZ</option>
            </select>
          </div>
        </div>
        <details className="collapse-panel">
          <summary>Target groups</summary>
          <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="target" value="all" checked={targetType === 'all'} onChange={() => setTargetType('all')} style={{ accentColor: 'var(--accent)' }} />
                All Groups
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="target" value="specific_drivers" checked={targetType === 'specific_drivers'} onChange={() => setTargetType('specific_drivers')} style={{ accentColor: 'var(--accent)' }} />
                Specific Drivers
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="target" value="language_groups" checked={targetType === 'language_groups'} onChange={() => setTargetType('language_groups')} style={{ accentColor: 'var(--accent)' }} />
                By Language
              </label>
            </div>

            {targetType === 'specific_drivers' && (
              <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)', padding: 8, marginBottom: 8 }}>
                {driverGroups.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>No driver groups found.</p> : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, paddingRight: 8 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                        if (selectedDriverIds.length === driverGroups.length) {
                          setSelectedDriverIds([]);
                        } else {
                          setSelectedDriverIds(driverGroups.map(g => g.id));
                        }
                      }} style={{ padding: '4px 8px', fontSize: 11 }}>
                        {selectedDriverIds.length === driverGroups.length ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                    {driverGroups.map(g => (
                      <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}>
                        <input type="checkbox" checked={selectedDriverIds.includes(g.id)} onChange={() => toggleDriverId(g.id)} style={{ accentColor: 'var(--accent)' }} />
                        <span style={{ fontWeight: 600 }}>{g.group_name || 'Unknown'}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          ({g.language?.toUpperCase()}) {g.active === false ? '(Inactive)' : '(Active)'}
                        </span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            )}

            {targetType === 'language_groups' && (
              <div style={{ display: 'flex', gap: 12, marginBottom: 0, flexWrap: 'wrap' }}>
                {['en', 'ru', 'uz'].map(l => (
                  <label key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', background: 'var(--bg-primary)', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                    <input type="checkbox" checked={selectedLanguages.includes(l)} onChange={() => toggleLanguage(l)} style={{ accentColor: 'var(--accent)' }} />
                    {l.toUpperCase()}
                  </label>
                ))}
              </div>
            )}

            {(targetType === 'all' || targetType === 'language_groups') && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>Driver status</p>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {[
                    { value: 'all', label: 'All' },
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                  ].map((opt) => (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="target_active_filter"
                        value={opt.value}
                        checked={targetActiveFilter === opt.value}
                        onChange={() => setTargetActiveFilter(opt.value)}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      </div>

      {/* ════════ TAB 1: REGULAR ════════ */}
      {broadcastTab === 'regular' && (
        <div>
          {status && <div className={`alert alert-${status.type}`}>{status.type === 'success' ? '✅' : '⚠️'} {status.text}</div>}

          <div className="broadcast-layout">
            <div className="broadcast-editor-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>✍️ Compose Message</h3>

                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>
                <PlaceholderChips
                  placeholders={broadcastPlaceholders}
                  onInsert={(token) => insertTokenIntoEditor('regular', token)}
                />
                {regularUnknownTokens.length > 0 && (
                  <div className="alert alert-error" style={{ marginBottom: 12 }}>
                    Unknown placeholders: {regularUnknownTokens.map((t) => `{${t}}`).join(', ')}
                  </div>
                )}

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
                {regFmt.toolbar}
                <textarea ref={regTextareaRef} className="form-textarea toolbar-textarea" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={regFmt.handleKeyDown}
                  onFocus={() => setActiveRegularField('en')}
                  placeholder="Type your message here..." style={{ minHeight: 140, resize: 'vertical' }} />
                <div className={`char-count ${message.length > 4096 ? 'over-limit' : ''}`}>{message.length} / 4096</div>

                <button type="button" className="btn btn-ghost" onClick={handleAutoTranslate} disabled={translating || !message.trim()}
                  style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {translating ? '⏳ Translating...' : '🌐 Auto Translate'}
                </button>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
                {regFmtRu.toolbar}
                <textarea ref={regRuRef} className="form-textarea toolbar-textarea" value={messageRu} onChange={(e) => setMessageRu(e.target.value)} onKeyDown={regFmtRu.handleKeyDown}
                  onFocus={() => setActiveRegularField('ru')}
                  placeholder="Сообщение на русском (авто-перевод или ручной ввод)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
                {regFmtUz.toolbar}
                <textarea ref={regUzRef} className="form-textarea toolbar-textarea" value={messageUz} onChange={(e) => setMessageUz(e.target.value)} onKeyDown={regFmtUz.handleKeyDown}
                  onFocus={() => setActiveRegularField('uz')}
                  placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />

                <details className="collapse-panel" style={{ marginTop: 16 }}>
                  <summary>📎 Media Attachments</summary>
                  <div style={{ marginTop: 12 }}>
                    <MediaUploader items={broadcastMediaItems} onAdd={(newItems) => setBroadcastMediaItems(prev => [...prev, ...newItems])} onRemove={(index) => setBroadcastMediaItems(prev => prev.filter((_, i) => i !== index))} />
                    {broadcastMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="broadcast-media-position" position={broadcastMediaPosition} onChange={setBroadcastMediaPosition} /></div>}
                  </div>
                </details>

                <div className="card" style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Schedule This Broadcast</h3>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                        Schedule once or repeat weekly in America/Chicago.
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="regular-schedule-type" checked={scheduleType === 'one_time'} onChange={() => setScheduleType('one_time')} />
                        One time
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="regular-schedule-type" checked={scheduleType === 'weekly'} onChange={() => setScheduleType('weekly')} />
                        Weekly recurring
                      </label>
                    </div>
                  </div>

                  {scheduleType === 'one_time' ? (
                    <div style={{ marginTop: 16 }}>
                      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                        Date &amp; time (Central)
                      </label>
                      <input
                        type="datetime-local"
                        className="form-input"
                        value={scheduledAtChicago}
                        onChange={(e) => setScheduledAtChicago(e.target.value)}
                      />
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, marginTop: 16 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Day of week
                        </label>
                        <select className="form-input" value={weeklyDayOfWeek} onChange={(e) => setWeeklyDayOfWeek(e.target.value)}>
                          {weeklyDayOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Time (Central)
                        </label>
                        <input
                          type="time"
                          className="form-input"
                          value={weeklyTimeChicago}
                          onChange={(e) => setWeeklyTimeChicago(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                  <button className="btn btn-primary" onClick={handleSend} disabled={sending || !message.trim() || message.length > 4096 || regularUnknownTokens.length > 0}>
                    {sending ? '⏳ Sending...' : targetType === 'all' ? '📤 Send to All Groups' : '📤 Send to Selected'}
                  </button>
                  <button className="btn btn-ghost" onClick={handleTest} disabled={testing || !message.trim() || regularUnknownTokens.length > 0} style={{ border: '1px solid var(--border)' }}>
                    {testing ? '⏳ Testing...' : '🧪 Test (Management Group)'}
                  </button>
                  <button className="btn btn-ghost" onClick={handleSchedule} disabled={scheduling || !message.trim() || message.length > 4096 || regularUnknownTokens.length > 0} style={{ border: '1px solid var(--border)' }}>
                    {scheduling ? 'Scheduling...' : 'Save Schedule'}
                  </button>
                </div>
              </div>
            </div>

            <div className="broadcast-preview-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>📱 Live Preview</h3>
                <TelegramPreview label="How it will look in Telegram" text={message}
                  langTabs={{
                    en: { text: message },
                    ru: { text: messageRu || message },
                    uz: { text: messageUz || message },
                  }}
                  mediaItems={broadcastMediaItems} mediaPosition={broadcastMediaPosition} />
              </div>
            </div>
          </div>

          {/* ─── Regular Broadcast History ─── */}
          <div className="card broadcast-history" style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>📋 Broadcast History</h3>
              <button type="button" className="btn btn-ghost" onClick={loadRegularHistory} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>🔄 Refresh</button>
            </div>
            {regularHistoryLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
              : regularHistory.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No broadcasts sent yet.</div>
              : regularHistory.map(b => (
                <div key={b.id} className="broadcast-history-item">
                  <div className="broadcast-history-header" onClick={() => toggleRegularDeliveries(b.id)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{formatDate(b.created_at)}</span>
                      <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{truncate(b.message_text_en, 60)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>✅ {b.sent_count || 0}</span>
                      {Number(b.failed_count) > 0 && <span className="badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>❌ {b.failed_count}</span>}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandedRegularBroadcast === b.id ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {expandedRegularBroadcast === b.id && (
                    <div className="delivery-list">
                      {(regularDeliveries[b.id] || []).length === 0
                        ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No delivery data.</div>
                        : (regularDeliveries[b.id] || []).map(d => (
                          <div key={d.id} className="delivery-row">
                            <span style={{ fontSize: 13 }}>{d.group_name || `Group ${d.telegram_group_id}`}</span>
                            <span className={`delivery-badge ${d.status === 'sent' ? 'sent' : 'failed'}`}>{d.status === 'sent' ? '✅ Sent' : '❌ Failed'}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ════════ TAB 2: CONFIRMATION ════════ */}
      {broadcastTab === 'confirmation' && (
        <div>
          {confStatus && <div className={`alert alert-${confStatus.type}`}>{confStatus.type === 'success' ? '✅' : '⚠️'} {confStatus.text}</div>}

          <div className="broadcast-layout">
            <div className="broadcast-editor-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>✍️ Compose Message</h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the toolbar to format text with Telegram-compatible HTML tags.</p>
                <PlaceholderChips
                  placeholders={broadcastPlaceholders}
                  onInsert={(token) => insertTokenIntoEditor('confirmation', token)}
                />
                {confirmationUnknownTokens.length > 0 && (
                  <div className="alert alert-error" style={{ marginBottom: 12 }}>
                    Unknown placeholders: {confirmationUnknownTokens.map((t) => `{${t}}`).join(', ')}
                  </div>
                )}

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-en">EN</span> English</h4>
                {confFmt.toolbar}
                <textarea ref={confTextareaRef} className="form-textarea toolbar-textarea" value={confMessage} onChange={(e) => setConfMessage(e.target.value)} onKeyDown={confFmt.handleKeyDown}
                  onFocus={() => setActiveConfirmationField('en')}
                  placeholder="Type your confirmation message here..." style={{ minHeight: 140, resize: 'vertical' }} />
                <div className={`char-count ${confMessage.length > 4096 ? 'over-limit' : ''}`}>{confMessage.length} / 4096</div>

                <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslate} disabled={confTranslating || !confMessage.trim()}
                  style={{ marginTop: 12, marginBottom: 16, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {confTranslating ? '⏳ Translating...' : '🌐 Auto Translate'}
                </button>

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-ru">RU</span> Russian</h4>
                {confFmtRu.toolbar}
                <textarea ref={confRuRef} className="form-textarea toolbar-textarea" value={confMessageRu} onChange={(e) => setConfMessageRu(e.target.value)} onKeyDown={confFmtRu.handleKeyDown}
                  onFocus={() => setActiveConfirmationField('ru')}
                  placeholder="Сообщение на русском (авто-перевод или ручной ввод)" style={{ minHeight: 100, resize: 'vertical', marginBottom: 12 }} />

                <h4 style={{ marginBottom: 6 }}><span className="badge badge-uz">UZ</span> Uzbek</h4>
                {confFmtUz.toolbar}
                <textarea ref={confUzRef} className="form-textarea toolbar-textarea" value={confMessageUz} onChange={(e) => setConfMessageUz(e.target.value)} onKeyDown={confFmtUz.handleKeyDown}
                  onFocus={() => setActiveConfirmationField('uz')}
                  placeholder="O'zbek tilidagi xabar (avto-tarjima yoki qo'lda kiritish)" style={{ minHeight: 100, resize: 'vertical' }} />

                <div style={{ marginTop: 16 }}>
                  <MediaUploader items={confMediaItems} onAdd={(newItems) => setConfMediaItems(prev => [...prev, ...newItems])} onRemove={(index) => setConfMediaItems(prev => prev.filter((_, i) => i !== index))} />
                  {confMediaItems.length > 0 && <div style={{ marginTop: 16 }}><MediaPositionSelector name="conf-media-position" position={confMediaPosition} onChange={setConfMediaPosition} /></div>}
                </div>

                {/* ─── Inline Buttons Builder ─── */}
                <div className="card button-builder" style={{ marginTop: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 600 }}>🔘 Inline Buttons</h3>
                    <button type="button" className="btn btn-ghost" onClick={handleConfAutoTranslateButtons} disabled={confBtnTranslating} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>
                      {confBtnTranslating ? '⏳' : '🌐'} Auto-translate Labels
                    </button>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Add buttons drivers can click. At least 1 button required to send.</p>
                  {confirmationButtons.map((btn, i) => (
                    <div key={i} className="button-builder-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', minWidth: 60 }}>Button {i + 1}</span>
                        {confirmationButtons.length > 1 && <button type="button" className="btn btn-danger btn-sm" onClick={() => removeConfButton(i)} style={{ marginLeft: 'auto' }}>✕</button>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>🇺🇸 EN</label>
                          <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_en} onChange={(e) => updateConfButton(i, 'label_en', e.target.value)} placeholder="Yes / Confirm" />
                        </div>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>🇷🇺 RU</label>
                          <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_ru} onChange={(e) => updateConfButton(i, 'label_ru', e.target.value)} placeholder="Да / Подтвердить" />
                        </div>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>🇺🇿 UZ</label>
                          <input className="form-input" style={{ width: '100%', fontSize: 13 }} value={btn.label_uz} onChange={(e) => updateConfButton(i, 'label_uz', e.target.value)} placeholder="Ha / Tasdiqlash" />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn btn-ghost" onClick={addConfButton} style={{ marginTop: 8, fontSize: 13, border: '1px dashed var(--border)' }}>
                    ➕ Add Button
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={handleConfSend} disabled={confSending || !confMessage.trim() || confMessage.length > 4096 || confirmationUnknownTokens.length > 0}>
                    {confSending ? '⏳ Sending...' : '📤 Send Broadcast'}
                  </button>
                  <button className="btn btn-ghost" onClick={handleConfTest} disabled={confTesting || !confMessage.trim() || confirmationUnknownTokens.length > 0} style={{ border: '1px solid var(--border)' }}>
                    {confTesting ? '⏳ Testing...' : '🧪 Test'}
                  </button>
                </div>
              </div>
            </div>

            <div className="broadcast-preview-section">
              <div className="card">
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>📱 Live Preview</h3>
                <TelegramPreview label="How it will look in Telegram" text={confMessage}
                  langTabs={{
                    en: { text: confMessage, buttons: confirmationButtons.map(b => b.label_en).filter(Boolean) },
                    ru: { text: confMessageRu, buttons: confirmationButtons.map(b => b.label_ru || b.label_en).filter(Boolean) },
                    uz: { text: confMessageUz, buttons: confirmationButtons.map(b => b.label_uz || b.label_en).filter(Boolean) },
                  }}
                  mediaItems={confMediaItems} mediaPosition={confMediaPosition} />
              </div>
            </div>
          </div>

          {/* ─── Confirmation Broadcast History ─── */}
          <div className="card broadcast-history" style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>📋 Broadcast History</h3>
              <button type="button" className="btn btn-ghost" onClick={loadConfHistory} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>🔄 Refresh</button>
            </div>
            {confHistoryLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
              : confHistory.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No confirmation broadcasts sent yet.</div>
              : confHistory.map(b => (
                <div key={b.id} className="broadcast-history-item">
                  <div className="broadcast-history-header" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => toggleConfDeliveries(b.id)}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{formatDate(b.created_at)}</span>
                      <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>{truncate(b.message_text_en, 60)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>✅ {b.sent_count || 0}</span>
                      {Number(b.failed_count) > 0 && <span className="badge" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>❌ {b.failed_count}</span>}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandedConfBroadcast === b.id ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {expandedConfBroadcast === b.id && (
                    <div>
                      <div className="delivery-list">
                        {(confDeliveries[b.id] || []).length === 0
                          ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No delivery data.</div>
                          : (confDeliveries[b.id] || []).map(d => (
                            <div key={d.id} className="delivery-row">
                              <span style={{ fontSize: 13 }}>{d.group_name || `Group ${d.telegram_group_id}`}</span>
                              <span className={`delivery-badge ${d.status === 'sent' ? 'sent' : 'failed'}`}>{d.status === 'sent' ? '✅ Sent' : '❌ Failed'}</span>
                            </div>
                          ))}
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <button type="button" className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); toggleConfClicks(b.id); }} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid var(--border)' }}>
                          {expandedClicks === b.id ? '▲ Hide' : '📊 Show'} Click Tracking
                        </button>
                        {expandedClicks === b.id && (
                          <div className="click-tracking-table" style={{ marginTop: 10 }}>
                            {(confClicks[b.id] || []).length === 0
                              ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>No clicks recorded yet.</div>
                              : (
                                <>
                                  <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {getClickSummary(confClicks[b.id]).map(([k, v]) => (
                                      <span key={k} className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>{k}: {v} click{v !== 1 ? 's' : ''}</span>
                                    ))}
                                  </div>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                    <thead>
                                      <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                                        <th style={{ textAlign: 'left', padding: '6px 8px' }}>Driver</th>
                                        <th style={{ textAlign: 'left', padding: '6px 8px' }}>Group</th>
                                        <th style={{ textAlign: 'left', padding: '6px 8px' }}>Button</th>
                                        <th style={{ textAlign: 'left', padding: '6px 8px' }}>Time</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(confClicks[b.id] || []).map(c => (
                                        <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                          <td style={{ padding: '6px 8px' }}>{c.driver_username ? `@${c.driver_username}` : `${c.driver_first_name || ''} ${c.driver_last_name || ''}`.trim() || c.driver_telegram_id}</td>
                                          <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{c.group_name || '-'}</td>
                                          <td style={{ padding: '6px 8px' }}><span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>Button {c.button_index + 1}</span></td>
                                          <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{formatDate(c.clicked_at)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </>
                              )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────── Employee Voting Page ───────────────
