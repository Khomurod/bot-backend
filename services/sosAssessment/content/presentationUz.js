/**
 * SOS presentation content — Uzbek-only texts for the public /answers projector
 * page. The page itself is entirely in Uzbek; per-pattern names/explanations
 * come from content/results/*.js (uz fields), while this module holds the
 * central question, the technique list, and per-department SOS suggestions.
 */

module.exports = {
  title: "Savol Ortidagi Savol (SOS)",
  subtitle: "Jamoaviy natijalar — anonim va umumlashtirilgan",
  centralQuestion: "Vaziyatni hozir oldinga siljitish uchun men nima qila olaman?",
  centralQuestionIntro:
    "Kompaniyamizda muammo yuz berganda — hatto u sizning aybingiz bilan boʻlmasa ham — vaziyatni oldinga siljitadigan bitta savol bor:",

  /** "Replace the wrong question with the SOS question" — from the book. */
  techniques: [
    { from: "Nega bu menga boʻlyapti?", to: "Hozir men nima qila olaman?" },
    { from: "Qachon ular buni hal qiladi?", to: "Kutgunimcha qaysi foydali qadamni qoʻya olaman?" },
    { from: "Kim xato qildi?", to: "Hozirgi muammoni yechishga qanday yordam bera olaman?" },
    { from: "Nega ular tushunmaydi?", to: "Fikrimni qanday aniqroq yetkaza olaman?" },
    { from: "Nega bizga sharoit yoʻq?", to: "Qoʻlimdagi imkoniyatlar bilan nima qila olaman?" },
  ],

  /** Practice principles shown on the projector (book-grounded, respectful). */
  practices: [
    "Toʻliq javob boʻlmasa ham, bilganingizni ayting: nima maʼlum, nima nomaʼlum, keyingi qadam qachon.",
    "Avval hozirgi masalani yeching, sababni keyin oʻrganing — ikkalasini ham qiling.",
    "Muammo yechilgach, jarayonni yaxshilang: bitta takrorlanayotgan muammo — bitta yaxshilanish.",
    "Boʻlim chegarasi ortiga yashirinmang, lekin birovning butun ishini ham olib qoʻymang.",
    "Xavfsizlik, qonun va moliyaviy qoidalar — muhokama qilinmaydigan chegaralar. Tashabbus bu chegaralar ichida ishlaydi.",
    "Oʻzgartira oladigan yagona odam — oʻzingiz. Shaxsiy namuna — eng kuchli taʼsir.",
  ],

  /** Per-department suggested SOS questions + one technique (Uzbek). */
  departmentTips: {
    hr: {
      technique: "Nomzod yoki haydovchi javobsiz qolganda: bitta qoʻshimcha kanaldan urinish + zaxira variantni tayyorlash + jarayonga kichik eslatma qoʻshish.",
      sosQuestions: [
        "Bu haydovchida yaxshi taassurot qoldirish uchun hozir nima qila olaman?",
        "Keyingi nomzod xuddi shu muammoga duch kelmasligi uchun nimani oʻzgartira olaman?",
      ],
    },
    safety: {
      technique: "Qarshilik koʻrsatgan haydovchi bilan: avval tushunishga harakat qiling («Qaysi qismi noqulay?»), soʻng talabni aniq sabab bilan tushuntiring — talab oʻzgarmaydi, muloqot oʻzgaradi.",
      sosQuestions: [
        "Bu haydovchiga xavfsizlik talabini qanday tushunarli yetkaza olaman?",
        "Bu buzilish takrorlanmasligi uchun men qaysi profilaktik qadamni qoʻya olaman?",
      ],
    },
    dispatch: {
      technique: "Kechikish aniq boʻlgan zahoti: haydovchi bilan faktni aniqlang, brokerga halol xabar bering, jamoadoshga kontekstni toʻliq uzating — uchchalasi bitta odatga aylansin.",
      sosQuestions: [
        "Brokerga va haydovchiga hozir qanday aniq maʼlumot bera olaman?",
        "Smena topshirayotganda hamkasbim hech narsani soʻramasligi uchun nima qila olaman?",
      ],
    },
    trailer: {
      technique: "Treyler topilmasa yoki nosoz boʻlsa: hozirgi reys uchun variant toping, soʻng kuzatuvdagi uzilish qayerdaligini yozib, jarayonga bitta tuzatish taklif qiling.",
      sosQuestions: [
        "Haydovchi yoʻlda qolmasligi uchun hozir qanday variant taklif qila olaman?",
        "Treyler maʼlumoti keyingi safar aniq boʻlishi uchun nimani yaxshilay olaman?",
      ],
    },
    samsara: {
      technique: "Maʼlumot yetishmasa: mavjud faktlarni tekshirilgan holda uzating, nimani koʻra olmaganingizni ochiq ayting va kuzatuvdagi boʻshliqni yopish uchun bitta taklif kiriting.",
      sosQuestions: [
        "Bu hodisa eʼtibordan chetda qolmasligi uchun hozir nima qila olaman?",
        "Signallar oʻtkazib yuborilmasligi uchun jarayonda nimani mustahkamlay olaman?",
      ],
    },
    accounting: {
      technique: "Bahsli summa boʻyicha tekshiruv tugamagan boʻlsa ham: haydovchiga nima maʼlumligini, keyingi qadamni va aniq javob sanasini ayting — aniqlik saqlanadi, haydovchi javobsiz qolmaydi.",
      sosQuestions: [
        "Yakuniy javob tayyor boʻlmasa ham, haydovchiga hozir nimani aytib qoʻya olaman?",
        "Bu tushunmovchilik takrorlanmasligi uchun hisob-kitob izohini qanday soddalashtira olaman?",
      ],
    },
    updaters: {
      technique: "Maʼlumot mos kelmasa (tizim boshqa, haydovchi boshqa deydi): taxmin yubormang — farqni ayting, tekshiring va aniqlashgach yangilang; brokerga «bilamiz/tekshiryapmiz» formati ishonch beradi.",
      sosQuestions: [
        "Brokerga hozir halol va foydali qanday yangilanish bera olaman?",
        "Update oʻtkazib yuborilmasligi uchun oʻzimga qanday nazorat qoʻya olaman?",
      ],
    },
  },
};
