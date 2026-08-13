/**
 * The public presentation screen on /answers and /answers/test shows ONE
 * company-wide result view: per pattern, the share of respondents whose primary
 * tendency it is, how many people that is, and an authored example quote.
 *
 * This suite pins what the projector must show, that both modes render it
 * identically from their own isolated summary API, and that no department or
 * dispatch-team result can appear on the page — not even if a payload somehow
 * carried one.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SosAnswersPage from "./SosAnswersPage";
import { getSosSummary } from "../../api/sos";

vi.mock("../../api/sos", () => ({
  getSosSummary: vi.fn(),
  clearSosTestData: vi.fn(),
  sosAdminLogin: vi.fn(),
}));

const PATTERN_META = {
  victim: {
    name: "Sharoitga eʼtibor qaratish",
    example: "Nega bu doim aynan menga boʻlyapti?",
    positive: "Nomutanosiblikni tez sezasiz.",
    risk: "Stress oshadi.",
    sosQuestion: "Hozir men nima qila olaman?",
  },
  complaint: {
    name: "Muammoni aytishga moyillik", example: "Yana oʻsha muammo.",
    positive: "Ochiq aytasiz.", risk: "Kayfiyat pasayadi.", sosQuestion: "Qanday aniqroq yetkazaman?",
  },
  waiting: {
    name: "Ehtiyotkorlik bilan kutish", example: "Qachon ular buni hal qiladi?",
    positive: "Shoshilmaysiz.", risk: "Kechikish.", sosQuestion: "Qaysi qadamni qoʻya olaman?",
  },
  blame: {
    name: "Xato manbasini izlash", example: "Bu xatoni kim qildi?",
    positive: "Tartib muhim.", risk: "Devor paydo boʻladi.", sosQuestion: "Qanday yordam beraman?",
  },
  ownership: {
    name: "Shaxsiy tashabbus", example: "Hozir men nima qila olaman?",
    positive: "Tez harakat qilasiz.", risk: "Kuchni asrash kerak.", sosQuestion: "Nimani yaxshilay olaman?",
  },
  builder: {
    name: "Quruvchi yondashuv", example: "Nimani yaxshilay olaman?",
    positive: "Ildizni koʻrasiz.", risk: "Charchoq.", sosQuestion: "Jamoani qanday jalb qilaman?",
  },
};

const PRESENTATION = {
  title: "Savol Ortidagi Savol (SOS)",
  subtitle: "Jamoaviy natijalar",
  centralQuestion: "Men nima qila olaman?",
  centralQuestionIntro: "Bitta savol:",
  techniques: [{ from: "Nega bu menga boʻlyapti?", to: "Hozir men nima qila olaman?" }],
  practices: ["Bilganingizni ayting."],
};

/** 33 respondents — the numbers a projector audience can check by hand. */
const COMPANY_SUMMARY = {
  open: true,
  total: 33,
  patternMeta: PATTERN_META,
  presentation: PRESENTATION,
  company: {
    primaryPatterns: [
      { pattern: "victim", count: 6, percent: 18 },
      { pattern: "complaint", count: 2, percent: 6 },
      { pattern: "waiting", count: 5, percent: 15 },
      { pattern: "blame", count: 2, percent: 6 },
      { pattern: "ownership", count: 9, percent: 27 },
      { pattern: "builder", count: 9, percent: 27 },
    ],
    topPatterns: ["ownership", "builder", "victim"],
  },
};

const EMPTY_SUMMARY = {
  open: true,
  total: 0,
  patternMeta: PATTERN_META,
  presentation: PRESENTATION,
  company: {
    primaryPatterns: Object.keys(PATTERN_META).map((pattern) => ({ pattern, count: 0, percent: 0 })),
    topPatterns: [],
  },
};

async function renderPage(isTest, summary = COMPANY_SUMMARY) {
  getSosSummary.mockResolvedValue(summary);
  const view = render(<SosAnswersPage isTest={isTest} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /10 daqiqalik taymer/ })).toBeInTheDocument());
  return view;
}

/** The pattern row as it appears on screen, by its stable data-pattern hook. */
function patternRow(container, pattern) {
  return container.querySelector(`.sos-pattern-row[data-pattern="${pattern}"]`);
}

afterEach(() => { vi.clearAllMocks(); });

