/**
 * Short Uzbek SOS messages shown between countdown segments by the 10-minute
 * presentation timer.
 *
 * Each line is an original short paraphrase of a QBQ / "Savol Ortidagi Savol"
 * idea from John G. Miller's book (personal accountability: no victim thinking,
 * no blaming, no procrastination; ask "what/how" questions containing "I" that
 * lead to action; you can only change yourself; accountability has boundaries).
 * They are deliberately paraphrases, not quotations — presentation-friendly,
 * respectful, never judging an employee, and phrased for a trucking company's
 * daily teamwork.
 *
 * Frontend-only content: no API call, no AI at runtime.
 */

export const SOS_TIMER_MESSAGES = [
  "Aybdorni emas, keyingi foydali qadamni qidiring.",
  "Men hozir vaziyatni oldinga siljitish uchun nima qila olaman?",
  "Masʼuliyat — hamma ishni qilish emas, oʻz qismingizni toʻliq bajarishdir.",
  "«Qachon ular hal qiladi?» oʻrniga «Men hozir nima qila olaman?» deb soʻrang.",
  "«Nega bu menga boʻlyapti?» degan savol yechim bermaydi, faqat kuchni oladi.",
  "Kuchli savol «nima» yoki «qanday» bilan boshlanadi va ichida «men» boʻladi.",
  "Kechiktirish ham qaror: kichik ish katta muammoga aylanib ketmasin.",
  "Bor imkoniyat bilan ishni bitirgan odam yangi imkoniyatga ega boʻladi.",
  "Avval hamkasbingizni tushunishga harakat qiling, soʻng tushuntirishga.",
  "Hammamiz bitta jamoadamiz — boʻlim chegarasi haydovchiga koʻrinmaydi.",
  "Oʻzgartira oladigan yagona odam — oʻzingiz. Shaxsiy namuna eng kuchli taʼsir.",
  "Hech narsa qilmaslik ham xatar: harakat tajriba va yechim keltiradi.",
];

/** Deterministic 32-bit PRNG — same seed always yields the same order. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy, driven by the seeded PRNG. */
function shuffled(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds `count` messages by concatenating seeded shuffles of the full list, so
 * every message is shown once per round and the order varies between runs.
 * No message ever appears twice in a row: when a fresh block would start with
 * the previous line, its first two entries are swapped (the list has no
 * duplicates, so the swap always resolves the collision).
 */
export function buildMessageSequence(count, seed = 1, messages = SOS_TIMER_MESSAGES) {
  if (count <= 0 || messages.length === 0) return [];
  const random = mulberry32(seed);
  const out = [];
  while (out.length < count) {
    const block = shuffled(messages, random);
    if (out.length > 0 && block.length > 1 && block[0] === out[out.length - 1]) {
      [block[0], block[1]] = [block[1], block[0]];
    }
    out.push(...block);
  }
  return out.slice(0, count);
}
