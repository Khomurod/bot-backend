/**
 * Messages → Surveys: New survey (saving does not send), Send (to the active
 * driver groups, after a confirmation that names how many), Close survey.
 * Made-up text throughout.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SurveysTab from "../SurveysTab";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getQuestions: vi.fn(),
  getResponses: vi.fn(),
  getGroupsManage: vi.fn(),
  sendQuestion: vi.fn(),
  deactivateQuestion: vi.fn(),
  createQuestion: vi.fn(),
  sendTestQuestion: vi.fn(),
  translateTexts: vi.fn(),
}));

const en = (text) => [{ language: "en", question_text: text }];
const HOUR_AGO = new Date(Date.now() - 3600e3).toISOString();
const QUESTIONS = [
  { id: 1, created_at: HOUR_AGO, active: true, translations: en("Draft question"), last_sent_at: null, response_count: 0 },
  { id: 2, created_at: HOUR_AGO, active: true, translations: en("Sent question"), last_sent_at: HOUR_AGO, last_sent_groups: 37, response_count: 4 },
  { id: 3, created_at: HOUR_AGO, active: false, translations: en("Closed question"), last_sent_at: HOUR_AGO, last_sent_groups: 5, response_count: 1 },
  { id: 4, created_at: HOUR_AGO, active: true, translations: en("Old question"), last_sent_at: null, response_count: 2 },
];
// A NULL `active` is not sent to (the sender selects active = TRUE), so it is not counted.
const GROUPS = [{ id: 1, active: true }, { id: 2, active: true }, { id: 3, active: false }, { id: 4, active: null }];

const cardOf = (text) => screen.getByText(text).closest(".question-card");

async function open() {
  render(<SurveysTab />);
  await screen.findByText("Draft question");
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getQuestions.mockResolvedValue(QUESTIONS);
  api.getGroupsManage.mockResolvedValue(GROUPS);
  api.getResponses.mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); });

test("each card says whether it went out and how many answered; a closed one cannot be sent", async () => {
  await open();
  expect(within(cardOf("Draft question")).getByText("Not sent yet")).toBeInTheDocument();
  expect(within(cardOf("Sent question")).getByText(/^Sent .* · 37 groups$/)).toBeInTheDocument();
  expect(within(cardOf("Sent question")).getByText("4 answers")).toBeInTheDocument();
  // Sent before the app remembered sends: its answers prove it went out.
  expect(within(cardOf("Old question")).getByText("Sent earlier")).toBeInTheDocument();
  const closed = cardOf("Closed question");
  expect(within(closed).getByText("Closed")).toBeInTheDocument();
  expect(within(closed).queryByRole("button", { name: /Send/ })).toBeNull();
  expect(within(closed).queryByRole("button", { name: "Close survey" })).toBeNull();
});

test("Send names the number of ACTIVE driver groups and does nothing when the person says no", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await open();
  fireEvent.click(within(cardOf("Draft question")).getByRole("button", { name: "Send to driver groups…" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(window.confirm.mock.calls[0][0]).toBe("Send this survey to 2 active driver groups, each in its own language?");
  expect(api.sendQuestion).not.toHaveBeenCalled();
});

test("a confirmed send reports who could not be reached and reloads the list", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.sendQuestion.mockResolvedValue({ sent: 2, failed: 1, errors: [{ group: "Gone group", error: "chat not found" }] });
  await open();
  const card = cardOf("Sent question");
  fireEvent.click(within(card).getByRole("button", { name: "Send again…" }));
  await waitFor(() => expect(api.sendQuestion).toHaveBeenCalledWith(2));
  expect(window.confirm.mock.calls[0][0]).toMatch(/It already went out .*; drivers who answered cannot answer again\.$/);
  expect(await within(card).findByRole("status")).toHaveTextContent("Sent to 2 groups. 1 could not be reached: Gone group.");
  expect(api.getQuestions).toHaveBeenCalledTimes(2);
});

test("a send that reached nobody is an error, and a long list of unreachable groups is cut short", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const errors = Array.from({ length: 7 }, (_, i) => ({ group: `G${i + 1}`, error: "chat not found" }));
  api.sendQuestion.mockResolvedValue({ sent: 0, failed: 7, errors });
  await open();
  const card = cardOf("Draft question");
  fireEvent.click(within(card).getByRole("button", { name: "Send to driver groups…" }));
  const outcome = await within(card).findByRole("status");
  expect(outcome).toHaveTextContent("Sent to 0 groups. 7 could not be reached: G1, G2, G3, G4, G5 and 2 more.");
  expect(outcome).toHaveClass("alert-error");
});

test("with no active driver group, Send says so instead of asking", async () => {
  vi.spyOn(window, "confirm");
  api.getGroupsManage.mockResolvedValue([{ id: 3, active: false }]);
  await open();
  const card = cardOf("Draft question");
  fireEvent.click(within(card).getByRole("button", { name: "Send to driver groups…" }));
  expect(await within(card).findByRole("alert")).toHaveTextContent("There are no active driver groups to send it to.");
  expect(window.confirm).not.toHaveBeenCalled();
});

test("Close survey asks first, then closes it", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.deactivateQuestion.mockResolvedValue({ success: true });
  await open();
  fireEvent.click(within(cardOf("Draft question")).getByRole("button", { name: "Close survey" }));
  expect(window.confirm.mock.calls[0][0]).toMatch(/a driver who taps an answer from now on is told it is closed/);
  await waitFor(() => expect(api.deactivateQuestion).toHaveBeenCalledWith(1));
});

async function startNewSurvey() {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "New survey" }));
  return screen.getByRole("form", { name: "New survey" });
}

function fillEnglish(form, { q = "How was your week?", options = ["Good", "Bad"] } = {}) {
  fireEvent.change(within(form).getByLabelText("Question (English)"), { target: { value: q } });
  options.forEach((text, i) => {
    fireEvent.change(within(form).getByLabelText(`Option ${i + 1} (English)`), { target: { value: text } });
  });
}

test("Translate fills Russian and Uzbek; editing the English afterwards is flagged, never re-translated", async () => {
  api.translateTexts.mockResolvedValue([
    { ru: "Как неделя?", uz: "Hafta qanday?" }, { ru: "Хорошо", uz: "Yaxshi" }, { ru: "Плохо", uz: "Yomon" },
  ]);
  const form = await startNewSurvey();
  const save = within(form).getByRole("button", { name: "Save survey" });
  fillEnglish(form);
  expect(save).toBeDisabled();

  fireEvent.click(within(form).getByRole("button", { name: "Translate to Russian and Uzbek" }));
  await waitFor(() => expect(within(form).getByLabelText("Question (Russian)")).toHaveValue("Как неделя?"));
  expect(api.translateTexts).toHaveBeenCalledWith(["How was your week?", "Good", "Bad"]);
  expect(within(form).getByLabelText("Option 2 (Uzbek)")).toHaveValue("Yomon");
  expect(save).not.toBeDisabled();

  fireEvent.change(within(form).getByLabelText("Option 2 (English)"), { target: { value: "Terrible" } });
  expect(within(form).getByText(/The English changed after translating/)).toBeInTheDocument();
  expect(within(form).getByLabelText("Option 2 (Russian)")).toHaveValue("Плохо");
  expect(api.translateTexts).toHaveBeenCalledTimes(1);
});

test("without the AI, the reason is shown and Russian and Uzbek can be typed by hand; Save stores all three", async () => {
  api.translateTexts.mockRejectedValue(new Error("AI is not configured. Add a provider under Settings → AI."));
  api.createQuestion.mockResolvedValue({ id: 9 });
  const form = await startNewSurvey();
  fillEnglish(form);
  fireEvent.click(within(form).getByRole("button", { name: "Translate to Russian and Uzbek" }));
  expect(await within(form).findByRole("alert")).toHaveTextContent("AI is not configured");

  for (const [lang, q, a, b] of [["Russian", "Вопрос", "Да", "Нет"], ["Uzbek", "Savol", "Ha", "Yo'q"]]) {
    fireEvent.change(within(form).getByLabelText(`Question (${lang})`), { target: { value: ` ${q} ` } });
    fireEvent.change(within(form).getByLabelText(`Option 1 (${lang})`), { target: { value: a } });
    fireEvent.change(within(form).getByLabelText(`Option 2 (${lang})`), { target: { value: b } });
  }
  fireEvent.click(within(form).getByRole("button", { name: "Save survey" }));

  await waitFor(() => expect(api.createQuestion).toHaveBeenCalledWith({
    translations: [
      { language: "en", question_text: "How was your week?" },
      { language: "ru", question_text: "Вопрос" },
      { language: "uz", question_text: "Savol" },
    ],
    options: [
      { option_order: 1, translations: [{ language: "en", option_text: "Good" }, { language: "ru", option_text: "Да" }, { language: "uz", option_text: "Ha" }] },
      { option_order: 2, translations: [{ language: "en", option_text: "Bad" }, { language: "ru", option_text: "Нет" }, { language: "uz", option_text: "Yo'q" }] },
    ],
  }));
  expect(await screen.findByText(/Survey saved. It has not been sent yet/)).toBeInTheDocument();
  expect(api.sendQuestion).not.toHaveBeenCalled();
});

test("the test send goes to the management group in English; removing an option removes it in every language", async () => {
  api.sendTestQuestion.mockResolvedValue({ success: true });
  const form = await startNewSurvey();
  fireEvent.click(within(form).getByRole("button", { name: "Add option" }));
  fillEnglish(form, { options: ["Good", "Bad", "Okay"] });
  fireEvent.change(within(form).getByLabelText("Option 3 (Russian)"), { target: { value: "Нормально" } });
  fireEvent.click(within(form).getByRole("button", { name: "Remove option 2" }));
  expect(within(form).queryByLabelText("Option 3 (English)")).toBeNull();
  expect(within(form).getByLabelText("Option 2 (Russian)")).toHaveValue("Нормально");

  fireEvent.click(within(form).getByRole("button", { name: "Send test to management group" }));
  await waitFor(() => expect(api.sendTestQuestion).toHaveBeenCalledWith("How was your week?", ["Good", "Okay"]));
  expect(await within(form).findByRole("status")).toHaveTextContent("Answers to a test are not recorded.");
});
