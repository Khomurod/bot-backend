import { useState, useEffect, useMemo } from "react";
import * as api from "../../api";
import { DEFAULT_BROADCAST_PLACEHOLDER_KEYS, extractUnknownTokens } from "./templateTokens";

/**
 * WHO a broadcast goes to, and which placeholder tokens are legal in it.
 *
 * Both composers share this hook: the audience is chosen once at the top of the
 * page and applies to whichever tab is sending, so duplicating the selection
 * per tab would let an admin pick drivers on one tab and send from the other.
 *
 * `validateTargeting` refuses an empty selection rather than falling back to
 * "everyone" — a mis-click that broadcasts to the whole fleet is not
 * recoverable.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function useBroadcastTargeting() {
  const [targetType, setTargetType] = useState('all'); // 'all' | 'specific_drivers' | 'language_groups'
  const [targetActiveFilter, setTargetActiveFilter] = useState('active'); // 'all' | 'active' | 'inactive'
  const [selectedDriverIds, setSelectedDriverIds] = useState([]);
  const [selectedLanguages, setSelectedLanguages] = useState([]);
  const [driverGroups, setDriverGroups] = useState([]);
  const [broadcastPlaceholders, setBroadcastPlaceholders] = useState([]);
  // One control, in the targeting section, honoured by BOTH tabs' send, test
  // and schedule payloads — so it lives here rather than in either composer.
  const [forceLanguage, setForceLanguage] = useState(null);

  const allowedPlaceholderKeys = useMemo(
    () => {
      const dynamic = (broadcastPlaceholders || [])
        .map((p) => String(p.key || '').toLowerCase())
        .filter(Boolean);
      return new Set(dynamic.length > 0 ? dynamic : DEFAULT_BROADCAST_PLACEHOLDER_KEYS);
    },
    [broadcastPlaceholders]
  );

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
  }, []);

  const toggleDriverId = (id) => {
    setSelectedDriverIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleLanguage = (lang) => {
    setSelectedLanguages(prev => prev.includes(lang) ? prev.filter(x => x !== lang) : [...prev, lang]);
  };

  /** Unknown tokens across the three language variants of one composer. */
  const unknownTokensIn = (...texts) => [...new Set(
    texts.flatMap((t) => extractUnknownTokens(t, allowedPlaceholderKeys)),
  )];

  /**
   * Refuse a send whose audience is empty. Reports through the calling
   * composer's own status setter so the message appears next to its send button.
   */
  const validateTargeting = (setStatus) => {
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

  /** The audience fields every send/test/schedule payload carries. */
  const targetPayload = {
    targetType, targetActiveFilter, selectedDriverIds, selectedLanguages,
  };

  return {
    targetType, setTargetType, targetActiveFilter, setTargetActiveFilter,
    selectedDriverIds, selectedLanguages, driverGroups, broadcastPlaceholders,
    forceLanguage, setForceLanguage,
    allowedPlaceholderKeys, unknownTokensIn, toggleDriverId, toggleLanguage,
    validateTargeting, targetPayload,
  };
}
