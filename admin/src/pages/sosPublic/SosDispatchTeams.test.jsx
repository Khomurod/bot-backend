/**
 * The dispatch-team step of the questionnaire, on /questions AND /questions/test.
 *
 * Asserts the six authoritative teams reach the dropdown with their exact names,
 * that the team is REQUIRED when Dispatch is chosen (and only then), that the
 * team KEY — not a database row id — is what gets submitted, and that switching
 * away from Dispatch clears the choice so a stale team can never be sent.
 *
 * The API module is mocked, so this is the real page wiring against the real
 * server-side team list shape.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SosQuestionsPage from "./SosQuestionsPage";
import {
  getSosMeta, getSosQuestionnaire, submitSosAssessment,
} from "../../api/sos";

vi.mock("../../api/sos", () => ({
  getSosMeta: vi.fn(),
  getSosQuestionnaire: vi.fn(),
  submitSosAssessment: vi.fn(),
  getSosResult: vi.fn(),
}));

/** Exactly the six teams, exactly as the service serves them. */
const TEAMS = [
  { key: "team_1", name: "Anthony / Allen / Scott" },
  { key: "team_2", name: "Charles / Leo / Steven" },
  { key: "team_3", name: "Smith / Colin / Kevin" },
  { key: "team_4", name: "Franky / Sam / Ali" },
  { key: "team_5", name: "Tony / Andy / Max" },
  { key: "team_6", name: "Aaron / Jack" },
];

const DEPARTMENTS = [
  { key: "dispatch", label: { uz: "Dispetcherlik", ru: "Диспетчер", en: "Dispatch" } },
  { key: "hr", label: { uz: "HR", ru: "HR", en: "HR" } },
];

const QUESTIONS = Array.from({ length: 3 }, (_, i) => ({
  key: `dispatch_q0${i + 1}`,
  position: i + 1,
  text: { uz: `Savol ${i + 1}`, ru: `Вопрос ${i + 1}`, en: `Question ${i + 1}` },
  options: [
    { key: `dispatch_q0${i + 1}_a`, text: { uz: "A javob", ru: "Ответ A", en: "Answer A" } },
    { key: `dispatch_q0${i + 1}_b`, text: { uz: "B javob", ru: "Ответ B", en: "Answer B" } },
  ],
}));

/**
 * A complete personal-result payload — the shape the server really returns — so
 * the result screen renders instead of throwing after a successful submit.
 */
const PATTERN_BLOCK = {
  name: "Quruvchi", headline: "Siz jarayonni yaxshilaysiz",
  explanation: "Izoh.", strengths: ["Kuch"], risks: ["Xatar"],
  techniques: ["Uslub"], sosQuestions: ["Men nima qila olaman?"],
};
const RESULT = {
  language: "uz",
  scores: { victim: 0, complaint: 0, waiting: 1, blame: 0, ownership: 4, builder: 5 },
  patternNames: {
    victim: "Jabrlanuvchi", complaint: "Shikoyat", waiting: "Kutish",
    blame: "Ayblash", ownership: "Masʼuliyat", builder: "Quruvchi",
  },
  primary: PATTERN_BLOCK,
  secondary: null,
  common: {},
  submittedAt: "2026-07-31T09:00:00Z",
};

