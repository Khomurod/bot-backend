/**
 * SOS assessment content — Accounting department (10 questions).
 *
 * Scope: driver deductions and explaining them, weekly driver settlements,
 * missing receipts and reimbursements, driver pay questions and disputed
 * amounts, missing settlement documents, communicating while an
 * investigation is still open, following up with drivers, coordination
 * with dispatch/safety, preventing repeated misunderstandings, accuracy
 * and fairness toward drivers.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - no option encourages changing payments without evidence, bypassing
 *    accounting controls, or making unsupported promises to a driver.
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
          uz: "Haydovchilarning jahli doim buxgalteriyaga tushishi alam qiladi — ushlanmalarni boshqa boʻlimlar kiritadi, biz faqat hisoblaymiz, lekin javobni negadir biz beramiz.",
          ru: "Мне обидно, что злость водителей всегда достаётся бухгалтерии — удержания подают другие отделы, мы лишь считаем, а отвечать почему-то приходится нам.",
          en: "It stings that drivers’ anger always lands on accounting — other departments submit the deductions, we only calculate, yet somehow we are the ones who answer.",
        } },
        { key: "accounting_q01_b", pattern: "builder", text: {
          uz: "Ushlanmaning asosini topib, haydovchiga band-band tushuntiraman, soʻng har bir ushlanma yoniga qisqa izoh yozib borishni taklif qilaman — bunday qoʻngʻiroqlar kamayishi uchun.",
          ru: "Найду основание удержания, объясню водителю пункт за пунктом, а затем предложу добавлять короткое пояснение к каждому удержанию в расчёте — чтобы таких звонков стало меньше.",
          en: "Find the paperwork behind the deduction, walk the driver through it point by point, then propose adding a short note next to every deduction on settlements so such calls become rarer.",
        } },
        { key: "accounting_q01_c", pattern: "blame", text: {
          uz: "Avval bu ushlanmani qaysi boʻlim kiritganini aniqlayman — summa hujjatsiz qoʻyilgan boʻlsa, haydovchiga oʻsha boʻlim oʻzi tushuntirib bersin.",
          ru: "Сначала выясню, какой отдел подал это удержание — если сумму внесли без документов, пусть тот отдел сам и объясняется с водителем.",
          en: "First establish which department submitted this deduction — if the amount was entered without documents, that department should be the one to explain it to the driver.",
        } },
        { key: "accounting_q01_d", pattern: "ownership", text: {
          uz: "Hoziroq uning hisob-kitobini va asos hujjatlarni ochaman, ushlanma nima uchun ekanini oʻzim aniqlab, bugunoq haydovchiga aniq javob beraman.",
          ru: "Прямо сейчас открою его расчёт и подтверждающие документы, сам разберусь, за что удержание, и сегодня же дам водителю конкретный ответ.",
          en: "Pull up his settlement and the backing documents right now, work out myself what the deduction is for, and give the driver a concrete answer today.",
        } },
        { key: "accounting_q01_e", pattern: "complaint", text: {
          uz: "Har hafta shu ahvol takrorlanishini aytaman: ushlanmalar izohsiz keladi, haydovchilar esa jahl bilan bizga qoʻngʻiroq qiladi — bunday tartibda ishlash juda ogʻir.",
          ru: "Скажу, что каждую неделю одно и то же: удержания приходят без пояснений, а водители злятся и звонят нам — работать в таком порядке очень тяжело.",
          en: "Point out that every week it is the same: deductions arrive without explanations and angry drivers call us — it is very hard to work this way.",
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
          uz: "Oʻzim hoziroq dispetcher bilan bogʻlanib, ikkala reys boʻyicha tasdiqni soʻrayman va haydovchiga bugunoq holat qanday ekanini xabar qilaman.",
          ru: "Сам прямо сейчас свяжусь с диспетчером, запрошу подтверждение по обоим рейсам и сегодня же сообщу водителю, как обстоят дела.",
          en: "Contact the dispatcher myself right now, request confirmation on both loads, and let the driver know today exactly where things stand.",
        } },
        { key: "accounting_q02_b", pattern: "complaint", text: {
          uz: "Dispetcherlik maʼlumotlarni doim oxirgi daqiqada berishini yana bir bor aytaman — grafik hech qachon ishlamaydi, tanbeh esa oxirida buxgalteriyaga tegadi.",
          ru: "Ещё раз скажу, что диспетчерская вечно присылает данные в последний момент — график никогда не работает, а упрёки в итоге достаются бухгалтерии.",
          en: "Say once again that dispatch always sends data at the last minute — the schedule never works, and in the end the reproaches land on accounting.",
        } },
        { key: "accounting_q02_c", pattern: "victim", text: {
          uz: "Biz oʻz qismimizni doim vaqtida qilamiz, lekin toʻlov kechiksa, haydovchi baribir buxgalterni aybdor deb biladi — bu adolatsizlikka koʻnikish qiyin.",
          ru: "Свою часть мы всегда делаем вовремя, но если выплата задерживается, водитель всё равно считает виноватым бухгалтера — с этой несправедливостью трудно смириться.",
          en: "We always do our part on time, but when pay is late the driver still sees the accountant as the guilty one — that unfairness is hard to accept.",
        } },
        { key: "accounting_q02_d", pattern: "waiting", text: {
          uz: "Reys tasdiqlari — dispetcherlik vazifasi: ularning maʼlumotini kutaman, chunki tekshirilmagan raqamlar bilan hisoblasam, keyin tuzatishlar yanada koʻp muammo chiqaradi.",
          ru: "Подтверждения рейсов — задача диспетчерской: дождусь их данных, ведь расчёт по непроверенным цифрам потом обернётся ещё большими корректировками.",
          en: "Load confirmations are dispatch’s job: I will wait for their data, because calculating from unverified numbers only creates bigger corrections later.",
        } },
        { key: "accounting_q02_e", pattern: "builder", text: {
          uz: "Tasdiqlarni hozir soʻrab chiqaman, haydovchiga nima kutilayotgani va qachon xabar berishimni aytaman, soʻng dispetcherlik bilan hafta oʻrtasida maʼlumot topshirish muddatini kelishishni taklif qilaman.",
          ru: "Сейчас запрошу подтверждения, скажу водителю, что именно ожидается и когда я выйду на связь, а затем предложу диспетчерской ввести срок сдачи данных в середине недели.",
          en: "Chase the confirmations now, tell the driver what is pending and when he will hear from me, then propose a midweek data-submission deadline with dispatch so settlements stop stalling.",
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
          uz: "Haydovchilar naqd toʻlab chekni yoʻqotishi doim takrorlanishini aytaman — keyin esa buxgalteriya bu chalkashlikka qandaydir yechim topishi kutilaveradi.",
          ru: "Скажу, что это повторяется постоянно: водители платят наличными и теряют чеки, а потом от бухгалтерии ждут, что она как-то найдёт выход.",
          en: "Say this keeps happening: drivers pay cash and lose the receipts, and then accounting is expected to somehow find a way out of the muddle.",
        } },
        { key: "accounting_q03_b", pattern: "waiting", text: {
          uz: "Hujjatsiz men hech narsa qila olmayman — soʻrovni chetga qoʻyib turaman: chekni topsa yoki tiklasa, oʻshanda rasmiylashtiramiz.",
          ru: "Без документа я ничего сделать не могу — отложу запрос: найдёт или восстановит чек, тогда и оформим.",
          en: "Without a document I cannot do anything — I will set the request aside: once he finds or restores the receipt, we will process it then.",
        } },
        { key: "accounting_q03_c", pattern: "builder", text: {
          uz: "Haydovchi bilan birga ustaxonaga qoʻngʻiroq qilib chek nusxasini soʻrayman, hujjat kelgach qoplashni rasmiylashtiraman va haydovchilarga chekni darhol suratga olish haqida qisqa eslatma tarqatishni taklif qilaman.",
          ru: "Вместе с водителем позвоню в мастерскую за копией счёта, оформлю возмещение, когда документ придёт, и предложу разослать водителям короткую памятку — сразу фотографировать каждый чек.",
          en: "Call the shop with the driver for a copy of the invoice, process the reimbursement once the document arrives, and propose a short reminder to drivers to photograph every receipt immediately.",
        } },
        { key: "accounting_q03_d", pattern: "blame", text: {
          uz: "Avval bu taʼmirni kim maʼqullaganini dispetcherlikdan aniqlayman — xarajat oldindan kelishilmagan boʻlsa, savol buxgalteriyaga emas, ruxsat bergan odamga berilishi kerak.",
          ru: "Сначала уточню у диспетчерской, кто одобрил этот ремонт — если расход не был согласован заранее, вопрос должен идти не к бухгалтерии, а к тому, кто разрешил.",
          en: "First check with dispatch who approved this repair — if the expense was not agreed in advance, the question should go to whoever allowed it, not to accounting.",
        } },
        { key: "accounting_q03_e", pattern: "ownership", text: {
          uz: "Haydovchiga chek oʻrnini bosadigan hujjatlarni aniq aytaman, bugunoq ustaxonadan nusxa olishiga yordam beraman va hujjat kelishi bilan summa hisob-kitobiga qoʻshilishini tushuntiraman.",
          ru: "Объясню водителю, какие документы заменят чек, сегодня же помогу получить копию из мастерской и скажу, что сумма попадёт в расчёт, как только документ придёт.",
          en: "Tell the driver exactly which documents can replace the receipt, help him get a copy from the shop today, and explain that the amount goes into his settlement as soon as it arrives.",
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
          uz: "Avval xato kimniki ekanini aniqlab olaman — provaydernikimi yoki haydovchi oʻzi unutgan xaridmi: aybdor tomon aniq boʻlgach, javobni oʻsha tomon bersin.",
          ru: "Сначала разберусь, чья это ошибка — провайдера или самого водителя, забывшего о покупке: когда виновная сторона ясна, пусть она и отвечает.",
          en: "First pin down whose mistake it is — the provider’s or the driver’s own forgotten purchase: once the party at fault is clear, let that side give the answer.",
        } },
        { key: "accounting_q04_b", pattern: "ownership", text: {
          uz: "Bilganimni ochiq aytaman: eʼtiroz qaysi kuni yuborilgani, javob hali kelmagani — va juma kuni, javob boʻlmasa ham, oʻzim qoʻngʻiroq qilishimni bildiraman.",
          ru: "Честно скажу, что известно: когда отправлен спор и что ответа пока нет, — и предупрежу, что в пятницу сам ему позвоню, даже если ответа ещё не будет.",
          en: "Tell him honestly what is known: when the dispute was filed and that no reply has come — and that I will call him myself on Friday even if there is still no answer.",
        } },
        { key: "accounting_q04_c", pattern: "waiting", text: {
          uz: "Provayder javob bermaguncha aytadigan yangilik yoʻq — taxmin bilan gapirsam, haydovchini faqat chalgʻitaman; javob kelishi bilan albatta bogʻlanishimizni aytaman.",
          ru: "Пока провайдер не ответил, новостей нет — предположениями я только запутаю водителя; скажу, что мы обязательно свяжемся, как только придёт ответ.",
          en: "Until the provider responds there is no news — guesses would only confuse the driver; I will say we will definitely reach out as soon as the answer comes.",
        } },
        { key: "accounting_q04_d", pattern: "builder", text: {
          uz: "Haydovchiga hozirgi holat va keyingi aloqa sanasini aytaman, soʻng ochiq eʼtirozlarning umumiy roʻyxatini yuritishni boshlayman — bunday qoʻngʻiroqqa istalgan hamkasb javob bera olishi uchun.",
          ru: "Назову водителю текущий статус и дату следующего контакта, а затем заведу общий список открытых споров со сроками — чтобы на такой звонок мог ответить любой коллега.",
          en: "Give the driver the current status and a date for my next update, then start a shared list of open disputes with due dates — so any colleague can answer such a call.",
        } },
        { key: "accounting_q04_e", pattern: "victim", text: {
          uz: "Haydovchilar buxgalter ularning pulini atayin ushlab turgandek gapiradi — men ham provayderning javobiga qaramman, lekin bu qoʻngʻiroqlarning hammasi menga keladi.",
          ru: "Водители говорят так, будто бухгалтер нарочно держит их деньги — я так же завишу от ответа провайдера, но все эти звонки достаются мне.",
          en: "Drivers talk as if the accountant is deliberately holding their money — I depend on the provider’s reply just like they do, yet all these calls come to me.",
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
          uz: "Hisobning tasdiqlangan va kutilayotgan qismlarini tushuntirib, qachon yangilik berishimni aytaman, soʻng varaqqa «kutilayotgan summalar» qatorini qoʻshishni taklif qilaman — haydovchi buni oldindan koʻrsin.",
          ru: "Объясню, что в расчёте подтверждено, а что ожидается, назову дату, когда дам новости, и предложу добавить в расчётный лист строку «ожидаемые суммы» — чтобы водитель видел это заранее.",
          en: "Explain what is confirmed and what is pending, name the date I will update him, then propose adding a “pending amounts” line to the settlement sheet so drivers see it upfront.",
        } },
        { key: "accounting_q05_b", pattern: "complaint", text: {
          uz: "Brokerlar detentionni haftalab tasdiqlamasligini, haydovchilar esa pulni buxgalteriya ushlab turibdi deb oʻylashini aytaman — bu sohaning eski dardi, qoʻlimizdan kam narsa keladi.",
          ru: "Скажу, что брокеры неделями не подтверждают detention, а водители думают, что деньги держит бухгалтерия, — это старая боль отрасли, и от нас тут мало что зависит.",
          en: "Say brokers take weeks to confirm detention while drivers think accounting is holding the money — an old industry pain, and little of it depends on us.",
        } },
        { key: "accounting_q05_c", pattern: "ownership", text: {
          uz: "Hisobni haydovchi bilan qatorma-qator koʻrib chiqaman, detention yoʻqolmaganini — tasdiq kutilayotganini koʻrsataman va bugunoq dispetcherlikdan soʻrov holatini oʻzim aniqlayman.",
          ru: "Пройду с водителем расчёт строка за строкой, покажу, что detention не потерялся, а ждёт подтверждения, и сегодня же сам уточню у диспетчерской статус запроса.",
          en: "Go through the settlement with the driver line by line, show that the detention is not lost but awaiting confirmation, and check the claim status with dispatch myself today.",
        } },
        { key: "accounting_q05_d", pattern: "victim", text: {
          uz: "Toʻlov ozgina kam chiqsa ham, aybdor sifatida buxgalterga qarashadi — brokerning sustligi uchun har safar men javob berishim adolatdan emasdek tuyuladi.",
          ru: "Стоит выплате оказаться чуть меньше — виноватым смотрят на бухгалтера; отвечать каждый раз за медлительность брокера кажется несправедливым.",
          en: "The moment pay comes out even a little lower, the accountant is looked at as the culprit — answering every time for a broker’s slowness feels unjust.",
        } },
        { key: "accounting_q05_e", pattern: "blame", text: {
          uz: "Avval dispetcherlik detention soʻrovini oʻz vaqtida yuborgan-yubormaganini tekshiraman — kechiktirgan boʻlishsa, haydovchiga tushuntirishni ham oʻshalar berishi toʻgʻri boʻladi.",
          ru: "Сначала проверю, вовремя ли диспетчерская отправила запрос на detention — если затянули, то и объясняться с водителем правильнее им.",
          en: "First check whether dispatch submitted the detention request on time — if they delayed it, it is only right that they be the ones to explain to the driver.",
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
          uz: "Varaq shakli dasturda markazlashgan holda sozlanadi — format yuqorida oʻzgartirilmaguncha, qoʻngʻiroqlarga kelganicha javob beraverishdan boshqa yoʻl yoʻq.",
          ru: "Форма листа настраивается в программе централизованно — пока формат не изменят наверху, остаётся отвечать на звонки по мере поступления.",
          en: "The sheet format is configured centrally in the software — until the format is changed higher up, there is little to do but keep answering the calls as they come.",
        } },
        { key: "accounting_q06_b", pattern: "ownership", text: {
          uz: "Bugunoq escrow qatorini oddiy tilda tushuntiradigan qisqa matn yozaman va shu savol bilan murojaat qilgan har bir haydovchiga oʻzim yuborib boraman.",
          ru: "Сегодня же напишу короткое объяснение строки escrow простым языком и буду сам отправлять его каждому водителю, который обращается с этим вопросом.",
          en: "Write a short plain-language explanation of the escrow line today and start sending it myself to every driver who comes with this question.",
        } },
        { key: "accounting_q06_c", pattern: "complaint", text: {
          uz: "Varaqning koʻrinishi oʻqib boʻlmas darajada ekanini necha marta aytganman — bunday formatda haydovchilar tushunmasligi tabiiy, dastur esa ishni yanada chigallashtiradi.",
          ru: "Сколько раз я говорил, что лист нечитаемый — естественно, что водители не понимают такой формат, а программа только всё усложняет.",
          en: "I have said many times the sheet is unreadable — no wonder drivers do not understand this format, and the software only makes it more tangled.",
        } },
        { key: "accounting_q06_d", pattern: "victim", text: {
          uz: "Kunimning yarmi bitta qatorni qayta-qayta tushuntirishga ketadi — bu mehnatni hech kim hisobga olmaydi, asosiy ishlarim esa orqada qolib, javobini yana oʻzim beraman.",
          ru: "Полдня уходит на то, чтобы снова и снова объяснять одну строку — этот труд никто не учитывает, а основные задачи копятся, и отвечать за них снова мне.",
          en: "Half my day goes to explaining the same line over and over — nobody counts that work, while my main tasks pile up and I am the one answering for them.",
        } },
        { key: "accounting_q06_e", pattern: "builder", text: {
          uz: "Escrow boʻyicha bir sahifalik sodda yodnoma tayyorlayman va uni onbordingga hamda har bir hisob-kitob bilan birga yuborilishini kelishib olaman — bir xil savollar takrorlanmasligi uchun.",
          ru: "Подготовлю одностраничную простую памятку по escrow и договорюсь, чтобы её включили в онбординг и отправляли вместе с каждым расчётом — чтобы одни и те же вопросы не повторялись.",
          en: "Prepare a simple one-page escrow explainer and arrange for it to go into onboarding and out with every settlement — so the same questions stop repeating.",
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
          uz: "Barcha kanallarni — ilova, pochta, dispetcher chatini — hoziroq oʻzim koʻrib chiqaman; hujjat chindan boʻlmasa, haydovchidan suratini toʻgʻridan-toʻgʻri menga yuborishini soʻrab, masalani bugun yopaman.",
          ru: "Сам сейчас проверю все каналы — приложение, почту, чат с диспетчером; если документа действительно нет, попрошу водителя прислать фото напрямую мне и закрою вопрос сегодня.",
          en: "Check every channel myself right now — the app, email, the dispatch chat; if it truly is not there, ask the driver to send a photo directly to me and close this today.",
        } },
        { key: "accounting_q07_b", pattern: "blame", text: {
          uz: "Avval hujjat qayerda yoʻqolganini aniqlash kerak — haydovchi rostdan yuklagan boʻlsa, uni yoʻqotgan tizim yoki boʻlim javob bersin, undan keyin qidiruvga tushaman.",
          ru: "Сначала нужно установить, где потерялся документ — если водитель действительно загрузил его, пусть отвечает система или отдел, который его потерял, а потом уже начну поиски.",
          en: "First it must be established where the document was lost — if the driver really uploaded it, the system or department that lost it should answer, and then I will start searching.",
        } },
        { key: "accounting_q07_c", pattern: "builder", text: {
          uz: "Hujjatni haydovchidan qaytadan olib, hisobni yopaman, soʻng hujjat qabul qilinganda haydovchiga avtomatik tasdiq borishini yoʻlga qoʻyishni taklif qilaman — «men yuborganman» bahslari yoʻqolishi uchun.",
          ru: "Получу документ от водителя заново, закрою расчёт, а затем предложу настроить автоматическое подтверждение водителю о приёме документа — чтобы споры «я же отправлял» исчезли.",
          en: "Get the document from the driver again, close the settlement, then propose an automatic received-confirmation to drivers whenever a document comes in — so the “I did send it” disputes disappear.",
        } },
        { key: "accounting_q07_d", pattern: "complaint", text: {
          uz: "Ilova hujjatlarni tez-tez yoʻqotishini, suratlar esa koʻpincha oʻqib boʻlmas holda kelishini taʼkidlayman — hisob yuritishdan koʻra qogʻoz qidirishga koʻproq vaqt ketadi.",
          ru: "Замечу, что приложение то и дело теряет документы, а фото часто приходят нечитаемыми — на поиски бумаг уходит больше времени, чем на сам учёт.",
          en: "Note that the app keeps losing documents and photos often arrive unreadable — more time goes into hunting paperwork than into the actual accounting.",
        } },
        { key: "accounting_q07_e", pattern: "waiting", text: {
          uz: "Haydovchidan hujjatni rasmiy kanal orqali qayta yuklashni soʻrayman va tizimda paydo boʻlishini kutaman — hujjatsiz yopib boʻlmaydi, summa keyingi toʻlov davriga kiradi.",
          ru: "Попрошу водителя загрузить документ заново через официальный канал и подожду, пока он появится в системе — без документа закрыть нельзя, сумма войдёт в следующий период выплат.",
          en: "Ask the driver to re-upload the document through the official channel and wait for it to appear in the system — it cannot be closed without it, so the amount goes into the next pay cycle.",
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
          uz: "Muddatni provayder buzdi, lekin haydovchi oldida yolgʻonchi boʻlib men qolaman — bergan soʻzim oʻzimga bogʻliq boʻlmagan odamlarga qarab turishi juda noqulay.",
          ru: "Срок сорвал провайдер, а лжецом перед водителем окажусь я — неприятно, что моё слово зависит от людей, на которых я не могу повлиять.",
          en: "The provider broke the deadline, yet I am the one who ends up looking like a liar to the driver — it is unpleasant that my word depends on people I cannot influence.",
        } },
        { key: "accounting_q08_b", pattern: "builder", text: {
          uz: "Haydovchi qoʻngʻiroq qilmasidan oldin oʻzim chiqaman: hisobot kelmaganini va yangi sanani aytaman, provayderga takroriy soʻrov yuboraman va ochiq masalalarni nazorat sanalari bilan roʻyxatga olib boraman.",
          ru: "Выйду на связь раньше, чем позвонит водитель: скажу, что отчёта нет, назову новую дату, отправлю провайдеру повторный запрос и заведу список открытых вопросов с контрольными датами.",
          en: "Reach out before the driver calls: say the report has not come, give a new date, send the provider a repeat request, and keep open items on a list with control dates.",
        } },
        { key: "accounting_q08_c", pattern: "waiting", text: {
          uz: "Yangiliksiz qoʻngʻiroq qilsam, haydovchini bekorga asabiylashtiraman — yaxshisi hisobotni bir-ikki kun boʻlsa ham kutib, keyin toʻliq javob bilan chiqqanim maʼqul.",
          ru: "Звонок без новостей только зря его раздражит — лучше подождать отчёт, пусть даже день-два, и выйти на связь сразу с полным ответом.",
          en: "Calling with no news would only irritate him for nothing — better to wait for the report, even a day or two, and come back with the complete answer at once.",
        } },
        { key: "accounting_q08_d", pattern: "ownership", text: {
          uz: "Kun oxirigacha haydovchiga oʻzim qoʻngʻiroq qilib, maʼlumot hali kelmaganini ochiq aytaman va aniq yangi sana beraman, soʻng provayderdan hisobotni yana talab qilaman.",
          ru: "До конца дня сам позвоню водителю, честно скажу, что данные ещё не пришли, назову конкретную новую дату, а затем снова затребую отчёт у провайдера.",
          en: "Call the driver myself before the end of the day, tell him honestly the data has not arrived, give him a specific new date, and then push the provider for the report again.",
        } },
        { key: "accounting_q08_e", pattern: "blame", text: {
          uz: "Avval provayder muddatni buzganini yozma qayd qilib qoʻyaman — masala kattaroq joyga chiqsa, kechikish buxgalteriyadan emasligi hujjat bilan koʻrinib tursin.",
          ru: "Сначала письменно зафиксирую, что провайдер сорвал срок — если вопрос поднимется выше, пусть по документам будет видно, что задержка не со стороны бухгалтерии.",
          en: "First put on record in writing that the provider missed the deadline — if the matter goes higher, the documents should show the delay is not on accounting’s side.",
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
          uz: "Kechikish toʻliq xavfsizlik boʻlimi tomonida — haydovchiga masala aynan qaysi boʻlimda turganini aytaman: savollar ham oʻsha yerga borishi kerak, biz xulosasiz hech narsa qilolmaymiz.",
          ru: "Задержка целиком на стороне отдела безопасности — скажу водителю, в каком именно отделе стоит вопрос: туда и должны идти звонки, без заключения мы ничего не решаем.",
          en: "The delay is entirely on Safety’s side — I will tell the driver exactly which department is holding it: that is where the calls should go, since we decide nothing without their review.",
        } },
        { key: "accounting_q09_b", pattern: "victim", text: {
          uz: "Boshqa boʻlimning sustligi uchun qoʻngʻiroqlarni yana buxgalteriya qabul qilyapti — biz hech narsani hal qilolmaymiz, lekin haydovchining butun xavotiri bizga toʻkiladi.",
          ru: "За медлительность другого отдела звонки снова принимает бухгалтерия — решить мы ничего не можем, но вся тревога водителя выливается на нас.",
          en: "Once again accounting is fielding the calls for another department’s slowness — we cannot decide anything, yet all the driver’s anxiety is poured onto us.",
        } },
        { key: "accounting_q09_c", pattern: "ownership", text: {
          uz: "Haydovchiga hozirgi holatni ochiq aytaman: tayyor xulosasiz hech qanday ushlanma kiritilmaydi — va bugunoq xavfsizlik boʻlimidan muddatni soʻrab, unga yetkazaman.",
          ru: "Честно объясню водителю текущее положение: без готового заключения никакое удержание не вносится, — и сегодня же запрошу у отдела безопасности срок и передам его водителю.",
          en: "Tell the driver the honest current picture: no deduction is entered without a finished review — and ask Safety today for a timeline so I can pass it on to him.",
        } },
        { key: "accounting_q09_d", pattern: "complaint", text: {
          uz: "Haydovchiga hamdardlik bildirib, bizda boʻlimlararo soʻrovlar doim haftalab yotishini aytaman — bu jarayon azaldan shunaqa sekin, oʻzimiz ham qiynalamiz.",
          ru: "Посочувствую водителю и скажу, что межотдельские запросы у нас всегда лежат неделями — процесс исстари такой медленный, мы и сами от этого страдаем.",
          en: "Sympathize with the driver and say cross-department requests always sit for weeks here — the process has been this slow forever, and we suffer from it too.",
        } },
        { key: "accounting_q09_e", pattern: "builder", text: {
          uz: "Bugun xavfsizlikdan holatni aniqlab, haydovchiga qachon xabar berishimni aytaman, soʻng bunday koʻriklar uchun standart muddat kelishishni taklif qilaman — haydovchilar toʻlovi taqdirini taxmin qilib yurmasligi uchun.",
          ru: "Сегодня уточню статус у безопасности и скажу водителю, когда выйду на связь, а затем предложу согласовать стандартный срок таких разборов — чтобы водители не гадали о судьбе своей выплаты.",
          en: "Clarify the status with Safety today and tell the driver when he will hear from me, then propose a standard turnaround for such reviews — so drivers are not left guessing about their pay.",
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
          uz: "Bunday hajm va doimiy shoshilinchda xatolar boʻlishi tabiiy ekanini yana takrorlayman — hammasini bitta odam tekshirsa, sifatni kutish qiyin; ish tartibi shunga olib kelyapti.",
          ru: "Повторю в очередной раз, что при таких объёмах и вечной спешке ошибки неизбежны — когда всё проверяет один человек, трудно ждать качества; сам порядок работы к этому ведёт.",
          en: "Repeat once more that with these volumes and constant rushing errors are inevitable — when one person checks everything, quality is hard to expect; the way work is set up leads to this.",
        } },
        { key: "accounting_q10_b", pattern: "victim", text: {
          uz: "Xatoni topgan odam oxirida uning javobgariga aylanadi — shoshilinch grafikni men tanlamaganman, lekin gap-soʻz baribir faylga oxirgi tekkan odamga, yaʼni menga qaytadi.",
          ru: "Кто нашёл ошибку, тот в итоге за неё и отвечает — авральный график выбирал не я, но разговоры всё равно вернутся к тому, кто последним касался файла, то есть ко мне.",
          en: "Whoever finds the error ends up answering for it — I did not choose the rushed schedule, yet the talk will still come back to the last person who touched the file, meaning me.",
        } },
        { key: "accounting_q10_c", pattern: "waiting", text: {
          uz: "Tuzatishlar odatda oy yakunida jamlab kiritiladi — yopilgan haftaga hozir yolgʻiz oʻzim tegsam, chalkashlik koʻpayishi mumkin; masalani navbatdagi solishtiruvda koʻtaraman.",
          ru: "Корректировки обычно вносятся пакетом в конце месяца — если я сейчас в одиночку трону закрытую неделю, путаницы может стать больше; подниму вопрос на ближайшей сверке.",
          en: "Corrections are usually entered in a batch at month-end — if I touch a closed week alone right now, there may be more confusion; I will raise it at the next reconciliation.",
        } },
        { key: "accounting_q10_d", pattern: "builder", text: {
          uz: "Xatoni hujjatlashtirib, tuzatishni belgilangan tartibda rasmiylashtiraman, haydovchiga oʻzim xabar beraman va oʻsha haftaning boshqa hisoblarida ham shu xato bor-yoʻqligini tekshirib chiqaman.",
          ru: "Задокументирую ошибку, оформлю корректировку по установленному порядку, сам сообщу водителю и проверю, нет ли той же ошибки в других расчётах за ту неделю.",
          en: "Document the error, put the correction through the standard process, tell the driver myself, and check whether the same slip is in any other settlements from that week.",
        } },
        { key: "accounting_q10_e", pattern: "ownership", text: {
          uz: "Bugunoq xatoni rahbarga bildirib, tuzatishni amaldagi tartib boʻyicha rasmiylashtiraman va haydovchiga nima boʻlgani hamda tuzatish qachon aks etishini oʻzim aytaman.",
          ru: "Сегодня же сообщу об ошибке руководителю, оформлю корректировку по действующему порядку и сам скажу водителю, что произошло и когда исправление отразится в расчёте.",
          en: "Report the error to my manager today, put the correction through the current process, and tell the driver myself what happened and when the correction will show in his settlement.",
        } },
      ],
    },
  ],
};
