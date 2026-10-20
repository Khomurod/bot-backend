/**
 * The broadcast preview renders message text as HTML, so it must render it
 * SANITIZED. It used to sanitize only when `window.sanitizeTelegramHtmlForPreview`
 * existed, and nothing ever defined it: a script or an event handler in a
 * message — typed by any admin, or returned by AI translation — ran in the
 * session of whoever opened the preview.
 */
import React from "react";
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TelegramPreview } from "./TelegramPreview";

afterEach(() => { cleanup(); delete window.__xss; });

test("Telegram formatting survives the preview", () => {
  const { container } = render(<TelegramPreview text="<b>Bold</b> and <i>italic</i>" />);
  const preview = container.querySelector(".telegram-html-preview");
  expect(preview.querySelector("b").textContent).toBe("Bold");
  expect(preview.querySelector("i").textContent).toBe("italic");
});

test("A SCRIPT OR AN EVENT HANDLER IN THE MESSAGE NEVER REACHES THE PAGE", () => {
  const { container } = render(
    <TelegramPreview text={'<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:alert(1)">x</a><b onclick="window.__xss=3">ok</b>'} />
  );
  const preview = container.querySelector(".telegram-html-preview");
  expect(preview.querySelector("img")).toBeNull();
  expect(preview.querySelector("script")).toBeNull();
  expect(preview.innerHTML).not.toMatch(/onerror|onclick|javascript:/i);
  expect(preview.querySelector("b").textContent).toBe("ok");
  expect(window.__xss).toBeUndefined();
});

test("each language tab is sanitized, not only the default one", () => {
  const { container } = render(
    <TelegramPreview langTabs={["en"]} text={{ en: '<img src=x onerror="window.__xss=1">Hello' }} />
  );
  const preview = container.querySelector(".telegram-html-preview");
  expect(preview.querySelector("img")).toBeNull();
  expect(preview.textContent).toContain("Hello");
});
