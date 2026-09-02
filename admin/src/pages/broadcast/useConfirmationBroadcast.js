import { useState, useRef, useMemo } from "react";
import * as api from "../../api";
import { useFormattingToolbar } from "../../components/Shared";
import { translateErrorText, normalizeMediaItems } from "./composerHelpers";

/**
 * The confirmation-broadcast composer: three language variants, media, and the
 * inline keyboard whose buttons drivers tap.
 *
 * DELIBERATELY STRICTER THAN THE REGULAR COMPOSER: it requires message TEXT,
 * where a regular broadcast may be media-only. A confirmation is a question
 * with buttons attached, and buttons under a bare photo give a driver nothing
 * to answer.
 *
 * Button labels translate as a batch, each row independently, and a row with no
 * English label is left untouched rather than translated to empty strings.
 *
 * "Test" sends to the management group only and skips the audience check.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function useConfirmationBroadcast({ targeting, onSent }) {
  const [message, setMessage] = useState('');
  const [messageRu, setMessageRu] = useState('');
  const [messageUz, setMessageUz] = useState('');
  const [mediaItems, setMediaItems] = useState([]);
  const [mediaPosition, setMediaPosition] = useState('above');
  const [buttons, setButtons] = useState([{ label_en: 'Yes', label_ru: 'Да', label_uz: 'Ha' }]);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [btnTranslating, setBtnTranslating] = useState(false);
  const [status, setStatus] = useState(null);
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

  const addButton = () => setButtons([...buttons, { label_en: '', label_ru: '', label_uz: '' }]);
  const removeButton = (i) => setButtons(buttons.filter((_, idx) => idx !== i));
  const updateButton = (i, field, val) => {
    const updated = [...buttons];
    updated[i][field] = val;
    setButtons(updated);
  };

  /** Text is required here (unlike a regular broadcast), then token validation. */
  const hasSendableContent = () => {
    if (!message.trim()) return false;
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
    type: 'confirmation',
    messageEn: message,
    messageRu,
    messageUz,
    buttons,
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

  const handleAutoTranslateButtons = async () => {
    setBtnTranslating(true);
    try {
      const updated = await Promise.all(buttons.map(async (btn) => {
        // No English label: nothing to translate from, so leave the row alone.
        if (!btn.label_en.trim()) return btn;
        const { ru, uz } = await api.translateBroadcast(btn.label_en);
        return { ...btn, label_ru: ru, label_uz: uz };
      }));
      setButtons(updated);
    } catch (err) {
      setStatus({ type: 'error', text: translateErrorText(err, 'Button translation failed') });
    } finally {
      setBtnTranslating(false);
    }
  };

  const handleSend = async () => {
    if (!hasSendableContent()) return;
    if (!targeting.validateTargeting(setStatus)) return;
    setSending(true);
    setStatus(null);
    try {
      const result = await api.sendBroadcast({
        ...content(),
        ...targeting.targetPayload,
        forceLanguage: targeting.forceLanguage,
      });
      setStatus({ type: 'success', text: `Confirmation broadcast sent! Sent: ${result.sent}, Failed: ${result.failed}` });
      setMessage(''); setMessageRu(''); setMessageUz('');
      setMediaItems([]);
      onSent();
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  };

  // Management group only — no audience check, by design.
  const handleTest = async () => {
    if (!hasSendableContent()) return;
    setTesting(true);
    setStatus(null);
    try {
      await api.testBroadcast({ ...content(), forceLanguage: targeting.forceLanguage });
      setStatus({ type: 'success', text: 'Test confirmation sent to the management group.' });
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  return {
    message, setMessage, messageRu, setMessageRu, messageUz, setMessageUz,
    mediaItems, setMediaItems, mediaPosition, setMediaPosition,
    buttons, addButton, removeButton, updateButton,
    sending, testing, translating, btnTranslating, status,
    activeField, setActiveField, editors,
    enRef, ruRef, uzRef, fmt, fmtRu, fmtUz,
    unknownTokens, handleAutoTranslate, handleAutoTranslateButtons,
    handleSend, handleTest,
  };
}
