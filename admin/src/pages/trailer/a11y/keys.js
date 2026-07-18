/**
 * Pure keyboard-navigation math for the shared accessible components (§8).
 * Kept React/DOM-free so the wrap-around and roving-focus rules are unit-tested
 * in isolation and shared by Modal (focus trap) and Tabs (arrow-key nav).
 */

/**
 * Next index when Tab / Shift+Tab cycles within a focus trap of `count`
 * elements, wrapping at both ends. Returns 0 when count is 0.
 */
export function nextTrapIndex(current, count, shiftKey) {
  if (count <= 0) return 0;
  const delta = shiftKey ? -1 : 1;
  return (current + delta + count) % count;
}

/**
 * Next selected tab index for an arrow-key roving tablist. Handles
 * ArrowRight/ArrowLeft (wrap) and Home/End; returns the current index for any
 * other key so the caller can no-op.
 */
export function nextTabIndex(current, count, key) {
  if (count <= 0) return 0;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return current;
  }
}

/** True when a key should activate a clickable element (Enter or Space). */
export function isActivationKey(key) {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
