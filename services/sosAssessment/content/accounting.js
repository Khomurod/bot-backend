/**
 * SOS assessment content — Accounting department (10 questions).
 *
 * Scope: settlements and deductions, dispatch data needed to close pay, cash
 * reimbursements and receipts, fuel-card disputes, detention pay, the escrow
 * line, missing PODs, toll disputes, cross-department reviews that block a
 * deduction, reconciliation errors.
 *
 * Authoring rules: see the header of ./hr.js — all five options must read as
 * competent and choosable, the six tendencies are loci of first action rather
 * than keyword formulas. Hard constraints for this department: no option may
 * pay or reimburse without the required document, hide or quietly absorb an
 * error, promise an amount that is not confirmed, or bypass an accounting
 * control. A less accountable instinct shows up as a different FIRST MOVE,
 * never as weakened financial controls.
 */

module.exports = {
  department: "accounting",
  questions: [
    {
      key: "accounting_q01",
      text: {
        uz: "Haydovchi qoʻngʻiroq qilib, haftalik hisob-kitobida (settlement) oʻzi tushunmaydigan 250 dollarlik ushlanma paydo boʻlganini aytdi va tushuntirish talab qilmoqda. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Водитель звонит и говорит, что в его недельном расчёте (settlement) появилось удержание на 250 долларов, которое он не понимает, и требует объяснений. Что вы, скорее всего, сделаете в первую очередь?",
        en: "A driver calls saying his weekly settlement shows a $250 deduction he does not understand, and he is demanding an explanation. What would you most likely do first?",
      },
      options: [
        { key: "accounting_q01_a", pattern: "victim", text: {
          uz: "Rahbarga aytib qoʻyaman: ushlanmani boshqa boʻlim kiritadi, biz faqat hisoblaymiz — haydovchining noroziligi buxgalteriya ishining sifati deb baholanmasligi kerak.",
          ru: "Скажу руководителю: удержание вносит другой отдел, а мы только считаем и объясняем — недовольство водителя не стоит считать качеством работы бухгалтерии.",
          en: "I would tell my manager another department enters the deduction and we only calculate — the driver’s anger is not a verdict on accounting’s work.",
        } },
        { key: "accounting_q01_b", pattern: "builder", text: {
          uz: "Ushlanma asosidagi hujjatni topib, haydovchiga band-band tushuntiraman, keyin har ushlanma yoniga qisqa izoh chiqishini yoʻlga qoʻyaman.",
          ru: "Найду документ-основание удержания, объясню водителю по пунктам, а затем налажу короткое пояснение рядом с каждым удержанием.",
          en: "I would find the document behind the deduction, walk the driver through it point by point, then get a short note printed next to every deduction.",
        } },
        { key: "accounting_q01_c", pattern: "blame", text: {
          uz: "Bu ushlanmani qaysi boʻlim kiritganini aniqlayman — hujjatsiz kiritilgan boʻlsa, tushuntirish ham, tuzatish ham oʻsha boʻlimdan boshlanishi kerak.",
          ru: "Определю, какой отдел внёс это удержание: если внесли без документов, и объяснение, и исправление должны начинаться там.",
          en: "I would establish which department entered this deduction — if it went in without documents, both explanation and correction start there.",
        } },
        { key: "accounting_q01_d", pattern: "ownership", text: {
          uz: "Uning settlementini va asos hujjatlarini hoziroq ochib, ushlanma nima uchun boʻlganini oʻzim aniqlayman va bugun haydovchiga aniq javob beraman.",
          ru: "Прямо сейчас открою его расчёт и документы-основания, сам разберусь, за что удержание, и сегодня же дам водителю конкретный ответ.",
          en: "I would open his settlement and the backing documents right now, establish myself what the deduction is for, and give him a concrete answer today.",
        } },
        { key: "accounting_q01_e", pattern: "complaint", text: {
          uz: "Haydovchiga oʻzim javob beraman, lekin rahbarga aytaman: ushlanmalar izohsiz keladi va qoʻngʻiroqlar bizga tushadi — har hafta shu holat.",
          ru: "Водителю отвечу сам, но скажу руководителю: удержания приходят без пояснений, а звонки идут к нам — так будет каждую неделю.",
          en: "I would answer the driver myself, but tell my manager deductions arrive with no note while the calls land on us — every week the same.",
        } },
      ],
    },
    {
      key: "accounting_q02",
      text: {
        uz: "Hisob-kitob kuni keldi, lekin bitta haydovchining haftalik toʻlovini yopib boʻlmayapti: dispetcherlik ikkita reys boʻyicha yakuniy maʼlumotni hali tasdiqlamagan. Haydovchi pulini ertaga kutmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Наступил день расчёта, но недельную выплату одного водителя закрыть нельзя: диспетчерская ещё не подтвердила итоговые данные по двум рейсам. Водитель ждёт деньги завтра. Что вы сделаете в первую очередь?",
        en: "It is settlement day, but one driver’s weekly pay cannot be closed: dispatch has not yet confirmed the final data on two loads. The driver expects his money tomorrow. What would you do first?",
      },
      options: [
        { key: "accounting_q02_a", pattern: "ownership", text: {
          uz: "Dispetcherga hoziroq oʻzim bogʻlanib, ikki reys boʻyicha tasdiqni soʻrayman va haydovchiga bugun ahvol qanday ekanini aniq aytaman.",
          ru: "Прямо сейчас сам свяжусь с диспетчером, запрошу подтверждение по двум рейсам и сегодня же ясно скажу водителю, как обстоят дела.",
          en: "I would contact the dispatcher myself right now, request confirmation on both loads, and tell the driver today exactly where things stand.",
        } },
        { key: "accounting_q02_b", pattern: "complaint", text: {
          uz: "Tasdiqni soʻrayman va masalani yigʻilishga olib chiqaman: dispetcherlik maʼlumotni doim oxirgi daqiqada beradi, hisob-kitob kuni esa shunday oʻtadi.",
          ru: "Подтверждение запрошу и вынесу вопрос на совещание: диспетчерская всегда даёт данные в последнюю минуту, и день расчёта проходит именно так.",
          en: "I would chase the confirmation and take the issue to the meeting: dispatch always sends data at the last minute, and settlement day goes exactly this way.",
        } },
        { key: "accounting_q02_c", pattern: "victim", text: {
          uz: "Oʻz qismimizni oʻz vaqtida bajaramiz, lekin toʻlov kechiksa haydovchi buxgalterni aybdor koʻradi — kechikish qaysi qadamda boʻlganini bugun yozib qoʻyaman.",
          ru: "Свою часть мы делаем вовремя, но при задержке выплаты водитель видит виноватым бухгалтера — сегодня зафиксирую, на каком шаге задержка.",
          en: "We do our part on time, yet a late payment makes the accountant the culprit — today I would record at which step the delay actually sat.",
        } },
        { key: "accounting_q02_d", pattern: "waiting", text: {
          uz: "Reys tasdigʻi dispetcherlikda — tekshirilmagan raqam bilan hisoblasam, keyin tuzatish kattaroq boʻladi; maʼlumotni kutaman va haydovchiga sababini aytaman.",
          ru: "Подтверждение по рейсам — за диспетчерской: посчитав по непроверенным цифрам, я потом получу более крупную корректировку; дождусь данных и скажу водителю причину.",
          en: "Load confirmation is dispatch’s — calculating on unverified numbers means a bigger correction later; I would wait for the data and tell the driver why.",
        } },
        { key: "accounting_q02_e", pattern: "builder", text: {
          uz: "Tasdiqlarni bugun soʻrab olaman, haydovchiga nima kutilayotganini aytaman, keyin dispetcherlik bilan hafta oʻrtasida maʼlumot topshirish muddatini kelishaman.",
          ru: "Подтверждения соберу сегодня, скажу водителю, чего ждём, а затем согласую с диспетчерской срок сдачи данных в середине недели.",
          en: "I would collect the confirmations today, tell the driver what is pending, then agree a midweek data deadline with dispatch.",
        } },
      ],
    },
    {
      key: "accounting_q03",
      text: {
        uz: "Haydovchi yoʻlda shina taʼmiri uchun 180 dollar naqd toʻlaganini aytib, xarajatni qoplashni soʻramoqda, lekin chekni yoʻqotib qoʻygan. Birinchi navbatda nima qilasiz?",
        ru: "Водитель говорит, что заплатил в дороге 180 долларов наличными за ремонт шины, и просит возместить расходы, но чек он потерял. Что вы сделаете в первую очередь?",
        en: "A driver says he paid $180 in cash for a tire repair on the road and asks to be reimbursed, but he has lost the receipt. What would you do first?",
      },
      options: [
        { key: "accounting_q03_a", pattern: "complaint", text: {
          uz: "Variantlarni tushuntiraman, ammo asosiy gap boshqada: haydovchilar naqd toʻlaydi va chekni yoʻqotadi — yoʻldagi xarajat tartibi koʻrilishi kerak.",
          ru: "Варианты объясню, но суть в другом: водители платят наличными и теряют чеки — порядок расходов в дороге надо пересмотреть.",
          en: "I would explain the options, but the real point is elsewhere: drivers pay cash and lose receipts, and the on-road expense procedure needs revisiting.",
        } },
        { key: "accounting_q03_b", pattern: "waiting", text: {
          uz: "Hujjatsiz toʻlov qilib boʻlmaydi — soʻrovni ochiq qoldiraman va haydovchiga aytaman: chekni topsa yoki nusxasini tiklasa, keyingi hisob-kitobda oʻtkazaman.",
          ru: "Без документа выплату сделать нельзя — оставлю запрос открытым и скажу водителю: найдёт чек или восстановит копию, проведу в следующем расчёте.",
          en: "No payment happens without a document — I would leave the request open and tell the driver: once he finds or restores it, it goes in the next settlement.",
        } },
        { key: "accounting_q03_c", pattern: "builder", text: {
          uz: "Haydovchi bilan birga shopdan invoys nusxasini soʻrayman, hujjat kelgach qoplaymiz, keyin chekni darhol suratga olish eslatmasini yoʻlga qoʻyaman.",
          ru: "Вместе с водителем запрошу копию инвойса у шопа, после документа возместим, а затем налажу напоминание сразу фотографировать чеки.",
          en: "I would request an invoice copy from the shop with the driver, reimburse once it arrives, then make photographing every receipt a standing rule.",
        } },
        { key: "accounting_q03_d", pattern: "blame", text: {
          uz: "Bu taʼmirni dispetcherlikda kim tasdiqlaganini aniqlayman — xarajat oldindan kelishilmagan boʻlsa, savol ham, tuzatish ham oʻsha yerdan boshlanadi.",
          ru: "Выясню, кто в диспетчерской согласовал этот ремонт: если расход не согласовали заранее, и вопрос, и исправление начинаются там.",
          en: "I would find out who in dispatch approved this repair — if the expense was not agreed in advance, both question and fix start there.",
        } },
        { key: "accounting_q03_e", pattern: "ownership", text: {
          uz: "Haydovchiga chek oʻrnini bosadigan hujjatlarni aniq aytaman, bugun shopdan nusxa olishga oʻzim yordam beraman va kelgach settlementga tushishini tushuntiraman.",
          ru: "Точно скажу водителю, какие документы заменяют чек, сегодня сам помогу получить копию у шопа и объясню, что по её поступлении сумма войдёт в расчёт.",
          en: "I would tell the driver exactly which documents replace a receipt, help him get a copy from the shop today, and explain when it enters his settlement.",
        } },
      ],
    },
    {
      key: "accounting_q04",
      text: {
        uz: "Haydovchi oʻtgan hafta yoqilgʻi kartasidagi notoʻgʻri deb hisoblagan tranzaksiyaga eʼtiroz bildirgan edi; karta provayderidan javob hali kelgani yoʻq. Haydovchi yana qoʻngʻiroq qilib, ish qay ahvolda ekanini soʻramoqda. Birinchi navbatda nima qilasiz?",
        ru: "Водитель на прошлой неделе оспорил транзакцию по топливной карте, которую считает ошибочной; ответа от провайдера карты ещё нет. Водитель снова звонит и спрашивает, как продвигается дело. Что вы сделаете в первую очередь?",
        en: "Last week a driver disputed a fuel-card transaction he believes is wrong; the card provider has not answered yet. The driver calls again asking how things are going. What would you do first?",
      },
      options: [
        { key: "accounting_q04_a", pattern: "blame", text: {
          uz: "Xato kimda ekanini aniqlayman — provayderdami yoki haydovchi esdan chiqargan xariddami; javob qaysi tomonda boʻlsa, tushuntirish ham oʻsha tomondan kelishi kerak.",
          ru: "Определю, чья ошибка — провайдера или забытая самим водителем покупка: у какой стороны ответ, оттуда должно идти и объяснение.",
          en: "I would establish whose error it is — the provider’s or a purchase the driver forgot; whichever side holds the answer should give the explanation.",
        } },
        { key: "accounting_q04_b", pattern: "ownership", text: {
          uz: "Bilganimni borligicha aytaman: eʼtiroz qachon berilgan va javob kelmagan — hamda juma kuni javob boʻlmasa ham oʻzim qoʻngʻiroq qilishimni aytaman.",
          ru: "Скажу как есть: когда подана претензия и что ответа нет — и что в пятницу сам позвоню, даже если ответа так и не будет.",
          en: "I would tell him what is known: when the dispute was filed and that no reply has come — and that I will call him on Friday even without an answer.",
        } },
        { key: "accounting_q04_c", pattern: "waiting", text: {
          uz: "Provayder javob bermaguncha yangilik yoʻq — taxmin haydovchini chalkashtiradi; javob kelishi bilan albatta bogʻlanishimizni aytaman.",
          ru: "Пока провайдер не ответит, новостей нет — догадки только запутают водителя; скажу, что обязательно свяжемся, как только придёт ответ.",
          en: "Until the provider replies there is no news — a guess only confuses the driver; I would say we will reach out the moment the answer comes.",
        } },
        { key: "accounting_q04_d", pattern: "builder", text: {
          uz: "Haydovchiga hozirgi holatni va keyingi xabar sanasini aytaman, keyin ochiq eʼtirozlarni muddatlari bilan umumiy roʻyxatga kiritaman — har hamkasb javob bera olsin.",
          ru: "Скажу водителю текущий статус и дату следующего сообщения, а затем внесу открытые претензии со сроками в общий список: отвечать сможет любой коллега.",
          en: "I would give the driver the current status and a date for my next update, then put open disputes with due dates on a shared list any colleague can answer from.",
        } },
        { key: "accounting_q04_e", pattern: "victim", text: {
          uz: "Javob provayderda, lekin qoʻngʻiroqlar bizga keladi — shu chegarani rahbar bilan oldin aniq qilib olaman, keyin javob berishni davom ettiraman.",
          ru: "Ответ у провайдера, а звонки идут к нам — сначала проясню эту границу с руководителем, а потом продолжу отвечать.",
          en: "The answer is the provider’s while the calls come to us — I would settle that boundary with my manager first, then keep answering.",
        } },
      ],
    },
    {
      key: "accounting_q05",
      text: {
        uz: "Haydovchi bu haftadagi toʻlovi kutganidan kam ekanini soʻrab qoʻngʻiroq qildi. Qarasangiz, kutish haqi (detention) broker hali tasdiqlamagani uchun hisobga kirmagan. Birinchi navbatda nima qilasiz?",
        ru: "Водитель звонит спросить, почему выплата за эту неделю меньше ожидаемой. Вы видите, что оплата простоя (detention) не вошла в расчёт, потому что брокер её ещё не подтвердил. Что вы сделаете в первую очередь?",
        en: "A driver calls asking why this week’s pay is lower than he expected. You see that detention pay is not in the settlement because the broker has not confirmed it yet. What would you do first?",
      },
      options: [
        { key: "accounting_q05_a", pattern: "builder", text: {
          uz: "Nima tasdiqlangan, nima kutilayotganini tushuntiraman, xabar sanasini aytaman, keyin varaqqa «kutilayotgan summalar» qatorini kiritishni yoʻlga qoʻyaman.",
          ru: "Объясню, что подтверждено и что в ожидании, назову дату следующего сообщения, а затем налажу в расчётном листе строку «ожидаемые суммы».",
          en: "I would explain what is confirmed and what is pending, name the date I will update him, then get a “pending amounts” line added to the settlement sheet.",
        } },
        { key: "accounting_q05_b", pattern: "complaint", text: {
          uz: "Tushuntiraman va bu tartib haqida savol qoʻyaman: brokerlar detentionni haftalab tasdiqlaydi, haydovchi esa pulni biz ushlab turgandek koʻradi.",
          ru: "Объясню и поставлю вопрос об этом порядке: брокеры подтверждают detention неделями, а водитель считает, что деньги держим мы.",
          en: "I would explain it and put a question about that order: brokers take weeks to confirm detention while the driver thinks we hold the money.",
        } },
        { key: "accounting_q05_c", pattern: "ownership", text: {
          uz: "Settlementni haydovchi bilan qator-qator koʻrib chiqaman, detention yoʻqolmagani va tasdiq kutilayotganini koʻrsataman va bugun dispetcherlikdan holatni soʻrayman.",
          ru: "Разберу расчёт с водителем строка за строкой, покажу, что detention не потерян и ждёт подтверждения, и сегодня же узнаю статус у диспетчерской.",
          en: "I would go through the settlement with him line by line, show the detention is not lost but awaiting confirmation, and check its status with dispatch today.",
        } },
        { key: "accounting_q05_d", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: broker sekinligi uchun javob bergan buxgalter boʻladi — bunday qoʻngʻiroqlar bizning ish sifatimiz deb baholanmasligi kerak.",
          ru: "Прямо скажу руководителю: за медлительность брокера отвечает бухгалтер — такие звонки не стоит считать качеством нашей работы.",
          en: "I would tell my manager plainly the accountant answers for the broker’s slowness — calls like this are not a measure of our work.",
        } },
        { key: "accounting_q05_e", pattern: "blame", text: {
          uz: "Detention soʻrovi dispetcherlikdan oʻz vaqtida ketganmi tekshiraman — kechiktirilgan boʻlsa, haydovchiga tushuntirish ham oʻsha tomondan kelishi toʻgʻri.",
          ru: "Проверю, вовремя ли ушёл запрос на detention из диспетчерской: если задержали, объяснять водителю правильнее той стороне.",
          en: "I would check whether dispatch filed the detention claim on time — if they delayed it, the explanation to the driver rightly comes from them.",
        } },
      ],
    },
    {
      key: "accounting_q06",
      text: {
        uz: "Har hafta bir nechta haydovchi hisob-kitob varagʻidagi escrow qatori boʻyicha bir xil savol bilan qoʻngʻiroq qiladi. Har bir suhbat vaqt oladi, haydovchilar esa baribir yarim ishonch bilan trubkani qoʻyadi. Birinchi navbatda nima qilasiz?",
        ru: "Каждую неделю несколько водителей звонят с одним и тем же вопросом про строку escrow в расчётном листе. Каждый разговор занимает время, а водители всё равно кладут трубку с полусомнением. Что вы сделаете в первую очередь?",
        en: "Every week several drivers call with the same question about the escrow line on their settlement sheet. Each conversation takes time, and drivers still hang up half-convinced. What would you do first?",
      },
      options: [
        { key: "accounting_q06_a", pattern: "waiting", text: {
          uz: "Varaq formati dasturda markazlashgan sozlanadi — format yuqorida oʻzgarmaguncha, qoʻngʻiroqlarga javob berib turishdan boshqa aniq yoʻl yoʻq.",
          ru: "Формат листа настраивается в программе централизованно — пока формат не изменят выше, ясного пути, кроме ответов на звонки, нет.",
          en: "The sheet format is configured centrally in the software — until it is changed higher up, there is no clear path beyond answering the calls.",
        } },
        { key: "accounting_q06_b", pattern: "ownership", text: {
          uz: "Bugun escrow qatori haqida sodda tilda qisqa izoh yozaman va shu savol bilan kelgan har bir haydovchiga oʻzim yuborib boraman.",
          ru: "Сегодня напишу короткое пояснение про строку escrow простым языком и сам буду отправлять его каждому водителю с этим вопросом.",
          en: "I would write a short plain-language explanation of the escrow line today and send it myself to every driver who comes with this question.",
        } },
        { key: "accounting_q06_c", pattern: "complaint", text: {
          uz: "Izoh yozaman, keyin varaq formatini rahbarlar oldiga qoʻyaman: hozirgi koʻrinishida u oʻqib boʻlmaydigan darajada va savollar shundan chiqadi.",
          ru: "Пояснение напишу, а затем поставлю перед руководителями вопрос о формате листа: в текущем виде он нечитаем.",
          en: "I would write the note, then put the sheet format to the leads: as it stands the sheet is simply unreadable.",
        } },
        { key: "accounting_q06_d", pattern: "victim", text: {
          uz: "Kunimning yarmi bir xil qatorni tushuntirishga ketadi — bu vaqtni oʻlchab, oylik hisobotimga qoʻshib boraman.",
          ru: "Полдня уходит на объяснение одной и той же строки — буду замерять это время и включать его в свой месячный отчёт.",
          en: "Half my day goes into explaining the same line — I would measure that time and include it in my monthly report.",
        } },
        { key: "accounting_q06_e", pattern: "builder", text: {
          uz: "Bir sahifalik oddiy escrow izohini tayyorlab, uni onbordingga va har settlement bilan ketadigan qilib kelishaman — savollar shu bilan kamayadi.",
          ru: "Подготовлю одностраничное простое пояснение про escrow и согласую, чтобы оно шло в онбординг и с каждым расчётом: вопросов станет меньше.",
          en: "I would prepare a simple one-page escrow explainer and arrange for it to go into onboarding and out with every settlement — the questions then thin out.",
        } },
      ],
    },
    {
      key: "accounting_q07",
      text: {
        uz: "Haydovchining hisob-kitobini yopish uchun bitta reys boʻyicha imzolangan yetkazib berish hujjati (POD) kerak. Haydovchi uni bir necha kun oldin yuklaganini aytmoqda, lekin tizimda hujjat yoʻq. Birinchi navbatda nima qilasiz?",
        ru: "Чтобы закрыть расчёт водителя, нужен подписанный документ о доставке (POD) по одному рейсу. Водитель уверяет, что загрузил его несколько дней назад, но в системе документа нет. Что вы сделаете в первую очередь?",
        en: "To close a driver’s settlement you need the signed proof of delivery (POD) for one load. The driver insists he uploaded it days ago, but it is not in the system. What would you do first?",
      },
      options: [
        { key: "accounting_q07_a", pattern: "ownership", text: {
          uz: "Hamma kanalni hoziroq oʻzim tekshiraman — ilova, pochta, dispetcher chati; topilmasa, haydovchidan surat soʻrab bugun yopaman.",
          ru: "Прямо сейчас сам проверю все каналы — приложение, почту, чат диспетчера; если его действительно нет, попрошу водителя прислать фото напрямую мне и закрою сегодня.",
          en: "I would check every channel myself right now — the app, email, the dispatch chat; if it truly is not there, I would ask him to send me a photo and close it today.",
        } },
        { key: "accounting_q07_b", pattern: "blame", text: {
          uz: "Hujjat qaysi bosqichda yoʻqolganini aniqlash kerak — haydovchi haqiqatan yuklagan boʻlsa, yoʻqotgan tizim yoki boʻlim javob berishi kerak, izlash shundan keyin.",
          ru: "Нужно установить, на каком шаге документ потерялся: если водитель действительно загрузил, отвечать должна потерявшая система или отдел, поиск — после этого.",
          en: "It has to be established where the document was lost — if he really uploaded it, the system or department that lost it answers, and the search follows.",
        } },
        { key: "accounting_q07_c", pattern: "builder", text: {
          uz: "Hujjatni haydovchidan qayta olib settlementni yopaman, keyin hujjat kelganda avtomatik tasdiq ketishini taklif qilaman — «yuborgandim» bahsi shu bilan tugaydi.",
          ru: "Возьму документ у водителя заново и закрою расчёт, а затем предложу автоматическое подтверждение получения документа: спор «я же отправлял» на этом заканчивается.",
          en: "I would get the document from the driver again and close the settlement, then propose an automatic receipt confirmation — the “I did send it” dispute ends there.",
        } },
        { key: "accounting_q07_d", pattern: "complaint", text: {
          uz: "Hujjatni qayta olaman, ammo asosiy muammo boshqada: ilova hujjatlarni yoʻqotadi, suratlar oʻqilmas keladi va bu masala boʻlim darajasida hal boʻlmaydi.",
          ru: "Документ возьму заново, но главная проблема в другом: приложение теряет документы, а фото приходят нечитаемыми.",
          en: "I would re-collect the document, but the main problem sits elsewhere: the app loses files and photos arrive unreadable.",
        } },
        { key: "accounting_q07_e", pattern: "waiting", text: {
          uz: "Haydovchidan hujjatni rasmiy kanal orqali qayta yuklashini soʻrayman va tizimda paydo boʻlishini kutaman — hujjatsiz yopilmaydi, summa keyingi siklga oʻtadi.",
          ru: "Попрошу водителя заново загрузить документ по официальному каналу и дождусь появления в системе: без документа не закрыть, сумма уйдёт в следующий цикл.",
          en: "I would ask the driver to re-upload through the official channel and wait for it to appear — it cannot close without the document, so it moves to the next cycle.",
        } },
      ],
    },
    {
      key: "accounting_q08",
      text: {
        uz: "Haydovchiga bahsli yoʻl haqi (toll) summalari boʻyicha yakuniy javobni juma kunigacha berishga vaʼda qilgansiz. Bugun juma, lekin toll provayderidan hisobot hali kelmadi. Birinchi navbatda nima qilasiz?",
        ru: "Вы обещали водителю дать окончательный ответ по спорным суммам за платные дороги (toll) до пятницы. Сегодня пятница, а отчёт от провайдера toll так и не пришёл. Что вы сделаете в первую очередь?",
        en: "You promised a driver a final answer on disputed toll charges by Friday. It is Friday, and the report from the toll provider still has not arrived. What would you do first?",
      },
      options: [
        { key: "accounting_q08_a", pattern: "victim", text: {
          uz: "Muddatni provayder buzdi, haydovchi oldida esa men vaʼdasini bajarmagan boʻlib qolaman — provayder bilan yozishmani bugun saqlab qoʻyaman.",
          ru: "Срок нарушил провайдер, а перед водителем невыполненным обещанием выгляжу я — переписку с провайдером сохраню сегодня же.",
          en: "The provider missed the deadline while I am the one looking unreliable to the driver — I would save that correspondence today.",
        } },
        { key: "accounting_q08_b", pattern: "builder", text: {
          uz: "Haydovchi qoʻngʻiroq qilishidan oldin oʻzim bogʻlanaman, yangi sanani aytaman, provayderga qayta soʻrov yuboraman va ochiq masalalarni roʻyxatga olaman.",
          ru: "Свяжусь сам, прежде чем водитель позвонит, назову новую дату, отправлю провайдеру повторный запрос и внесу открытые вопросы в список с контрольными датами.",
          en: "I would reach out before the driver calls, give a new date, send the provider a repeat request, and put open items on a list with control dates.",
        } },
        { key: "accounting_q08_c", pattern: "waiting", text: {
          uz: "Yangilik yoʻq holda qoʻngʻiroq qilsam, uni bekorga bezovta qilaman — hisobotni bir-ikki kun kutib, chalasi emas, toʻliq javobni bir yoʻla beraman.",
          ru: "Звонок без новостей только зря его растревожит — лучше подождать отчёт день-два и дать сразу полный ответ, а не половину картины.",
          en: "A call with no news only unsettles him for nothing — I would wait a day or two for the report and give the complete answer at once, not half a picture.",
        } },
        { key: "accounting_q08_d", pattern: "ownership", text: {
          uz: "Kun tugashidan oldin haydovchiga oʻzim qoʻngʻiroq qilib, maʼlumot kelmaganini rost aytaman, aniq yangi sana beraman va provayderni yana qistayman.",
          ru: "До конца дня сам позвоню водителю, честно скажу, что данные не пришли, дам конкретную новую дату и снова надавлю на провайдера.",
          en: "I would call the driver myself before the end of the day, say honestly the data has not come, give a specific new date, and push the provider again.",
        } },
        { key: "accounting_q08_e", pattern: "blame", text: {
          uz: "Provayder muddatni buzganini yozma qayd etaman — masala yuqoriga chiqsa, kechikish buxgalteriya tomonida boʻlmaganini hujjat koʻrsatishi kerak.",
          ru: "Письменно зафиксирую, что провайдер нарушил срок: если вопрос пойдёт выше, документы должны показать, что задержка не на стороне бухгалтерии.",
          en: "I would record in writing that the provider missed the deadline — if this goes higher, the file should show the delay was not accounting’s.",
        } },
      ],
    },
    {
      key: "accounting_q09",
      text: {
        uz: "Haydovchi treylerga yengil shikast yetkazgan; ushlanma boʻlish-boʻlmasligi xavfsizlik boʻlimining xulosasiga bogʻliq, xulosa esa bir haftadan beri tayyor emas. Haydovchi toʻlovidan katta summa ushlanib qolishidan xavotirda va buxgalteriyaga qayta-qayta qoʻngʻiroq qilmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Водитель слегка повредил трейлер; будет ли удержание, зависит от заключения отдела безопасности, а оно не готово уже неделю. Водитель боится, что из выплаты удержат крупную сумму, и раз за разом звонит в бухгалтерию. Что вы сделаете в первую очередь?",
        en: "A driver slightly damaged a trailer; whether there will be a deduction depends on Safety’s review, which has been pending for a week. The driver fears a large amount will be withheld from his pay and keeps calling accounting. What would you do first?",
      },
      options: [
        { key: "accounting_q09_a", pattern: "blame", text: {
          uz: "Kechikish xavfsizlik boʻlimida — haydovchiga qaysi boʻlim ushlab turganini aniq aytaman: xulosasiz biz hech narsa kiritmaymiz, savol ham oʻsha yerga borishi kerak.",
          ru: "Задержка в отделе безопасности — прямо скажу водителю, какой отдел держит вопрос: без заключения мы ничего не вносим, и спрашивать надо там.",
          en: "The delay is Safety’s — I would tell the driver exactly which department is holding it: we enter nothing without the review, and the question belongs there.",
        } },
        { key: "accounting_q09_b", pattern: "victim", text: {
          uz: "Qaror bizda emas, lekin haydovchining xavotiri bizga toʻkiladi — soʻrov qachon yuborilgani va javob kelmaganini yozib qoʻyaman.",
          ru: "Решение не за нами, а тревога водителя выливается на нас — зафиксирую, когда ушёл запрос и что ответа до сих пор нет.",
          en: "The decision is not ours yet the driver’s anxiety pours onto us — I would record when the request went out and that no answer came.",
        } },
        { key: "accounting_q09_c", pattern: "ownership", text: {
          uz: "Haydovchiga rost manzarani aytaman: xulosa boʻlmasa, ushlanma kiritilmaydi — va bugun xavfsizlik boʻlimidan muddat soʻrab, uni haydovchiga yetkazaman.",
          ru: "Скажу водителю честную картину: без заключения удержание не вносится — и сегодня же запрошу срок у отдела безопасности и передам его водителю.",
          en: "I would give the driver the honest picture — no review, no deduction entered — and ask Safety today for a timeline to pass on to him.",
        } },
        { key: "accounting_q09_d", pattern: "complaint", text: {
          uz: "Haydovchiga hamdardlik bildiraman va bugun boʻlim rahbarlari oldida savol qoʻyaman: boʻlimlar orasidagi soʻrovlar haftalab turadi.",
          ru: "Водителю посочувствую и сегодня поставлю вопрос перед руководителями отделов: межотдельские запросы лежат неделями.",
          en: "I would sympathize with the driver and today put the question to the department leads: cross-department requests sit for weeks.",
        } },
        { key: "accounting_q09_e", pattern: "builder", text: {
          uz: "Bugun xavfsizlik boʻlimidan holatni aniqlab, haydovchiga qachon xabar berishimni aytaman, keyin bunday xulosalar uchun standart muddat kelishishni taklif qilaman.",
          ru: "Сегодня уточню статус у отдела безопасности, скажу водителю, когда его извещу, а затем предложу согласовать стандартный срок для таких заключений.",
          en: "I would clarify the status with Safety today, tell the driver when he will hear from me, then propose a standard turnaround for reviews like this.",
        } },
      ],
    },
    {
      key: "accounting_q10",
      text: {
        uz: "Solishtiruv paytida oʻtgan haftagi hisob-kitobda bitta haydovchidan sugʻurta ushlanmasi xato ravishda ikki marta olinganini payqadingiz. Haydovchi buni hali sezmagan. Birinchi navbatda nima qilasiz?",
        ru: "Во время сверки вы заметили, что в расчёте за прошлую неделю с одного водителя страховое удержание было ошибочно снято дважды. Водитель этого пока не заметил. Что вы сделаете в первую очередь?",
        en: "During reconciliation you notice that in last week’s settlement one driver’s insurance deduction was mistakenly taken twice. The driver has not noticed yet. What would you do first?",
      },
      options: [
        { key: "accounting_q10_a", pattern: "complaint", text: {
          uz: "Tuzatishni jarayonga qoʻyaman, lekin rahbarga aytaman: bu hajm va shoshilishda xato muqarrar — hammasini bitta odam tekshirsa, sifat kutish qiyin.",
          ru: "Исправление поставлю в процесс, но скажу руководителю: при таком объёме и спешке ошибки неизбежны — когда всё проверяет один человек, качества ждать трудно.",
          en: "I would put the correction into the process, but tell my manager errors are inevitable at this volume and pace — with one person checking, quality is hard.",
        } },
        { key: "accounting_q10_b", pattern: "victim", text: {
          uz: "Xatoni qayd etib tuzatishga qoʻyaman va rahbarga aytib qoʻyaman: jadvalni men belgilamaganman — xato faylni oxirgi ochgan odamga yozilmasligi kerak.",
          ru: "Зафиксирую ошибку и поставлю на исправление, а руководителю скажу: график задавал не я — ошибку не стоит записывать на того, кто последним открыл файл.",
          en: "I would log the error for correction and tell my manager I did not set the pace — the mistake should not be written down to whoever touched the file last.",
        } },
        { key: "accounting_q10_c", pattern: "waiting", text: {
          uz: "Tuzatishlar odatda oy oxirida jamlab kiritiladi — yopilgan haftaga yolgʻiz tegsam chalkashlik chiqadi; keyingi solishtiruvda tartib boʻyicha kiritaman.",
          ru: "Корректировки обычно вносят пакетом в конце месяца — трогая закрытую неделю в одиночку, я создам путаницу; внесу по порядку на следующей сверке.",
          en: "Corrections normally go in as a month-end batch — touching a closed week alone creates confusion; I would enter it at the next reconciliation.",
        } },
        { key: "accounting_q10_d", pattern: "builder", text: {
          uz: "Xatoni hujjatlashtiraman, tuzatishni standart jarayondan oʻtkazaman, haydovchiga oʻzim aytaman va oʻsha haftadagi boshqa settlementlarni ham tekshiraman.",
          ru: "Задокументирую ошибку, проведу исправление стандартным процессом, сам скажу водителю и проверю, нет ли той же ошибки в других расчётах той недели.",
          en: "I would document the error, put the correction through the standard process, tell the driver myself, and check the week’s other settlements for the same slip.",
        } },
        { key: "accounting_q10_e", pattern: "ownership", text: {
          uz: "Xato haqida bugun rahbarga aytaman, tuzatishni amaldagi jarayondan oʻtkazaman va haydovchiga nima boʻlgani va tuzatish qachon koʻrinishini oʻzim tushuntiraman.",
          ru: "Об ошибке сегодня скажу руководителю, проведу исправление действующим процессом и сам объясню водителю, что произошло и когда исправление будет видно.",
          en: "I would report the error to my manager today, put the correction through the current process, and explain to the driver myself what happened and when it shows.",
        } },
      ],
    },
  ],
};
