import { useEffect, useState } from "react";

/**
 * Which tab of a page is open — taken from the address when the shell drives
 * the page, or held by the page itself when it is rendered on its own (a test,
 * a story).
 *
 * Driven by the shell, `tab` is whatever followed the page in the address and
 * `onTabChange` writes a new one; a tab the page does not have opens its first
 * tab, so a mistyped or out-of-date link still opens a working screen. On its
 * own, `tab` is only where it starts.
 *
 * @param {string[]} keys   the page's tab keys, first = default
 * @param {{tab?: string|null, onTabChange?: Function}} route
 * @returns {[string, Function]} the open tab and the way to change it
 */
export default function useTabRoute(keys, { tab, onTabChange } = {}) {
  const valid = (key) => (keys.includes(key) ? key : keys[0]);
  const [local, setLocal] = useState(() => valid(tab));
  // A tab the page does not have (`#settings/bogus`) opens the first tab, and
  // the ADDRESS is corrected to say so — otherwise the screen and the link
  // somebody copies from it disagree. No tab at all is left alone.
  const unknown = Boolean(onTabChange && tab && !keys.includes(tab));
  useEffect(() => {
    if (unknown) onTabChange(keys[0]);
  }, [unknown]);
  if (onTabChange) return [valid(tab), onTabChange];
  return [local, setLocal];
}
