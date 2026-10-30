import React, { useState } from "react";

/**
 * How to make an office computer play the celebration video WITH sound, every
 * time, with nobody touching it (the owner, 26 October 2026: the screens are
 * Windows computers).
 *
 * A browser refuses to start sound on a page nobody has clicked; the board
 * then plays the video muted rather than not at all
 * (grossRace/celebration/CelebrationVideo.jsx). Chrome's own switch
 * `--autoplay-policy=no-user-gesture-required` lifts that for the window it
 * starts, and `--kiosk` keeps it full screen through the board's automatic
 * reloads. `--user-data-dir` gives that window a profile of its own, so the
 * switch applies even while another Chrome window is already open — Chrome
 * ignores switches handed to a profile that is already running.
 */

export function boardCommands(origin) {
  const board = `${origin}/dispatchteam`;
  return {
    chrome: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --user-data-dir="C:\\WenzeBoard" ${board}`,
    edge: `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --kiosk --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --user-data-dir="C:\\WenzeBoardEdge" ${board}`,
  };
}

function Command({ label, text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the text is on screen to select by hand */ }
  };
  return (
    <div style={{ margin: "8px 0 12px" }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <code style={{ flex: 1, display: "block", padding: 10, borderRadius: 6, background: "rgba(0,0,0,0.35)", fontSize: 12, wordBreak: "break-all", userSelect: "all" }}>
          {text}
        </code>
        <button className="btn btn-ghost touch-target" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

export default function WindowsSoundCard({ origin = window.location.origin }) {
  const commands = boardCommands(origin);
  return (
    <div className="ios-glass" style={{ padding: 20 }}>
      <h3 style={{ marginTop: 0 }}>Always with sound: set up the office computer (Windows)</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 0 }}>
        A browser does not let a page start sound by itself, so without this the video plays muted.
        Opening the board with the shortcut below allows it, full screen, every time.
      </p>
      <ol style={{ fontSize: 14, lineHeight: 1.6, paddingLeft: 20 }}>
        <li>On the computer that shows the board, right-click the desktop → <strong>New</strong> → <strong>Shortcut</strong>.</li>
        <li>Paste this as the location, press <strong>Next</strong>, name it <strong>Wenze Board</strong>, press <strong>Finish</strong>:
          <Command label="Google Chrome (recommended)" text={commands.chrome} />
        </li>
        <li>Double-click the shortcut. The board opens full screen; sound is now allowed. To leave full screen press <strong>Alt + F4</strong>.</li>
        <li>To open it by itself whenever the computer starts: press <strong>Win + R</strong>, type <code>shell:startup</code>, press Enter, and copy the shortcut into the folder that opens.</li>
        <li>Check it: on the board press <strong>Test sound</strong>. It should say sound may start by itself. Keep the Windows volume up and the TV not muted.</li>
      </ol>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
        If Chrome is installed somewhere else (for example <code>C:\Program Files (x86)\Google\Chrome\Application\chrome.exe</code>),
        change the first part of the command to that path. Without Chrome, Microsoft Edge works the same way:
      </div>
      <Command label="Microsoft Edge" text={commands.edge} />
    </div>
  );
}