describe.each([
  ["/answers", false],
  ["/answers/test", true],
])("%s", (_label, isTest) => {
  test("reads its own mode's summary API", async () => {
    await renderPage(isTest);
    expect(getSosSummary).toHaveBeenCalledWith(isTest);
    expect(getSosSummary.mock.calls.every(([flag]) => flag === isTest)).toBe(true);
  });

  test("shows every pattern with its percentage, head count and example answer", async () => {
    const { container } = await renderPage(isTest);
    for (const row of COMPANY_SUMMARY.company.primaryPatterns) {
      const el = patternRow(container, row.pattern);
      expect(el, row.pattern).not.toBeNull();
      expect(el.textContent).toContain(PATTERN_META[row.pattern].name);
      expect(el.textContent).toContain(`${row.percent}%`);
      expect(el.textContent).toContain(`${row.count} kishi`);
      expect(el.textContent).toContain(PATTERN_META[row.pattern].example);
    }
  });

  test("presents the patterns in the fixed canonical order, not as a ranking", async () => {
    const { container } = await renderPage(isTest);
    const order = Array.from(container.querySelectorAll(".sos-pattern-row"))
      .map((el) => el.dataset.pattern);
    expect(order).toEqual(["victim", "complaint", "waiting", "blame", "ownership", "builder"]);
  });

  test("states the total and names the most common style", async () => {
    await renderPage(isTest);
    expect(screen.getByText(/Jami 33 ta javob/)).toBeInTheDocument();
    expect(screen.getByText(/eng koʻp uchragan uslub/)).toBeInTheDocument();
    expect(screen.getByText(/Eng koʻp uchragan javob uslubi/).textContent)
      .toContain(PATTERN_META.ownership.name);
  });

  test("frames the result as one company, with no group breakdown anywhere", async () => {
    const { container } = await renderPage(isTest);
    expect(screen.getByText(/Biz, bitta jamoa sifatida, qanday javob beramiz/)).toBeInTheDocument();
    const text = container.textContent;
    for (const forbidden of [
      "Boʻlimlar kesimida", "Har bir boʻlimning", "Dispetcherlik jamoalari",
      "Jamoalar kesimida", "ishtirok etgan boʻlim", "taqsimotni koʻrish",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(container.querySelector(".sos-qdist")).toBeNull();
  });

  test("the empty state invites people to fill the form instead of showing zeros", async () => {
    const { container } = await renderPage(isTest, EMPTY_SUMMARY);
    expect(screen.getByText(/Hali javoblar yoʻq/)).toBeInTheDocument();
    expect(container.querySelectorAll(".sos-pattern-row")).toHaveLength(0);
    expect(container.textContent).toContain(`/questions${isTest ? "/test" : ""}`);
    expect(container.textContent).not.toContain("NaN");
  });
});

describe("privacy of the presentation screen", () => {
  test("a payload that still carried group results would render none of it", async () => {
    // Defence in depth: the API no longer sends these, and the page has no code
    // path that could put them on a projector even if they came back.
    const { container } = await renderPage(false, {
      ...COMPANY_SUMMARY,
      departments: [{ key: "dispatch", labelUz: "Dispetcherlik (Dispatch)", count: 4, primaryCounts: {} }],
      dispatchTeams: [{ teamName: "Anthony / Allen / Scott", count: 2, primaryCounts: {} }],
    });
    expect(container.textContent).not.toContain("Dispetcherlik (Dispatch)");
    expect(container.textContent).not.toContain("Anthony / Allen / Scott");
  });

  test("only the TEST page is marked as test, and only it offers cleanup", async () => {
    const { container, unmount } = await renderPage(true);
    expect(container.textContent).toContain("TEST rejimi");
    expect(screen.getByRole("button", { name: /Tozalash boʻlimini ochish/ })).toBeInTheDocument();
    unmount();

    const real = await renderPage(false);
    expect(real.container.textContent).not.toContain("TEST rejimi");
    expect(screen.queryByRole("button", { name: /Tozalash boʻlimini ochish/ })).toBeNull();
  });

  test("the footer states that names and group results are not shown", async () => {
    await renderPage(false);
    const note = screen.getByText(/Natijalar anonim/);
    expect(note.textContent).toMatch(/boʻlim va jamoa kesimidagi natijalar koʻrsatilmaydi/);
  });
});
