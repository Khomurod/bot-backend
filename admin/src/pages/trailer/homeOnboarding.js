/**
 * First-visit onboarding state, kept PER AUTHENTICATED USER (blocker §12).
 *
 * The dismissal used to live under one global localStorage key, so one person
 * dismissing the welcome hid it for everyone on that browser. The key is now
 * namespaced by the authenticated user id. (A server-side user preference is
 * the ideal home for this; the namespaced key is the sanctioned lighter
 * alternative and behaves per-user.)
 */

const PREFIX = "trailerHomeWelcomeDismissed";

/** Storage key for a specific user. Falls back to a shared key only when there is no id. */
export function onboardingKey(userId) {
  return userId == null ? PREFIX : `${PREFIX}:${userId}`;
}

export function isOnboardingDismissed(storage, userId) {
  try {
    return storage.getItem(onboardingKey(userId)) === "true";
  } catch {
    return false;
  }
}

export function dismissOnboarding(storage, userId) {
  try {
    storage.setItem(onboardingKey(userId), "true");
  } catch {
    /* storage unavailable (private mode) — the guide simply reappears next visit */
  }
}

/**
 * The five things a first-time office employee needs to understand. The guide
 * actually EXPLAINS each — it is not a shortcut that only opens the rental
 * wizard.
 */
export const GUIDE_STEPS = [
  {
    title: "Home",
    body: "This page. It shows what needs your attention across rentals, trailers and money, and the quick actions you have permission to use.",
  },
  {
    title: "Starting a rental",
    body: "Go to Rentals → Start a rental. Pick the company, choose the trailers, decide how it is priced, then review and create. You can add a company without leaving the wizard.",
  },
  {
    title: "Confirming pickup",
    body: "Open the rental and confirm each trailer's pickup: fill the condition checklist, add at least one photo, enter the real pickup time and place, then confirm. The trailer becomes rented.",
  },
  {
    title: "Returning a trailer",
    body: "Open the rental and return the trailer: complete the return inspection, add a return photo (required), record any damage or charges, then confirm.",
  },
  {
    title: "Recording payment",
    body: "In Money → Invoices, open the invoice and record the payment. You will see the amount applied, the remaining balance and the delivery status of the customer's receipt.",
  },
];
