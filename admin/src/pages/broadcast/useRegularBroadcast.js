import { useState, useRef, useMemo } from "react";
import * as api from "../../api";
import { useFormattingToolbar } from "../../components/Shared";
import { translateErrorText, normalizeMediaItems } from "./composerHelpers";

/**
 * The regular-broadcast composer: three language variants, media, force-language,
 * and the send / test / schedule actions.
 *
 * THREE GUARDS RUN BEFORE EVERY ACTION, in this order, and none may be skipped:
 *   1. something to send (text or at least one media item);
 *   2. no unknown placeholder tokens — an unrecognised {token} would reach
 *      drivers as literal text and cannot be recalled;
 *   3. a non-empty audience (delegated to useBroadcastTargeting).
 *
 * "Test" sends to the management group only and therefore skips the audience
 * check — it is the safe rehearsal for the other two.
 *
 * A successful send or schedule clears the composer so the same message cannot
 * be sent twice by a second click.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function useRegularBroadcast({ targeting, onSent }) {
  const [message, setMessage] = useState('');
  const [messageRu, setMessageRu] = useState('');
  const [messageUz, setMessageUz] = useState('');
  const [mediaItems, setMediaItems] = useState([]);
  const [mediaPosition, setMediaPosition] = useState('above');
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [status, setStatus] = useState(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleType, setScheduleType] = useState('one_time');
  const [scheduledAtChicago, setScheduledAtChicago] = useState('');
  const [weeklyDayOfWeek, setWeeklyDayOfWeek] = useState('1');
  const [weeklyTimeChicago, setWeeklyTimeChicago] = useState('09:00');
  const [activeField, setActiveField] = useState('en');

  const enRef = useRef(null);
  const ruRef = useRef(null);
  const uzRef = useRef(null);

  const fmt = useFormattingToolbar(enRef, message, setMessage);
  const fmtRu = useFormattingToolbar(ruRef, messageRu, setMessageRu);
  const fmtUz = useFormattingToolbar(uzRef, messageUz, setMessageUz);

  const unknownTokens = useMemo(
    () => targeting.unknownTokensIn(message, messageRu, messageUz),
    [message, messageRu, messageUz, targeting.allowedPlaceholderKeys],
  );

  const editors = {
    en: { ref: enRef, value: message, setter: setMessage },
    ru: { ref: ruRef, value: messageRu, setter: setMessageRu },
    uz: { ref: uzRef, value: messageUz, setter: setMessageUz },
  };

  const clearComposer = () => {
    setMessage('');
    setMessageRu('');
    setMessageUz('');
    setMediaItems([]);
    setMediaPosition('above');
    setScheduleType('one_time');
    setScheduledAtChicago('');
    setWeeklyDayOfWeek('1');
    setWeeklyTimeChicago('09:00');
  };

  /** Guards 1 and 2. `verb` only shapes the message an admin reads. */
  const hasSendableContent = (verb) => {
    if (!message.trim() && mediaItems.length === 0) {
      setStatus({ type: 'error', text: `Add a message or at least one photo/video before ${verb}.` });
      return false;
    }
    if (unknownTokens.length > 0) {
      setStatus({
        type: 'error',
        text: `Unknown placeholders: ${unknownTokens.map((t) => `{${t}}`).join(', ')}`,
      });
      return false;
    }
    return true;
  };

  const content = () => ({
    messageEn: message,
    messageRu,
    messageUz,
    forceLanguage: targeting.forceLanguage,
    mediaItems: normalizeMediaItems(mediaItems),
    mediaPosition,
  });

  const handleAutoTranslate = async () => {
    if (!message.trim()) return;
    setTranslating(true);
    try {
      const { ru, uz } = await api.translateBroadcast(message);
      setMessageRu(ru);
      setMessageUz(uz);
    } catch (err) {
      setStatus({ type: 'error', text: translateErrorText(err, 'Translation failed') });
    } finally {
      setTranslating(false);
    }
  };

  const handleSend = async () => {
    if (!hasSendableContent('sending')) return;
    if (!targeting.validateTargeting(setStatus)) return;

    setSending(true);
    setStatus(null);
    try {
      const result = await api.sendBroadcast({
        type: 'regular', ...content(), ...targeting.targetPayload,
      });
      setStatus({ type: 'success', text: `Broadcast sent! Sent: ${result.sent}, Failed: ${result.failed}` });
      clearComposer();
      onSent();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  };

  // Management group only — no audience check, by design.
  const handleTest = async () => {
    if (!hasSendableContent('testing')) return;
    setTesting(true);
    setStatus(null);
    try {
      await api.testBroadcast({ type: 'regular', ...content() });
      setStatus({ type: 'success', text: 'Test broadcast sent to the management group.' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSchedule = async () => {
    if (!hasSendableContent('scheduling')) return;
    if (!targeting.validateTargeting(setStatus)) return;
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
        ...content(),
        ...targeting.targetPayload,
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
      clearComposer();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setScheduling(false);
    }
  };

  return {
    message, setMessage, messageRu, setMessageRu, messageUz, setMessageUz,
    mediaItems, setMediaItems,
    mediaPosition, setMediaPosition,
    sending, testing, translating, scheduling, status,
    scheduleType, setScheduleType, scheduledAtChicago, setScheduledAtChicago,
    weeklyDayOfWeek, setWeeklyDayOfWeek, weeklyTimeChicago, setWeeklyTimeChicago,
    activeField, setActiveField, editors,
    enRef, ruRef, uzRef, fmt, fmtRu, fmtUz,
    unknownTokens, handleAutoTranslate, handleSend, handleTest, handleSchedule,
  };
}
