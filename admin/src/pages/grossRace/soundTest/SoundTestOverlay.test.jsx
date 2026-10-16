/**
 * The sound test's clip and its card: what the screen did, in words the owner
 * can read off a TV across the room.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SoundTestOverlay from "./SoundTestOverlay";

function stubPlay(...answers) {
  const play = vi.fn(() => answers.shift()());
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  return play;
}
const ok = () => Promise.resolve();
const notAllowed = () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" }));
const broken = () => Promise.reject(Object.assign(new Error("x"), { name: "NotSupportedError" }));
const end = () => act(() => { fireEvent(document.querySelector("video"), new Event("ended")); });

afterEach(() => vi.restoreAllMocks());

describe("SoundTestOverlay", () => {
  test("plays the clip with sound, then says what this screen can do", async () => {
    const play = stubPlay(ok);
    render(<SoundTestOverlay autoplay="blocked" car="on" onClose={() => {}} userAgent="TestTV/1.0" />);
    expect(screen.getByRole("dialog", { name: "Sound test" })).toBeInTheDocument();
    expect(document.querySelector("video").muted).toBe(false);
    await act(async () => {});
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Sound test: this screen")).not.toBeInTheDocument();
    end();
    expect(screen.getByText("Sound can start by itself: NO (needs a click first)")).toBeInTheDocument();
    expect(screen.getByText("Test video played WITH sound")).toBeInTheDocument();
    expect(screen.getByText("3D car: shown")).toBeInTheDocument();
    expect(screen.getByText("TestTV/1.0")).toBeInTheDocument();
  });

  test("sound refused: the clip plays muted and the card says so", async () => {
    const play = stubPlay(notAllowed, ok);
    render(<SoundTestOverlay autoplay="allowed" car="off" onClose={() => {}} userAgent="" />);
    await act(async () => {});
    expect(play).toHaveBeenCalledTimes(2);
    expect(document.querySelector("video").muted).toBe(true);
    end();
    expect(screen.getByText("Sound can start by itself: YES")).toBeInTheDocument();
    expect(screen.getByText("Test video played, but only WITHOUT sound")).toBeInTheDocument();
    expect(screen.getByText("3D car: not supported here, a trophy was shown instead")).toBeInTheDocument();
  });

  test("a clip that cannot play goes straight to the card; Close closes it", async () => {
    stubPlay(broken);
    const onClose = vi.fn();
    render(<SoundTestOverlay autoplay="unknown" car={null} onClose={onClose} userAgent="" />);
    await act(async () => {});
    expect(screen.getByText("Test video did NOT play")).toBeInTheDocument();
    expect(screen.getByText("Sound can start by itself: UNKNOWN")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
