import React from "react";

/**
 * "Send Broadcast?" — the last stop before a message reaches drivers.
 *
 * It states the actual blast radius for an announcement ("ALL driver groups"
 * versus a count) because that is the number an admin needs to re-read; a
 * generic "are you sure" gets clicked through.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function SendConfirmDialog({
  showSendConfirm, setShowSendConfirm, targetType, selectedDriverIds,
  onConfirmRegular, onConfirmConfirmation,
}) {
  return (
    <>
  {showSendConfirm && (
    <div className="confirm-overlay" onClick={() => setShowSendConfirm(null)}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>📢 Send Broadcast?</h3>
        {showSendConfirm === 'regular' ? (
          <p>{targetType === 'all' ? 'This will send your message to ALL driver groups. This cannot be undone.' : `This will send to ${selectedDriverIds.length || 'selected'} groups.`}</p>
        ) : (
          <p>This will send the confirmation broadcast with interactive buttons. Drivers will be able to click and respond.</p>
        )}
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={() => setShowSendConfirm(null)} style={{ border: '1px solid var(--border)' }}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { setShowSendConfirm(null); showSendConfirm === 'regular' ? onConfirmRegular() : onConfirmConfirmation(); }}>Send Now</button>
        </div>
      </div>
    </div>
  )}
    </>
  );
}
