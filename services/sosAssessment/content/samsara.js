/**
 * SOS assessment content — Samsara Monitoring department (10 questions).
 *
 * Scope: safety alerts (harsh braking, distraction, following distance),
 * missing video for an event, delayed platform notifications, communicating
 * events to drivers, false/unclear alerts, camera issues, escalation to and
 * follow-up with Safety, repeated risky behavior, system outages, monitoring
 * gaps between shifts, making sure no event is silently missed.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - no option encourages ignoring a safety event, marking events reviewed
 *    without reviewing them, or accusing a driver without evidence;
 *  - platform data genuinely can be late or incomplete — negative options may
 *    lean on that fact, but ownership options verify what they can and
 *    escalate honestly.
 */

module.exports = {
  department: "samsara",
  questions: [
    {
      key: "samsara_q01",
      text: {
        uz: "Yuk mashinasidan qattiq tormozlash boʻyicha ogohlantirish keldi, lekin hodisani ochsangiz, video yuklanmagan — faqat tezlik va joylashuv maʼlumotlari bor. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Пришёл алерт о резком торможении, но, открыв событие, вы видите, что видео не загрузилось — есть только данные о скорости и местоположении. Что вы, скорее всего, сделаете в первую очередь?",
        en: "A harsh-braking alert comes in, but when you open the event, the video did not upload — only speed and location data are there. What would you most likely do first?",
      },
      options: [
        { key: "samsara_q01_a", pattern: "victim", text: {
          uz: "Chala hodisalar negadir doim mening smenamga toʻgʻri keladi, deb oʻylayman — videoni platforma yozmagan boʻlsa ham, «nima boʻlgan» degan savol baribir mendan soʻraladi.",
          ru: "Подумаю: неполные события почему-то всегда выпадают на мою смену — видео не записала платформа, а объяснять, что произошло, всё равно придётся мне.",
          en: "Think that incomplete events somehow always land on my shift — the platform failed to record the video, yet I will be the one asked to explain what happened.",
        } },
        { key: "samsara_q01_b", pattern: "builder", text: {
          uz: "Kameradan videoni qayta soʻrayman, hozir bor maʼlumotlarni jurnalga qayd qilaman, klip kelmasa esa shu mashinada yuklanish muammosi takrorlanmayaptimi — tarixini ham tekshirib qoʻyaman.",
          ru: "Запрошу видео с камеры повторно, зафиксирую в журнале имеющиеся данные, а если ролик так и не придёт, проверю, не повторяется ли на этом грузовике проблема с загрузкой.",
          en: "Re-request the video from the camera, log the data we do have, and if the clip never arrives, check the history to see whether uploads keep failing on this particular truck.",
        } },
        { key: "samsara_q01_c", pattern: "complaint", text: {
          uz: "Hamkasblarga Samsara har ikkinchi hodisada videoni yuklamay qoʻyayotganini aytaman — shunday tizim bilan hodisalarga toʻliq va adolatli baho berish juda qiyin-da.",
          ru: "Скажу коллегам, что Samsara через раз не подгружает видео — с такой системой полноценно и справедливо оценивать события просто трудно.",
          en: "Tell my coworkers that Samsara fails to upload video every other time — with a system like this it is genuinely hard to assess events fully and fairly.",
        } },
        { key: "samsara_q01_d", pattern: "ownership", text: {
          uz: "Bor maʼlumotlarni — tezlik grafigi, joylashuv, vaqt — hoziroq oʻzim tahlil qilaman va hodisani «video mavjud emas» degan halol izoh bilan faktlar asosida qayd qilaman.",
          ru: "Прямо сейчас сам разберу имеющиеся данные — график скорости, место, время — и зафиксирую событие с честной пометкой «видео недоступно», опираясь на факты.",
          en: "Analyze the data that is available right now — the speed graph, location, time — and record the event with an honest “video unavailable” note based on the facts.",
        } },
        { key: "samsara_q01_e", pattern: "waiting", text: {
          uz: "Video baʼzan mashina aloqa zonasiga qaytgach keyinroq yuklanadi — hodisani ochiq qoldirib, klip tushishini kutaman: toʻliq material bilan baho berish toʻgʻriroq boʻladi.",
          ru: "Видео иногда подгружается позже, когда машина возвращается в зону связи — оставлю событие открытым и подожду ролик: оценивать правильнее по полному материалу.",
          en: "Video sometimes uploads later once the truck is back in coverage — I will leave the event open and wait for the clip, since a full picture makes for a fairer review.",
        } },
      ],
    },
    {
      key: "samsara_q02",
      text: {
        uz: "AI kamera haydovchi harakat paytida telefonga qarab ketganini aniqladi, video buni aniq koʻrsatib turibdi. Tartib boʻyicha bu haqda haydovchiga xabar berish kerak. Birinchi navbatda nima qilasiz?",
        ru: "AI-камера зафиксировала, что водитель во время движения смотрел в телефон, и видео это ясно показывает. По регламенту об этом нужно сообщить водителю. Что вы сделаете в первую очередь?",
        en: "The AI camera caught the driver looking at his phone while driving, and the video shows it clearly. Per procedure, the driver must be notified. What would you do first?",
      },
      options: [
        { key: "samsara_q02_a", pattern: "ownership", text: {
          uz: "Haydovchi toʻxtagan payt qoʻngʻiroq qilib, videoda nima koʻringanini xotirjam aytaman, uning izohini eshitaman va suhbat natijasini hodisa yoniga qayd qilib qoʻyaman.",
          ru: "Позвоню, когда водитель остановится, спокойно опишу, что видно на видео, выслушаю его объяснение и зафиксирую итог разговора рядом с событием.",
          en: "Call once the driver is stopped, calmly describe what the video shows, hear his side of it, and log the outcome of the conversation next to the event.",
        } },
        { key: "samsara_q02_b", pattern: "waiting", text: {
          uz: "Haydovchi hozir reysda — bunday suhbat uni battar chalgʻitishi mumkin. Reys tugab, oʻzi bogʻlanganida aytganim maʼqul; unga qadar hodisa hech qayoqqa qochmaydi.",
          ru: "Водитель сейчас в рейсе — такой разговор может отвлечь его ещё больше. Лучше сказать, когда рейс закончится и он сам выйдет на связь; до тех пор событие никуда не денется.",
          en: "The driver is on a run right now — a talk like this could distract him even more. Better to mention it once the trip ends and he checks in himself; the event is not going anywhere.",
        } },
        { key: "samsara_q02_c", pattern: "blame", text: {
          uz: "Avval xavfsizlik boʻlimi u bilan ilgari shu mavzuda ishlaganmi-yoʻqmi, koʻraman — oldin ham oʻqitilgan boʻlsa-yu takrorlansa, endi bu ularning zonasi, ular shugʻullansin.",
          ru: "Сначала посмотрю, работал ли с ним отдел безопасности по этой теме раньше — если инструктаж уже был, а нарушение повторилось, то это их зона, пусть они и занимаются.",
          en: "First check whether Safety has already coached him on this — if he was coached before and it repeated, that is their lane now, and they should be the ones handling it.",
        } },
        { key: "samsara_q02_d", pattern: "builder", text: {
          uz: "Haydovchi toʻxtashi bilanoq u bilan hurmat saqlab gaplashaman, hodisani tartib boʻyicha xavfsizlik boʻlimiga uzataman va bir hafta uning hodisalarini alohida kuzatib boraman.",
          ru: "Как только водитель остановится, уважительно поговорю с ним, передам событие в отдел безопасности по регламенту и неделю буду отдельно следить за его событиями, чтобы это не повторялось.",
          en: "Talk with the driver respectfully as soon as he stops, pass the event to Safety per procedure, and watch his events closely for a week to make sure it does not repeat.",
        } },
        { key: "samsara_q02_e", pattern: "complaint", text: {
          uz: "Ichimda telefon bilan bogʻliq hodisalar oy sayin koʻpayib borayotganidan norozi boʻlaman — haydovchilar ogohlantirishlarimizni jiddiy qabul qilmayapti, gapirishdan deyarli hech narsa oʻzgarmaydi.",
          ru: "Про себя отмечу, что событий с телефоном месяц от месяца всё больше — водители не воспринимают наши предупреждения всерьёз, и от разговоров почти ничего не меняется.",
          en: "Note to myself that phone events keep growing month after month — drivers do not take our warnings seriously, and talking to them barely changes anything.",
        } },
      ],
    },
    {
      key: "samsara_q03",
      text: {
        uz: "Ertalabki tekshiruvda bitta yuk mashinasining yoʻlga qaragan kamerasi uch kundan beri «linza toʻsilgan» holatida turganini payqadingiz — bu vaqt ichida hech kim buni belgilamagan. Birinchi navbatda nima qilasiz?",
        ru: "Во время утренней проверки вы заметили, что дорожная камера одного грузовика уже три дня висит в статусе «объектив перекрыт» — и за это время никто это не отметил. Что вы сделаете в первую очередь?",
        en: "During the morning check you notice one truck’s road-facing camera has shown “lens obstructed” for three days — and no one flagged it in all that time. What would you do first?",
      },
      options: [
        { key: "samsara_q03_a", pattern: "blame", text: {
          uz: "Avval shu kunlarda kim navbatchilik qilganini aniqlayman — kamchilik kimniki ekani ochiq boʻlmasa, uch kunlik «koʻr» mashina uchun javob oxiri menga yopishib qolishi mumkin.",
          ru: "Сначала выясню, кто дежурил в эти дни — если не станет ясно, чьё это упущение, отвечать за три «слепых» дня в итоге может прийтись мне.",
          en: "First establish who was on duty those days — unless it is clear whose miss this was, answering for three blind days could easily end up on me.",
        } },
        { key: "samsara_q03_b", pattern: "ownership", text: {
          uz: "Hoziroq haydovchi bilan bogʻlanib, linzani artish yoki toʻsiqni olib tashlashni soʻrayman, tasvir qaytganini oʻzim tekshiraman va uch kunlik uzilishni sanalari bilan halol qayd qilaman.",
          ru: "Сразу свяжусь с водителем, попрошу протереть объектив или убрать помеху, сам проверю, что картинка вернулась, и честно зафиксирую трёхдневный пробел с датами.",
          en: "Contact the driver right away to wipe the lens or clear the obstruction, verify myself that the picture is back, and honestly log the three-day gap with its dates.",
        } },
        { key: "samsara_q03_c", pattern: "victim", text: {
          uz: "Buni payqagan odam sifatida «nega uch kun koʻrilmadi» degan savollar endi menga beriladi — oʻsha smenalar meniki boʻlmasa ham; ziyraklik uchun shunday «mukofot» alam qiladi.",
          ru: "Раз это заметил я, вопросы «почему три дня никто не видел» теперь достанутся мне — хотя смены были не мои; обидная «награда» за внимательность.",
          en: "Since I am the one who spotted it, the questions about why nobody saw it for three days will now come to me — even though those were not my shifts; a stinging reward for being attentive.",
        } },
        { key: "samsara_q03_d", pattern: "complaint", text: {
          uz: "Rahbarga kamera parki eskirib borayotganini, bunday «koʻr» mashinalar tez-tez chiqib turishini aytaman — shunday texnika bilan toʻliq monitoring haqida gapirish qiyin.",
          ru: "Скажу руководителю, что парк камер стареет и такие «слепые» машины появляются постоянно — с такой техникой говорить о полном мониторинге сложно.",
          en: "Tell the lead that the camera fleet is aging and blind trucks like this keep appearing — with equipment like that, full monitoring is a hard promise to keep.",
        } },
        { key: "samsara_q03_e", pattern: "builder", text: {
          uz: "Bugun haydovchi bilan kamerani ishga keltiraman, soʻng har smena boshida kameralar holatini bir daqiqalik tekshirish odatini taklif qilaman — «koʻr» kamera boshqa kunlab turib qolmasligi uchun.",
          ru: "Сегодня же вместе с водителем верну камеру в строй, а затем предложу минутную проверку состояния камер в начале каждой смены — чтобы «слепая» камера больше не висела днями.",
          en: "Get the camera working with the driver today, then propose a one-minute camera-health check at the start of every shift — so a blind camera never sits unnoticed for days again.",
        } },
      ],
    },
    {
      key: "samsara_q04",
      text: {
        uz: "Ertalab boʻlgan jiddiy hodisa — oldindagi mashinaga xavfli yaqinlashish — platforma lentasida oradan olti soat oʻtib paydo boʻldi; haydovchi bu orada yukni yetkazib ham boʻlgan. Birinchi navbatda nima qilasiz?",
        ru: "Серьёзное событие, произошедшее утром, — опасное сближение с впереди идущей машиной — появилось в ленте платформы только через шесть часов; водитель за это время уже доставил груз. Что вы сделаете в первую очередь?",
        en: "A serious event from this morning — a dangerous following-distance incident — showed up in the platform feed only six hours later; by then the driver had already delivered the load. What would you do first?",
      },
      options: [
        { key: "samsara_q04_a", pattern: "builder", text: {
          uz: "Hodisani hozir koʻrib, xavfsizlik boʻlimiga haqiqiy vaqti bilan uzataman, kechikishni qaydnomaga yozaman va shunday holatlar oʻtib ketmasligi uchun hodisalar tarixini davriy qoʻlda koʻzdan kechirishni taklif qilaman.",
          ru: "Сразу разберу событие и передам его в отдел безопасности с реальным временем, занесу задержку в учёт и предложу периодически вручную просматривать историю событий на случай таких опозданий.",
          en: "Review the event now and send it to Safety with the real occurrence time, log the delay, and propose a periodic manual sweep of event history to catch late arrivals like this.",
        } },
        { key: "samsara_q04_b", pattern: "waiting", text: {
          uz: "Kechikish platforma tomonida — bunday uzilishlarni Samsara odatda oʻzi bartaraf qiladi. Hodisalarni kelgan tartibida koʻraveraman, tizim izga tushguncha biror narsani oʻzgartirmay turaman.",
          ru: "Задержка на стороне платформы — такие сбои Samsara обычно устраняет сама. Буду разбирать события по мере поступления и, пока система не выровняется, ничего менять не стану.",
          en: "The delay is on the platform’s side — Samsara usually resolves glitches like this itself. I will keep working events as they arrive and change nothing until the system settles.",
        } },
        { key: "samsara_q04_c", pattern: "ownership", text: {
          uz: "Kechikkaniga qaramay hodisani hozir toʻliq koʻrib chiqaman, jurnalga sodir boʻlgan haqiqiy vaqtini yozaman va xavfsizlik boʻlimiga kech kelganini ochiq aytaman — atayin ushlab qolinmaganini bilishsin.",
          ru: "Несмотря на опоздание, полностью разберу событие сейчас, укажу в журнале реальное время происшествия и прямо скажу отделу безопасности, что оно пришло с задержкой — чтобы никто не решил, что его придержали.",
          en: "Review the event fully right now despite the delay, log the actual time it happened, and tell Safety openly that it arrived late — so no one assumes it was sat on.",
        } },
        { key: "samsara_q04_d", pattern: "blame", text: {
          uz: "Avval olti soat platforma hisobidan ketganini hujjatlashtiraman — kelish vaqtining skrinshotini olib qoʻyaman: savol tugʻilsa, kechikish kimning tomonida boʻlgani aniq boʻlsin.",
          ru: "Сначала задокументирую, что шесть часов потерялись на стороне платформы — сделаю скриншот времени поступления: если возникнут вопросы, должно быть ясно, чья это задержка.",
          en: "First document that the six hours were lost on the platform’s side — screenshot the arrival timestamp so that if questions come up, it is clear whose delay this was.",
        } },
        { key: "samsara_q04_e", pattern: "victim", text: {
          uz: "Platforma kechiksa ham, javob baribir bizdan soʻraladi, deb oʻylayman — olti soatlik hodisa oʻtib ketgani uchun hech kim Samsaradan emas, monitoringdan xafa boʻladi.",
          ru: "Подумаю: даже когда опаздывает платформа, спрашивают всё равно с нас — за событие шестичасовой давности претензии будут не к Samsara, а к мониторингу.",
          en: "Think that even when the platform is late, the questions still come to us — nobody will hold Samsara accountable for a six-hour-old event, they will hold monitoring.",
        } },
      ],
    },
    {
      key: "samsara_q05",
      text: {
        uz: "Bitta haydovchida shu hafta ichida uchinchi marta qattiq tormozlash hodisasi qayd etildi. Har safar unga standart ogohlantirish yuborilgan, lekin holat takrorlanmoqda. Birinchi navbatda nima qilasiz?",
        ru: "У одного водителя за эту неделю уже третье событие резкого торможения. Каждый раз ему отправлялось стандартное уведомление, но ситуация повторяется. Что вы сделаете в первую очередь?",
        en: "The same driver has logged his third harsh-braking event this week. A standard notification went out each time, yet the pattern continues. What would you do first?",
      },
      options: [
        { key: "samsara_q05_a", pattern: "complaint", text: {
          uz: "Ichimda standart ogohlantirishlar ishlamasligini yana bir bor qayd etaman — haydovchilar ularni ochib ham oʻqimaydi, shuning uchun hech narsa oʻzgarmayotganiga hayron boʻlmasa ham boʻladi.",
          ru: "Про себя в очередной раз отмечу, что стандартные уведомления не работают — водители их даже не открывают, так что удивляться, что ничего не меняется, не приходится.",
          en: "Note once again to myself that the standard notifications do not work — drivers do not even open them, so it is no surprise that nothing is changing.",
        } },
        { key: "samsara_q05_b", pattern: "waiting", text: {
          uz: "Takrorlanayotgan hodisalarni xavfsizlik boʻlimi oylik tahlilda baribir koʻradi — bu holat oʻsha yerda ham chiqadi. Ungacha tartib boʻyicha standart ogohlantirish yuborishda davom etaman.",
          ru: "Повторяющиеся события отдел безопасности всё равно разбирает в месячном обзоре — этот случай там всплывёт. А до тех пор продолжу отправлять стандартные уведомления по регламенту.",
          en: "Safety reviews repeat events in its monthly analysis anyway — this case will surface there. Until then I will keep sending the standard notifications per procedure.",
        } },
        { key: "samsara_q05_c", pattern: "builder", text: {
          uz: "Uch hodisani kliplari bilan bitta xulosaga jamlab, bugunoq xavfsizlik boʻlimiga takrorlanayotgan holat sifatida uzataman va haftasiga uch oʻxshash hodisa yiqqan haydovchini avtomatik belgilash qoidasini taklif qilaman.",
          ru: "Соберу три события с роликами в одну сводку, сегодня же передам в отдел безопасности как повторяющуюся картину и предложу правило: три однотипных события за неделю — автоматическая пометка водителя.",
          en: "Compile the three events with clips into one summary, escalate it to Safety today as a repeating pattern, and propose a rule that auto-flags any driver with three similar events in a week.",
        } },
        { key: "samsara_q05_d", pattern: "victim", text: {
          uz: "Men hammasini tartib boʻyicha yuboryapman, lekin ertaga bu haydovchi biror narsaga uchrasa, javob yana monitoringdan soʻraladi — taʼsir qilolmaydigan xatti-harakat uchun nega biz javobgar boʻlishimiz kerak?",
          ru: "Я всё отправляю по регламенту, но случись с этим водителем что-то завтра — спросят снова с мониторинга; почему мы должны отвечать за поведение, на которое не можем повлиять?",
          en: "I send everything by the book, yet if something happens to this driver tomorrow, monitoring will be the one answering — why should we be responsible for behavior we cannot control?",
        } },
        { key: "samsara_q05_e", pattern: "ownership", text: {
          uz: "Uchala hodisani oʻzim solishtirib, nimasi oʻxshashligini aniqlayman, haydovchi bilan xotirjam gaplashib, nima halaqit berayotganini soʻrayman va holatni bugun xavfsizlik boʻlimiga yetkazaman.",
          ru: "Сам сопоставлю все три события, найду, что в них общего, спокойно поговорю с водителем о том, что ему мешает, и сегодня же доведу ситуацию до отдела безопасности.",
          en: "Compare the three events myself to see what they share, talk calmly with the driver about what is getting in his way, and bring the situation to Safety today.",
        } },
      ],
    },
    {
      key: "samsara_q06",
      text: {
        uz: "Qattiq tormozlash boʻyicha ogohlantirish tushdi, lekin videoda mashina oʻnqir-choʻnqir yoʻl uchastkasidan bir maromda oʻtayotgani koʻrinyapti — hodisa yolgʻon koʻrinadi, haydovchi esa yozuvdan norozi. Birinchi navbatda nima qilasiz?",
        ru: "Сработал алерт о резком торможении, но на видео грузовик ровно проходит разбитый участок дороги — событие выглядит ложным, а водитель недоволен, что оно записано. Что вы сделаете в первую очередь?",
        en: "A harsh-braking alert fired, but the video shows the truck rolling steadily over a rough stretch of road — the event looks false, and the driver is unhappy it was recorded. What would you do first?",
      },
      options: [
        { key: "samsara_q06_a", pattern: "builder", text: {
          uz: "Videoni telemetriya bilan solishtirib, tasdiqlansa hodisani sabab koʻrsatib yolgʻon deb rasmiylashtiraman, haydovchiga u hisobga oʻtmasligini aytaman va joyni belgilab qoʻyaman — shu uchastkada takrorlansa, Samsaraga xabar qilamiz.",
          ru: "Сверю видео с телеметрией, при подтверждении оформлю событие как ложное с указанием причины, сообщу водителю, что оно не будет засчитано, и отмечу место — если на этом участке повторится, сообщим в Samsara.",
          en: "Check the video against the telemetry, file the event as false with the reason if that holds, tell the driver it will not count, and note the spot — repeat triggers there get reported to Samsara.",
        } },
        { key: "samsara_q06_b", pattern: "complaint", text: {
          uz: "Smenadagilarga sezgirlik sozlamalari har kuni shunday shovqin berayotganini aytaman — yolgʻon hodisalar orasida haqiqiylarini ilgʻash tobora qiyin boʻlib boryapti.",
          ru: "Скажу смене, что настройки чувствительности каждый день дают такой шум — среди ложных событий всё труднее выцеплять настоящие.",
          en: "Tell the shift that the sensitivity settings generate noise like this every single day — real events are getting harder and harder to pick out among the false ones.",
        } },
        { key: "samsara_q06_c", pattern: "blame", text: {
          uz: "Avval ogohlantirish chegaralarini oxirgi marta kim sozlaganini aniqlayman — sozlamalar monitoring bilan kelishilmay oʻzgartirilgan boʻlsa, bu shovqin oʻsha oʻzgartirgan tomonning zimmasida.",
          ru: "Сначала выясню, кто последним настраивал пороги срабатывания — если параметры меняли, не согласовав с мониторингом, этот шум на совести того, кто их менял.",
          en: "First find out who last tuned the alert thresholds — if the settings were changed without checking with monitoring, this noise is on whoever changed them.",
        } },
        { key: "samsara_q06_d", pattern: "ownership", text: {
          uz: "Klipni tezlik va G-kuch maʼlumotlari bilan oʻzim solishtiraman; hodisa chindan yolgʻon boʻlsa, izoh yozib shunday rasmiylashtiraman va haydovchiga tekshirilib, hisobdan chiqarilganini aytaman.",
          ru: "Сам сверю ролик с данными скорости и перегрузок; если событие действительно ложное, оформлю его с пояснением и скажу водителю, что оно проверено и снято.",
          en: "Compare the clip with the speed and g-force data myself; if the event really is false, file it with an explanation and tell the driver it was reviewed and cleared.",
        } },
        { key: "samsara_q06_e", pattern: "waiting", text: {
          uz: "Hozircha hech qanday belgi qoʻymay turaman — bunday holatni qanday tasniflash boʻyicha xavfsizlik boʻlimi javob bergunicha hodisa ochiq tursin: notoʻgʻri tasnif keyin qimmatga tushishi mumkin.",
          ru: "Пока не буду ставить никаких отметок — пусть событие висит открытым, пока отдел безопасности не подскажет, как классифицировать такие случаи: неверная классификация потом может дорого обойтись.",
          en: "Hold off on marking anything for now — leave the event open until Safety advises how to classify cases like this, since a wrong classification could be costly later.",
        } },
      ],
    },
    {
      key: "samsara_q07",
      text: {
        uz: "Smenani qabul qilib olganingizda oldingi smenaning soʻnggi soatlaridan yigirmaga yaqin hodisa umuman koʻrilmay qolganini koʻrdingiz — orasida jiddiylari ham bor. Birinchi navbatda nima qilasiz?",
        ru: "Принимая смену, вы обнаружили около двадцати событий за последние часы предыдущей смены, которые вообще никто не просмотрел — среди них есть и серьёзные. Что вы сделаете в первую очередь?",
        en: "Taking over the shift, you find about twenty events from the previous shift’s final hours that no one reviewed at all — some of them serious. What would you do first?",
      },
      options: [
        { key: "samsara_q07_a", pattern: "ownership", text: {
          uz: "Eng jiddiy hodisalardan boshlab qolgan navbatni hoziroq oʻzim koʻrib chiqaman va rahbarga uzilish boʻlganini ochiq aytaman — kun manzarasi aniq boʻlishi kerak.",
          ru: "Прямо сейчас сам начну разбирать очередь, начиная с самых серьёзных событий, и открыто скажу руководителю, что был пропуск — картина дня должна быть точной.",
          en: "Start clearing the queue myself right now, most serious events first, and tell the lead openly that there was a gap — the day’s picture has to be accurate.",
        } },
        { key: "samsara_q07_b", pattern: "victim", text: {
          uz: "Smenam yana birovning qoldigʻini tozalashdan boshlanyapti — boshqalarning soatlarini yopaman, oxirida esa koʻrsatkichlari sust chiqqan xodim men boʻlib qolaman.",
          ru: "Моя смена опять начинается с чужих хвостов — разгребаю чужие часы, а в итоге сотрудником с просевшими показателями окажусь я.",
          en: "My shift is starting with someone else’s backlog again — I clear their hours, and in the end I will be the one whose numbers look slow.",
        } },
        { key: "samsara_q07_c", pattern: "builder", text: {
          uz: "Avval jiddiylarini saralab yopaman, soʻng smena topshirishda navbat holati yoziladigan qisqa qabul-topshirish qaydnomasini taklif qilaman — uzilish soatlab emas, topshirish paytida sezilsin.",
          ru: "Сначала отсортирую и закрою серьёзные, а затем предложу короткую передаточную записку со статусом очереди при смене — чтобы пропуск замечали в момент передачи, а не спустя часы.",
          en: "Triage and clear the serious ones first, then propose a short handoff note with queue status at every shift change — so a gap is caught at handover, not hours later.",
        } },
        { key: "samsara_q07_d", pattern: "blame", text: {
          uz: "Avval jurnaldan oʻsha soatlarda kim ishlaganini va navbat nega toʻxtab qolganini aniqlayman — uzilish kimdan chiqqani ochiqlanmasa, xuddi shu holat yana takrorlanaveradi.",
          ru: "Сначала посмотрю по журналу, кто работал в те часы и почему очередь стояла, — пока не станет ясно, чей это пропуск, то же самое будет повторяться снова.",
          en: "First check the logs for who was on in those hours and why the queue stood still — until it is clear whose gap this was, the same thing will just keep happening.",
        } },
        { key: "samsara_q07_e", pattern: "complaint", text: {
          uz: "Hamkasblarga tungi smenada odam yetishmasligini, bunday navbatlar shunchaki muqarrar ekanini aytaman — bu haqda hamma biladi, lekin jadval oʻzgargani yoʻq.",
          ru: "Скажу коллегам, что людей в ночную смену не хватает и такие очереди просто неизбежны — об этом все знают, но график так и не поменяли.",
          en: "Tell coworkers the night shift is understaffed and queues like this are simply inevitable — everyone knows about it, yet the schedule has never changed.",
        } },
      ],
    },
    {
      key: "samsara_q08",
      text: {
        uz: "Smenangiz oʻrtasida Samsara portali ochilmay qoldi — jonli hodisalar qirq daqiqadan beri kelmayapti. Holat sahifasi uzilish ularning tomonida ekanini tasdiqlayapti. Birinchi navbatda nima qilasiz?",
        ru: "В середине вашей смены портал Samsara перестал открываться — живые события не приходят уже сорок минут. Страница статуса подтверждает: сбой на их стороне. Что вы сделаете в первую очередь?",
        en: "In the middle of your shift the Samsara portal stops loading — no live events for forty minutes now. The status page confirms the outage is on their side. What would you do first?",
      },
      options: [
        { key: "samsara_q08_a", pattern: "waiting", text: {
          uz: "Muammo yetkazib beruvchi tomonida — bizga bogʻliq narsa yoʻq. Holat sahifasida «bartaraf etildi» degan belgi chiqishini kutaman, keyin odatdagidek ishlashda davom etaman.",
          ru: "Проблема на стороне поставщика — от нас тут ничего не зависит. Дождусь на странице статуса отметки «устранено» и продолжу работать в обычном режиме.",
          en: "The problem is on the vendor’s side — there is nothing that depends on us here. I will wait for the status page to show resolved and then carry on as usual.",
        } },
        { key: "samsara_q08_b", pattern: "builder", text: {
          uz: "Rahbar va xavfsizlik boʻlimini darhol ogohlantiraman, uzilish davrida dispetcherlardan haydovchilardagi shoshilinch holatlarni telefon orqali yetkazib turishni soʻrayman, soʻng shunday holatlar uchun qisqa yozma tartib taklif qilaman.",
          ru: "Сразу предупрежу руководителя и отдел безопасности, попрошу диспетчеров на время сбоя передавать срочное от водителей по телефону, а затем предложу короткий письменный порядок действий на такие случаи.",
          en: "Alert the lead and Safety at once, ask dispatch to phone in anything urgent from drivers while the outage lasts, and afterwards propose a short written procedure for cases like this.",
        } },
        { key: "samsara_q08_c", pattern: "blame", text: {
          uz: "Avval uzilish platformada boʻlgani hujjatlashtirilishini taʼminlayman — holat sahifasining skrinshotini rahbariyatga yuboraman: bu boʻshliq keyin monitoring aybiga yozib qoʻyilmasin.",
          ru: "Первым делом позабочусь, чтобы было задокументировано: сбой у платформы — отправлю руководству скриншот страницы статуса, чтобы этот пробел потом не записали на мониторинг.",
          en: "First make sure it is documented that the outage is the platform’s — send management a screenshot of the status page so the gap does not get pinned on monitoring later.",
        } },
        { key: "samsara_q08_d", pattern: "victim", text: {
          uz: "Shunday uzilish aynan mening smenamga toʻgʻri kelganini qarang — shu oynada yoʻlda biror narsa boʻlsa, «nega koʻrmadingiz» deb mendan soʻrashadi, platforma esa meniki emas.",
          ru: "Надо же, такой сбой выпал именно на мою смену — случись что-то на дороге в это окно, «почему не видели» спросят у меня, хотя платформа не моя.",
          en: "Of course an outage like this lands on my shift — if anything happens on the road during this window, I will be asked why nobody saw it, though the platform is not mine.",
        } },
        { key: "samsara_q08_e", pattern: "ownership", text: {
          uz: "Rahbar va xavfsizlik boʻlimini jonli monitoring toʻxtaganidan darhol xabardor qilaman, uzilish boshlangan vaqtni yozib qoʻyaman va aloqa tiklangach, «koʻr» oynadagi hamma hodisani oʻzim koʻrib chiqaman.",
          ru: "Сразу предупрежу руководителя и отдел безопасности, что живой мониторинг остановился, зафиксирую время начала сбоя, а после восстановления сам просмотрю все события «слепого» окна.",
          en: "Alert the lead and Safety right away that live monitoring is down, note when the outage began, and once it is restored, review every event from the blind window myself.",
        } },
      ],
    },
    {
      key: "samsara_q09",
      text: {
        uz: "Ikki kun oldin jiddiy hodisani — toʻqnashuvga yaqin holat videosini — xavfsizlik boʻlimiga koʻrib chiqish uchun uzatgansiz. Javob yoʻq, bugun esa oʻsha haydovchida masofa saqlash boʻyicha yangi ogohlantirish paydo boʻldi. Birinchi navbatda nima qilasiz?",
        ru: "Два дня назад вы передали в отдел безопасности серьёзное событие — видео ситуации, близкой к столкновению. Ответа нет, а сегодня у того же водителя появился новый алерт по дистанции. Что вы сделаете в первую очередь?",
        en: "Two days ago you escalated a serious event to Safety — video of a near-collision. There has been no response, and today the same driver has a new following-distance alert. What would you do first?",
      },
      options: [
        { key: "samsara_q09_a", pattern: "complaint", text: {
          uz: "Yaqin hamkasbimga eskalatsiyalarimiz xavfsizlik boʻlimida javobsiz yotib qolayotganini aytaman — biz belgilaymiz, ular ochmaydi ham; bunda monitoring mehnatining maʼnosi qolmayapti.",
          ru: "Поделюсь с коллегой, что наши эскалации лежат в отделе безопасности без ответа — мы отмечаем, а там даже не открывают; смысл работы мониторинга так теряется.",
          en: "Tell a close coworker that our escalations just sit unanswered with Safety — we flag things and they do not even open them; monitoring’s work loses its meaning that way.",
        } },
        { key: "samsara_q09_b", pattern: "victim", text: {
          uz: "Monitoring nima qilmasin, natija baribir boshqalarga bogʻliq — men hammasini oʻz vaqtida uzatganman, endi biror narsa yuz bersa, aybdor baribir qandaydir yoʻl bilan men boʻlib chiqaman.",
          ru: "Что бы мониторинг ни делал, итог всё равно зависит от других — я всё передал вовремя, но если теперь что-то случится, виноватым каким-то образом снова окажусь я.",
          en: "Whatever monitoring does, the outcome depends on others — I escalated everything on time, yet if something happens now, the blame will somehow land on me anyway.",
        } },
        { key: "samsara_q09_c", pattern: "ownership", text: {
          uz: "Bugunoq xavfsizlik boʻlimiga oʻzim chiqaman: ishni qayta yuboraman, yangi ogohlantirishni ham qoʻshaman va suhbat oʻtkazilgan-oʻtkazilmaganini toʻgʻridan-toʻgʻri soʻrayman; ikkala hodisani jurnalda bogʻlab qoʻyaman.",
          ru: "Сегодня же сам выйду на отдел безопасности: повторно отправлю кейс, приложу новый алерт и прямо спрошу, была ли проведена беседа; оба события свяжу в журнале.",
          en: "Reach out to Safety myself today: resend the case, attach the new alert, and ask directly whether the coaching happened; link both events together in the log.",
        } },
        { key: "samsara_q09_d", pattern: "builder", text: {
          uz: "Ikkala hodisani bogʻlab xavfsizlik rahbariga yozaman, bugun kim qadam tashlashini aniq kelishib olaman va har bir eskalatsiya uchun tasdiq hamda muddat belgilash qoidasini taklif qilaman — ishlar jimgina osilib qolmasligi uchun.",
          ru: "Напишу руководителю отдела безопасности, связав оба события, договорюсь, кто и что делает сегодня, и предложу правило: каждая эскалация получает подтверждение и срок — чтобы кейсы не зависали молча.",
          en: "Write to the Safety lead linking both events, agree on who acts today, and propose that every escalation gets an acknowledgment and a deadline — so cases can never hang silently.",
        } },
        { key: "samsara_q09_e", pattern: "blame", text: {
          uz: "Avval eskalatsiya oʻz vaqtida yetkazilganini koʻrsatuvchi yozishmalarni yigʻib qoʻyaman — bu haydovchi biror hodisaga uchrasa, kechikish bizda emas, xavfsizlik boʻlimida boʻlgani hujjat bilan aniq tursin.",
          ru: "Сначала соберу переписку, подтверждающую, что эскалация была передана вовремя, — если с этим водителем что-то случится, должно быть документально ясно, что задержка не у нас, а в отделе безопасности.",
          en: "First gather the correspondence showing the escalation went out on time — if something happens with this driver, it must be documented that the delay was Safety’s, not ours.",
        } },
      ],
    },
    {
      key: "samsara_q10",
      text: {
        uz: "Tarixni koʻrib chiqayotib, bir hafta oldingi jiddiy hodisa — video bilan qayd etilgan xavfli manevr — umuman koʻrilmaganini tasodifan aniqladingiz: u navbat filtri sababli odatiy roʻyxatga tushmagan. Birinchi navbatda nima qilasiz?",
        ru: "Просматривая историю, вы случайно обнаружили серьёзное событие недельной давности — опасный манёвр, записанный на видео, — которое никто так и не просмотрел: из-за фильтра очереди оно не попало в обычный список. Что вы сделаете в первую очередь?",
        en: "Going through the history, you stumble on a serious week-old event — a dangerous maneuver caught on video — that no one ever reviewed: a queue filter kept it out of the usual list. What would you do first?",
      },
      options: [
        { key: "samsara_q10_a", pattern: "waiting", text: {
          uz: "Bir hafta oldingi hodisani qanday rasmiylashtirishni aniqlash uchun rahbarim qaytishini kutaman — eski hodisani notoʻgʻri kiritib chalkashlik chiqargandan koʻra, ertaga aniqlik bilan qilingani tuzuk.",
          ru: "Подожду возвращения руководителя, чтобы уточнить, как оформлять событие недельной давности, — лучше внести его завтра правильно, чем создать путаницу неверной записью.",
          en: "Wait for my supervisor to be back so I can ask how to file a week-old event — better to enter it correctly tomorrow than create confusion with a wrong record.",
        } },
        { key: "samsara_q10_b", pattern: "ownership", text: {
          uz: "Hodisani hozir toʻliq koʻrib chiqaman, xavfsizlik boʻlimiga filtr sababli kech topilganini yashirmay uzataman va oʻsha filtr ortida yana koʻrilmagan hodisalar qolmaganini darrov tekshiraman.",
          ru: "Полностью разберу событие сейчас, передам его в отдел безопасности, не скрывая, что оно нашлось поздно из-за фильтра, и сразу проверю, не осталось ли за этим фильтром других непросмотренных событий.",
          en: "Review the event fully now, send it to Safety without hiding that the filter surfaced it late, and immediately check whether more unreviewed events sit behind that same filter.",
        } },
        { key: "samsara_q10_c", pattern: "victim", text: {
          uz: "Filtrni men sozlamaganman, lekin topgan men boʻlganim uchun bir haftalik oʻtkazib yuborish boʻyicha savollar endi menga beriladi — sinchkovlik uchun jazolanayotgandek his qilaman.",
          ru: "Фильтр настраивал не я, но раз нашёл его я, вопросы о недельном пропуске теперь зададут мне — ощущение, будто наказывают за внимательность.",
          en: "I did not set up that filter, but since I found the event, the questions about a week-long miss will come to me — it feels like being punished for paying attention.",
        } },
        { key: "samsara_q10_d", pattern: "complaint", text: {
          uz: "Jamoa chatiga navbat filtrlari chalkash sozlanganini, hodisalar shu tarzda «koʻzdan yashirinib» qolayotganini yozaman — interfeys shunday ishlar ekan, oʻtkazib yuborishlar boʻlaverishi tayin.",
          ru: "Напишу в командный чат, что фильтры очереди настроены запутанно и события вот так «прячутся» — пока интерфейс работает таким образом, пропуски будут неизбежны.",
          en: "Write in the team chat that the queue filters are set up confusingly and events keep hiding like this — as long as the interface works this way, misses are guaranteed.",
        } },
        { key: "samsara_q10_e", pattern: "builder", text: {
          uz: "Hodisani bugun koʻrib, haqiqiy vaqtini koʻrsatib eskalatsiya qilaman, muammoli filtrni toʻgʻrilataman va hech narsa koʻrinmay qolmasligi uchun haftalik toʻliq tarix tekshiruvini joriy etishni taklif qilaman.",
          ru: "Сегодня же разберу событие и эскалирую его с реальным временем, добьюсь исправления проблемного фильтра и предложу еженедельную сверку полной истории — чтобы ничто не могло остаться незамеченным.",
          en: "Review and escalate the event today with its real timing, get the faulty filter fixed, and propose a weekly full-history cross-check so nothing can ever sit unseen again.",
        } },
      ],
    },
  ],
};
