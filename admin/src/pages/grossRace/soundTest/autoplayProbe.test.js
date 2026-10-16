/**
 * The page-load question: may sound start by itself on this screen? Answered
 * with silence, and "unknown" whenever the browser does not really answer.
 */
import { describe, expect, test } from "vitest";
import { probeAutoplay, silentWav } from "./autoplayProbe";

const fake = (play) => () => ({ muted: true, src: "", play, pause() {} });
const refused = (name) => () => Promise.reject(Object.assign(new Error(name), { name }));

describe("silentWav", () => {
  test("is a WAV data: URL of silence", () => {
    const url = silentWav(0.25, 8000);
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
    const bytes = atob(url.split(",")[1]);
    expect(bytes.slice(0, 4)).toBe("RIFF");
    expect(bytes.slice(8, 12)).toBe("WAVE");
    expect(bytes.length).toBe(44 + 2000);
    expect(new Set(bytes.slice(44))).toEqual(new Set([String.fromCharCode(128)]));
  });
});

describe("probeAutoplay", () => {
  test("allowed when play() starts, and it plays unmuted", async () => {
    let element;
    const make = () => { element = fake(() => Promise.resolve())(); return element; };
    expect(await probeAutoplay({ make })).toBe("allowed");
    expect(element.muted).toBe(false);
    expect(element.src.startsWith("data:audio/wav")).toBe(true);
  });

  test("blocked when the browser refuses sound without a click", async () => {
    expect(await probeAutoplay({ make: fake(refused("NotAllowedError")) })).toBe("blocked");
    const throwing = () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); };
    expect(await probeAutoplay({ make: fake(throwing) })).toBe("blocked");
  });

  test("unknown when the browser gives no real answer", async () => {
    expect(await probeAutoplay({ make: fake(refused("NotSupportedError")) })).toBe("unknown");
    expect(await probeAutoplay({ make: fake(() => undefined) })).toBe("unknown", "an old play() returns nothing");
    expect(await probeAutoplay({ make: fake(() => new Promise(() => {})), timeoutMs: 10 })).toBe("unknown");
    expect(await probeAutoplay({ make: () => { throw new Error("no Audio here"); } })).toBe("unknown");
  });
});
