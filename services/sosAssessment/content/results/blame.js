/**
 * SOS result content — "blame" tendency (tracing the source of the mistake).
 * Respectful, non-labeling wording: describes a response TENDENCY, never the person.
 */

module.exports = {
  pattern: "blame",
  name: {
    uz: "Xato manbasini izlash",
    ru: "Поиск источника ошибки",
    en: "Tracing the source of the mistake",
  },
  headline: {
    uz: "Javoblaringizga koʻra, muammo yuz berganda diqqatingiz avvalo xato qayerda va kim tomonidan qilinganini aniqlashga qaratilishi mumkin.",
    ru: "Судя по вашим ответам, при возникновении проблемы ваше внимание в первую очередь может направляться на то, где и кем была допущена ошибка.",
    en: "Your answers suggest that when a problem appears, your attention may first go to finding where and by whom the mistake was made.",
  },
  explanation: {
    uz: "Masʼuliyat aniq boʻlishini xohlash — jiddiy yondashuv belgisi: sabab topilmasa, xato takrorlanaveradi. Lekin kitob muhim farqni koʻrsatadi: «Kim aybdor?» degan savol muammoni yechmaydi — u qoʻrquv uygʻotadi, odamlarni himoyaga oʻtkazadi va boʻlimlar orasiga devor quradi. Avval hozirgi muammoni birga yechish, soʻng «Jarayonni qanday yaxshilash mumkin?» deb soʻrash — xuddi shu tartib ham sababni ochadi, ham munosabatlarni saqlaydi.",
    ru: "Желание, чтобы ответственность была ясной, — признак серьёзного отношения: если причину не найти, ошибка будет повторяться. Но книга показывает важное различие: вопрос «Кто виноват?» не решает проблему — он рождает страх, заставляет людей защищаться и строит стены между отделами. Сначала вместе решить текущую проблему, а затем спросить «Как улучшить процесс?» — такой порядок и вскрывает причину, и сохраняет отношения.",
    en: "Wanting responsibility to be clear is a sign of taking things seriously: if the cause is never found, the mistake repeats. But the book draws a key distinction: “Who is to blame?” does not solve the problem — it creates fear, puts people on the defensive, and builds walls between departments. Solving the current problem together first, then asking “How can the process be improved?”, both uncovers the cause and preserves relationships.",
  },
  strengths: [
    {
      uz: "Siz uchun masʼuliyat va tartib muhim — xatolar sizning nazaringizdan qochib qutulmaydi.",
      ru: "Для вас важны ответственность и порядок — ошибки не ускользают от вашего внимания.",
      en: "Accountability and order matter to you — mistakes do not slip past your attention.",
    },
    {
      uz: "Sabab-oqibatni chuqur tekshirasiz, bu ildiz muammolarni topishda qimmatli koʻnikma.",
      ru: "Вы глубоко разбираетесь в причинах и следствиях — это ценный навык для поиска корневых проблем.",
      en: "You dig into cause and effect — a valuable skill for finding root problems.",
    },
  ],
  risks: [
    {
      uz: "Aybdorni izlash bilan boshlangan suhbat odamlarni himoyaga oʻtkazadi va hamkorlikni qiyinlashtiradi.",
      ru: "Разговор, начатый с поиска виноватого, заставляет людей защищаться и осложняет сотрудничество.",
      en: "A conversation that starts with finding the guilty puts people on the defensive and makes cooperation harder.",
    },
    {
      uz: "Kim aybdorligi aniqlanguncha muammoning oʻzi yechilmasdan turib qolishi mumkin.",
      ru: "Пока выясняется, кто виноват, сама проблема может оставаться нерешённой.",
      en: "While the guilty party is being identified, the problem itself can sit unsolved.",
    },
  ],
  techniques: [
    {
      uz: "Tartibni almashtiring: avval «Muammoni hozir yechishga qanday hissa qoʻsha olaman?», keyin «Takrorlanmasligi uchun jarayonda nimani oʻzgartiramiz?»",
      ru: "Поменяйте порядок: сначала «Чем я могу помочь решить проблему сейчас?», затем «Что изменить в процессе, чтобы это не повторилось?»",
      en: "Flip the order: first “How can I help solve the problem now?”, then “What do we change in the process so it does not repeat?”",
    },
    {
      uz: "«Kim?» oʻrniga «nima» va «qanday» bilan boshlanuvchi savollarni tanlang: «Vaziyatga nima taʼsir qildi?», «Jarayonni qanday mustahkamlaymiz?»",
      ru: "Вместо «Кто?» выбирайте вопросы, начинающиеся с «что» и «как»: «Что повлияло на ситуацию?», «Как укрепить процесс?»",
      en: "Instead of “Who?”, choose questions starting with “what” and “how”: “What influenced the situation?”, “How do we strengthen the process?”",
    },
    {
      uz: "Sabablarni odamlardan emas, jarayondan qidiring: xatoga yoʻl qoʻygan odamga ham «Unga qanday sharoit, qanday yoʻriqnoma berilgan edi?» deb qarang.",
      ru: "Ищите причины в процессе, а не в людях: даже про допустившего ошибку спросите «Какие условия и инструкции у него были?»",
      en: "Look for causes in the process, not in people: even for the person who erred, ask “What conditions and instructions did they have?”",
    },
  ],
  sosQuestions: [
    {
      uz: "Hozirgi muammoni yechishga men qanday yordam bera olaman?",
      ru: "Как я могу помочь решить текущую проблему?",
      en: "How can I help solve the current problem?",
    },
    {
      uz: "Bu xato takrorlanmasligi uchun men nimani yaxshilay olaman?",
      ru: "Что я могу улучшить, чтобы эта ошибка не повторилась?",
      en: "What can I improve so this mistake does not repeat?",
    },
    {
      uz: "Bu vaziyatdan men oʻzim uchun qanday saboq olaman?",
      ru: "Какой урок из этой ситуации я могу извлечь для себя?",
      en: "What lesson can I take from this situation for myself?",
    },
  ],
};
