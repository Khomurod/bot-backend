/**
 * The video after the celebration: out of sight until its turn, then with
 * sound if the TV allows it, without if not, and back to the board when it
 * ends, fails, or runs too long.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CelebrationVideo from "./CelebrationVideo";

function stubPlay(...answers) {
  const play = vi.fn(() => answers.shift()());
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  return play;
}
const ok = () => Promise.resolve();
const notAllowed = () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" }));
const broken = () => Promise.reject(Object.assign(new Error("x"), { name: "NotSupportedError" }));
const video = () => document.querySelector("video");

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("CelebrationVideo", () => {
  test("fetched out of sight, then played with sound; its end brings the board back", async () => {
    const play = stubPlay(ok);
    const onDone = vi.fn();
    const { rerender } = render(<CelebrationVideo playing={false} onDone={onDone} src="/v.mp4" />);
    expect(video().getAttribute("preload")).toBe("auto");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();

    rerender(<CelebrationVideo playing onDone={onDone} src="/v.mp4" />);
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Celebration video" })).toBeInTheDocument();
    expect(play).toHaveBeenCalledTimes(1);
    expect(video().muted).toBe(false);
    act(() => { fireEvent(video(), new Event("ended")); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("sound refused: it plays without sound rather than not at all", async () => {
    const play = stubPlay(notAllowed, ok);
    const onDone = vi.fn();
    render(<CelebrationVideo playing onDone={onDone} src="/v.mp4" />);
    await act(async () => {});
    expect(play).toHaveBeenCalledTimes(2);
    expect(video().muted).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });

  test("a video that cannot play, or fails to load, gives the board back at once, once", async () => {
    stubPlay(broken);
    const onDone = vi.fn();
    render(<CelebrationVideo playing onDone={onDone} src="/v.mp4" />);
    await act(async () => {});
    act(() => { fireEvent(video(), new Event("error")); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("however long it is, the board is back after the limit", async () => {
    vi.useFakeTimers();
    stubPlay(() => new Promise(() => {}));
    const onDone = vi.fn();
    render(<CelebrationVideo playing onDone={onDone} src="/v.mp4" maxMs={1000} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