async function openDetails(isTest = false) {
  getSosMeta.mockResolvedValue({
    open: true, isTest, contentVersion: 7, departments: DEPARTMENTS, dispatchTeams: TEAMS,
  });
  getSosQuestionnaire.mockResolvedValue({ contentVersion: 7, department: "dispatch", questions: QUESTIONS });
  render(<SosQuestionsPage isTest={isTest} />);
  // welcome → details
  await waitFor(() => expect(screen.getByRole("button", { name: /Boshlash/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Boshlash/i }));
  await waitFor(() => expect(screen.getByLabelText(/Toʻliq ism-familiya/i)).toBeInTheDocument());
}

const teamSelect = () => screen.queryByLabelText(/Dispetcherlik jamoasi/i);
const deptSelect = () => screen.getByLabelText(/^Boʻlim$/i);
const continueButton = () => screen.getByRole("button", { name: /Davom etish/i });

function fillName(name = "Dispetcher Aliyev") {
  fireEvent.change(screen.getByLabelText(/Toʻliq ism-familiya/i), { target: { value: name } });
}

/** Walks the one-question-per-screen flow, then submits from the review step. */
async function answerEveryQuestionAndSubmit() {
  for (let i = 0; i < QUESTIONS.length; i += 1) {
    await waitFor(() => expect(screen.getByText(`Savol ${i + 1}`)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Keyingisi/i }));
  }
  await waitFor(() => expect(screen.getByRole("button", { name: /Javoblarni yuborish/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Javoblarni yuborish/i }));
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe.each([
  ["/questions", false],
  ["/questions/test", true],
])("%s", (_label, isTest) => {
  test("offers exactly the six teams, with the exact names, in order", async () => {
    await openDetails(isTest);
    fireEvent.change(deptSelect(), { target: { value: "dispatch" } });
    const options = Array.from(teamSelect().options);
    // one placeholder + six teams
    expect(options).toHaveLength(7);
    expect(options[0].value).toBe("");
    expect(options.slice(1).map((o) => o.textContent)).toEqual(TEAMS.map((t) => t.name));
    expect(options.slice(1).map((o) => o.value)).toEqual(TEAMS.map((t) => t.key));
  });

  test("the team dropdown only exists for Dispatch, and is required there", async () => {
    await openDetails(isTest);
    expect(teamSelect()).toBeNull(); // no department chosen yet
    fireEvent.change(deptSelect(), { target: { value: "hr" } });
    expect(teamSelect()).toBeNull();
    fireEvent.change(deptSelect(), { target: { value: "dispatch" } });
    expect(teamSelect()).toBeInTheDocument();
    expect(teamSelect()).toBeRequired();
  });

  test("Dispatch cannot continue without a team", async () => {
    await openDetails(isTest);
    fillName();
    fireEvent.change(deptSelect(), { target: { value: "dispatch" } });
    fireEvent.click(continueButton());
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/dispetcherlik jamoangizni tanlang/i);
    });
    expect(getSosQuestionnaire).not.toHaveBeenCalled();
  });

  test("a non-Dispatch department continues with no team at all", async () => {
    await openDetails(isTest);
    getSosQuestionnaire.mockResolvedValue({ contentVersion: 7, department: "hr", questions: QUESTIONS });
    fillName();
    fireEvent.change(deptSelect(), { target: { value: "hr" } });
    fireEvent.click(continueButton());
    await waitFor(() => expect(getSosQuestionnaire).toHaveBeenCalledWith("hr", isTest));
  });
});

describe("what gets submitted", () => {
  test.each(TEAMS)("$name submits its key $key", async ({ key, name }) => {
    await openDetails(false);
    submitSosAssessment.mockResolvedValue({ resultToken: "t".repeat(32), result: RESULT });
    fillName();
    fireEvent.change(deptSelect(), { target: { value: "dispatch" } });
    fireEvent.change(teamSelect(), { target: { value: key } });
    expect(teamSelect().selectedOptions[0].textContent).toBe(name);

    fireEvent.click(continueButton());
    // answer every question, then submit from the review screen
    await answerEveryQuestionAndSubmit();

    await waitFor(() => expect(submitSosAssessment).toHaveBeenCalled());
    const [payload, sentIsTest] = submitSosAssessment.mock.calls[0];
    expect(payload.department).toBe("dispatch");
    expect(payload.dispatchTeamKey).toBe(key);
    expect(payload).not.toHaveProperty("dispatchTeamId");
    expect(sentIsTest).toBe(false);
  });

  test("switching away from Dispatch clears the team, so none is sent", async () => {
    await openDetails(false);
    getSosQuestionnaire.mockResolvedValue({ contentVersion: 7, department: "hr", questions: QUESTIONS });
    submitSosAssessment.mockResolvedValue({ resultToken: "t".repeat(32), result: RESULT });
    fillName();
    fireEvent.change(deptSelect(), { target: { value: "dispatch" } });
    fireEvent.change(teamSelect(), { target: { value: "team_5" } });
    fireEvent.change(deptSelect(), { target: { value: "hr" } });
    fireEvent.change(deptSelect(), { target: { value: "dispatch" } });
    expect(teamSelect().value).toBe("");

    fireEvent.click(continueButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/jamoangizni tanlang/i));
    expect(submitSosAssessment).not.toHaveBeenCalled();
  });

  test("a team is only sent for Dispatch, never for another department", async () => {
    await openDetails(false);
    getSosQuestionnaire.mockResolvedValue({ contentVersion: 7, department: "hr", questions: QUESTIONS });
    submitSosAssessment.mockResolvedValue({ resultToken: "t".repeat(32), result: RESULT });
    fillName();
    fireEvent.change(deptSelect(), { target: { value: "hr" } });
    fireEvent.click(continueButton());
    await answerEveryQuestionAndSubmit();
    await waitFor(() => expect(submitSosAssessment).toHaveBeenCalled());
    expect(submitSosAssessment.mock.calls[0][0].dispatchTeamKey).toBeUndefined();
  });
});
