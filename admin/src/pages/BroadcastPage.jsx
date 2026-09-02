import React, { useState } from "react";
import { useBroadcastTargeting } from "./broadcast/useBroadcastTargeting";
import { useBroadcastHistory } from "./broadcast/useBroadcastHistory";
import { useRegularBroadcast } from "./broadcast/useRegularBroadcast";
import { useConfirmationBroadcast } from "./broadcast/useConfirmationBroadcast";
import { TargetingSection } from "./broadcast/TargetingSection";
import { RegularBroadcastTab } from "./broadcast/RegularBroadcastTab";
import { ConfirmationBroadcastTab } from "./broadcast/ConfirmationBroadcastTab";
import { SendConfirmDialog } from "./broadcast/SendConfirmDialog";

/**
 * Broadcast Center — page container.
 *
 * LAYOUT AND WIRING ONLY:
 *
 *   broadcast/templateTokens.js           placeholder-token validation (pure)
 *   broadcast/composerHelpers.js          media/schedule/format helpers (pure)
 *   broadcast/useBroadcastTargeting.js    the SHARED audience + force-language
 *   broadcast/useBroadcastHistory.js      one instance per tab, lazy + cached
 *   broadcast/useRegularBroadcast.js      announcement: send / test / schedule
 *   broadcast/useConfirmationBroadcast.js confirmation: message + buttons
 *   broadcast/{TargetingSection,RegularBroadcastTab,
 *              ConfirmationBroadcastTab,SendConfirmDialog,PlaceholderChips}.jsx
 *
 * Targeting is ONE hook shared by both composers, because the audience and the
 * force-language setting have one control each at the top of the page and apply
 * to whichever tab sends. Per-tab copies would let an admin pick drivers on one
 * tab and send from the other.
 *
 * The two composers are separate hooks because their rules genuinely differ: a
 * regular broadcast may be media-only, while a confirmation requires message
 * text (buttons under a bare photo give a driver nothing to answer).
 *
 * Sending is guarded by SendConfirmDialog for both tabs — a broadcast reaches
 * every targeted driver group at once and cannot be recalled. Test, which only
 * reaches the management group, deliberately bypasses that prompt.
 *
 * insertTokenIntoEditor stays here because it dispatches to whichever of the SIX
 * language editors last had focus, across both tabs.
 */
export default function BroadcastPage() {
  const [broadcastTab, setBroadcastTab] = useState('regular'); // 'regular' | 'confirmation'
  const [showSendConfirm, setShowSendConfirm] = useState(null);

  const targeting = useBroadcastTargeting();
  const regularHistory = useBroadcastHistory('regular');
  const confHistory = useBroadcastHistory('confirmation');

  const regular = useRegularBroadcast({
    targeting, onSent: regularHistory.loadHistory,
  });
  const confirmation = useConfirmationBroadcast({
    targeting, onSent: confHistory.loadHistory,
  });

  /**
   * Insert a {token} at the caret of the active editor for the given tab.
   *
   * Six editors (three languages × two tabs) share one chip row per tab, so the
   * caret target is resolved here from the tab's own activeField rather than by
   * the chips.
   */
  const insertTokenIntoEditor = (kind, token) => {
    const composer = kind === 'confirmation' ? confirmation : regular;
    const target = composer.editors[composer.activeField] || composer.editors.en;
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

  return (
    <div>
      <div className="page-header">
        <h2>📢 Broadcast Center</h2>
        <p>Send messages and media to multiple driver groups</p>
      </div>

      <div className="broadcast-tabs">
        <button className={`broadcast-tab-btn ${broadcastTab === 'regular' ? 'active' : ''}`} onClick={() => setBroadcastTab('regular')}>📢 Announcement</button>
        <button className={`broadcast-tab-btn ${broadcastTab === 'confirmation' ? 'active' : ''}`} onClick={() => setBroadcastTab('confirmation')}>✅ Confirmation</button>
      </div>

      <TargetingSection {...targeting} />

      {/* ════════ TAB 1: REGULAR ════════ */}
      {broadcastTab === 'regular' && (
        <RegularBroadcastTab
          regular={regular}
          targeting={targeting}
          history={regularHistory}
          setShowSendConfirm={setShowSendConfirm}
          insertTokenIntoEditor={insertTokenIntoEditor}
        />
      )}

      {/* ════════ TAB 2: CONFIRMATION ════════ */}
      {broadcastTab === 'confirmation' && (
        <ConfirmationBroadcastTab
          confirmation={confirmation}
          targeting={targeting}
          history={confHistory}
          setShowSendConfirm={setShowSendConfirm}
          insertTokenIntoEditor={insertTokenIntoEditor}
        />
      )}

      {/* ════════ SEND CONFIRMATION DIALOG ════════ */}
      <SendConfirmDialog
        showSendConfirm={showSendConfirm}
        setShowSendConfirm={setShowSendConfirm}
        targetType={targeting.targetType}
        selectedDriverIds={targeting.selectedDriverIds}
        onConfirmRegular={regular.handleSend}
        onConfirmConfirmation={confirmation.handleSend}
      />
    </div>
  );
}
