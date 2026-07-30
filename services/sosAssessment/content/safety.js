/**
 * SOS assessment content — Safety department (10 questions).
 *
 * Scope: driver safety violations, repeated violations, retraining and driver
 * resistance to it, missing/late safety documents, accident follow-up,
 * roadside DOT inspections, dispatch pressure vs. safety holds, preventive
 * safety work, corrective action, safety communication with drivers.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - NO option — including the negative ones — ever suggests bending FMCSA/HOS
 *    rules, skipping documents or evidence, lifting a safety hold, or dodging
 *    escalation; the flaw in negative options is mindset, never rule-breaking.
 */

module.exports = {
  department: "safety",
  questions: [
    {
      key: "safety_q01",
      text: {
        uz: "ELD tizimi kecha bir haydovchi ruxsat etilgan haydash vaqtidan yigirma daqiqa oshirib yuborganini koʻrsatdi. Haydovchi hozir keyingi yukka tayinlangan. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Система ELD показала, что вчера один из водителей превысил разрешённое время вождения на двадцать минут. Сейчас водитель назначен на следующий груз. Что вы, скорее всего, сделаете в первую очередь?",
        en: "The ELD system shows that yesterday one of the drivers went twenty minutes over his allowed driving time. He is now assigned to the next load. What would you most likely do first?",
      },
      options: [
        { key: "safety_q01_a", pattern: "waiting", text: {
          uz: "ELD baʼzan notoʻgʻri yozib qoʻyadi — haydovchi loglarini tasdiqlashini va haftalik log tekshiruvi natijasini kutaman: tasdiqlanmagan maʼlumot bilan gap ochmayman.",
          ru: "ELD иногда пишет с ошибками — дождусь, пока водитель заверит логи и пройдёт еженедельная проверка: не буду поднимать вопрос по неподтверждённым данным.",
          en: "ELD sometimes records things wrong — I will wait for the driver to certify his logs and for the weekly log audit: no point raising it on unconfirmed data.",
        } },
        { key: "safety_q01_b", pattern: "complaint", text: {
          uz: "Hamkasblarga har oy HOS mavzusini qaytadan tushuntirayotganimizni, ahvol esa oʻzgarmayotganini aytaman — treninglar haydovchilarga yetib bormayapti.",
          ru: "Скажу коллегам, что мы каждый месяц заново объясняем тему HOS, а картина не меняется — тренинги до водителей просто не доходят.",
          en: "Tell my coworkers that we re-explain HOS every single month and nothing changes — the trainings are simply not getting through to drivers.",
        } },
        { key: "safety_q01_c", pattern: "ownership", text: {
          uz: "Bugunoq logni oʻzim ochib, oshib ketish qayerda boshlanganini aniqlayman, haydovchi bilan sababini gaplashaman va holatni belgilangan tartib boʻyicha rasmiylashtiraman.",
          ru: "Сегодня же сам открою лог, определю, где началось превышение, поговорю с водителем о причине и оформлю случай по установленному порядку.",
          en: "Open the log myself today, pinpoint where the overage began, talk with the driver about the cause, and document the case according to procedure.",
        } },
        { key: "safety_q01_d", pattern: "victim", text: {
          uz: "Soatni haydovchi oshiradi, hisobini esa xavfsizlik boʻlimi beradi — nega har bir buzilish oxir-oqibat mening boʻynimga tushishini tushunmayman.",
          ru: "Часы превышает водитель, а отчитывается отдел безопасности — не понимаю, почему каждое нарушение в итоге ложится на меня.",
          en: "The driver is the one who goes over his hours, yet Safety answers for it — I do not understand why every violation ultimately lands on me.",
        } },
        { key: "safety_q01_e", pattern: "builder", text: {
          uz: "Holatni rasmiylashtirib haydovchi bilan gaplashaman, soʻng limitga bir soat qolganda haydovchi va dispetcherga ogohlantirish boradigan tartibni yoʻlga qoʻyishni taklif qilaman.",
          ru: "Оформлю случай и поговорю с водителем, а затем предложу настроить предупреждение водителю и диспетчеру, когда до лимита остаётся час.",
          en: "Document the case and talk with the driver, then propose setting up an alert to the driver and dispatcher whenever one hour remains before the limit.",
        } },
      ],
    },
    {
      key: "safety_q02",
      text: {
        uz: "Telematika bir haydovchi shu oy ichida uchinchi marta tezlikni oshirganini koʻrsatdi. Birinchi holatdan keyin u bilan ogohlantiruvchi suhbat oʻtkazilgan edi. Birinchi navbatda nima qilasiz?",
        ru: "Телематика показала, что один водитель уже в третий раз за месяц превышает скорость. После первого случая с ним проводили предупредительную беседу. Что вы сделаете в первую очередь?",
        en: "Telematics shows a driver speeding for the third time this month. After the first case he was given a warning conversation. What would you do first?",
      },
      options: [
        { key: "safety_q02_a", pattern: "builder", text: {
          uz: "Qoidada belgilangan keyingi choraga bugunoq oʻtaman va har bir takror buzilishdan keyin qaysi qadam kelishini haydovchilarga oldindan eʼlon qilinadigan aniq shkalani taklif qilaman.",
          ru: "Сегодня же перейду к следующей мере по правилам и предложу понятную шкалу: какой шаг следует за каждым повторным нарушением, объявленную водителям заранее.",
          en: "Move to the next corrective step today as the policy requires, and propose a clear ladder announced to drivers in advance: which step follows each repeat violation.",
        } },
        { key: "safety_q02_b", pattern: "blame", text: {
          uz: "Avval birinchi suhbatni kim oʻtkazganini va u qanday rasmiylashtirilganini tekshiraman — dastlabki qadam chala qilingan boʻlsa, takror aynan shundan kelib chiqqan boʻlishi mumkin.",
          ru: "Сначала проверю, кто проводил первую беседу и как она была оформлена — если начальный шаг сделали кое-как, повтор мог пойти именно оттуда.",
          en: "First check who held the initial conversation and how it was documented — if that first step was done halfway, the repeat may stem from exactly that.",
        } },
        { key: "safety_q02_c", pattern: "waiting", text: {
          uz: "Bunday qarorlar oy yakunidagi xavfsizlik yigʻilishida birgalikda koʻrib chiqiladi — holatni roʻyxatga qoʻshaman va yigʻilishgacha qoʻshimcha chora qoʻllamay turaman.",
          ru: "Такие решения у нас разбираются на месячном собрании по безопасности — внесу случай в список и до собрания воздержусь от дополнительных мер.",
          en: "Decisions like this are reviewed at the monthly safety meeting — I will add the case to the list and hold off on further measures until then.",
        } },
        { key: "safety_q02_d", pattern: "complaint", text: {
          uz: "Rahbarga suhbatlarning bunday haydovchilarga taʼsiri yoʻqligini aytaman — bir oyda uch marta takrorlangan boʻlsa, gap bilan natija chiqmasligi koʻrinib turibdi.",
          ru: "Скажу руководителю, что беседы на таких водителей не действуют — если за месяц три повтора, словами результата явно не добиться.",
          en: "Tell my manager that conversations do not work on drivers like this — three repeats in one month makes it clear words alone get no result.",
        } },
        { key: "safety_q02_e", pattern: "ownership", text: {
          uz: "Uning tezlik hisobotini oʻzim koʻrib chiqaman, bugun haydovchi bilan ochiq gaplashaman va qoidada nazarda tutilgan navbatdagi chorani rasmiylashtiraman.",
          ru: "Сам просмотрю его отчёт по скорости, сегодня открыто поговорю с водителем и оформлю следующую меру, предусмотренную правилами.",
          en: "Review his speed report myself, have a direct conversation with the driver today, and document the next step that the policy prescribes.",
        } },
      ],
    },
    {
      key: "safety_q03",
      text: {
        uz: "Keskin tormozlash hodisalari koʻpaygani uchun bir haydovchiga qayta trening tayinlandi. U esa oʻn besh yillik tajribasi borligini aytib, treningdan oʻtishdan bosh tortmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Водителю назначили повторный тренинг из-за участившихся резких торможений. Он отказывается его проходить, ссылаясь на пятнадцать лет стажа. Что вы сделаете в первую очередь?",
        en: "A driver was assigned refresher training because of a rise in hard-braking events. He refuses to take it, pointing to his fifteen years of experience. What would you do first?",
      },
      options: [
        { key: "safety_q03_a", pattern: "complaint", text: {
          uz: "Hamkasblarga tajribali haydovchilar bilan ishlash eng ogʻir ekanini aytaman — ular har qanday xavfsizlik talabini oʻzlariga hujum sifatida qabul qiladi.",
          ru: "Скажу коллегам, что с опытными водителями тяжелее всего — любое требование по безопасности они воспринимают как выпад в свой адрес.",
          en: "Tell coworkers that experienced drivers are the hardest to work with — they take any safety requirement as a personal attack.",
        } },
        { key: "safety_q03_b", pattern: "ownership", text: {
          uz: "U bilan bugun gaplashib, treningga sabab boʻlgan aniq hodisalarni sanalari bilan koʻrsataman, savollarini tinglayman va talab kuchda qolishini xotirjam tushuntiraman.",
          ru: "Сегодня поговорю с ним, покажу конкретные события с датами, из-за которых назначен тренинг, выслушаю его вопросы и спокойно объясню, что требование остаётся в силе.",
          en: "Talk with him today, show the specific dated events that triggered the training, hear his questions out, and calmly explain that the requirement stands.",
        } },
        { key: "safety_q03_c", pattern: "blame", text: {
          uz: "Avval kamera tizimini sozlagan pudratchi hodisalarni notoʻgʻri belgilamaganini tekshiraman — chegaralar xato qoʻyilgan boʻlsa, javobni haydovchidan emas, oʻsha tomondan soʻrash kerak.",
          ru: "Сначала проверю, не размечает ли события неверно система камер, которую настраивал подрядчик, — если пороги выставлены с ошибкой, спрашивать нужно с них, а не с водителя.",
          en: "First check whether the camera system the vendor configured is flagging events incorrectly — if the thresholds are off, the answer should come from them, not the driver.",
        } },
        { key: "safety_q03_d", pattern: "builder", text: {
          uz: "Hodisalar yozuvini u bilan birga koʻrib chiqaman va talabni saqlab qolaman, soʻng trening tayinlanganda haydovchiga oʻz videolarini darhol koʻrsatish tartibini taklif qilaman — eʼtiroz kamayadi.",
          ru: "Разберу записи событий вместе с ним и оставлю требование в силе, а затем предложу сразу показывать водителю его собственные видео при назначении тренинга — возражений станет меньше.",
          en: "Go through the event recordings with him and keep the requirement, then propose showing drivers their own videos right when training is assigned — it will cut down the pushback.",
        } },
        { key: "safety_q03_e", pattern: "victim", text: {
          uz: "Haydovchilar bilan tortishish doim menga qoladi: boshqalar vaʼda berib yaxshi boʻlib qolaveradi, talab qoʻygani uchun esa butun norozilik xavfsizlikka yogʻiladi.",
          ru: "Спорить с водителями всегда достаётся мне: другие раздают обещания и остаются хорошими, а всё недовольство сыплется на безопасность, потому что требуем мы.",
          en: "Arguing with drivers always falls to me: others hand out promises and stay the good guys, while all the resentment pours onto Safety because we do the demanding.",
        } },
      ],
    },
    {
      key: "safety_q04",
      text: {
        uz: "Haydovchining meditsina sertifikati besh kundan keyin tugaydi. Ikki marta eslatma yubordingiz, javob yoʻq, oʻzi hozir reysda. Birinchi navbatda nima qilasiz?",
        ru: "Медицинский сертификат водителя истекает через пять дней. Вы дважды отправили напоминание, ответа нет, сам он сейчас в рейсе. Что вы сделаете в первую очередь?",
        en: "A driver’s medical certificate expires in five days. You have sent two reminders with no reply, and he is currently on a run. What would you do first?",
      },
      options: [
        { key: "safety_q04_a", pattern: "victim", text: {
          uz: "Birovning hujjati deb yugurish yana menga qoldi — muddat oʻtib ketsa, eslatmalarni oʻz vaqtida yuborganimga qaramay, aybdor baribir xavfsizlik boʻladi.",
          ru: "Опять мне бегать из-за чужого документа — если срок пройдёт, виноватой всё равно окажется безопасность, хотя напоминания я отправил вовремя.",
          en: "Once again I am the one chasing someone else’s document — if the date slips, Safety will still be blamed, even though I sent the reminders on time.",
        } },
        { key: "safety_q04_b", pattern: "waiting", text: {
          uz: "Haydovchi hozir yuk ostida — chalgʻitmay, reysni topshirib qaytgunicha kutaman: masalani yuzma-yuz, xotirjam hal qilamiz, hali besh kun vaqt bor.",
          ru: "Водитель сейчас под грузом — не буду отвлекать и подожду, пока он сдаст рейс: решим вопрос лично и спокойно, пять дней ещё есть.",
          en: "He is under a load right now — rather than distract him, I will wait until he delivers: we will settle it face to face and calmly, there are still five days.",
        } },
        { key: "safety_q04_c", pattern: "builder", text: {
          uz: "Dispetcher orqali bugunoq bogʻlanib, yoʻnalishi boʻyidagi klinikadan dam olish vaqtiga qabul topishga yordam beraman, keyin barcha muddatlarni umumiy kalendarga oldinroq eslatmalar bilan kiritaman.",
          ru: "Сегодня же свяжусь с ним через диспетчера, помогу найти клинику по его маршруту на время отдыха, а затем занесу все сроки в общий календарь с более ранними напоминаниями.",
          en: "Reach him through dispatch today, help find a clinic along his route for his off-duty time, then put every expiry date into a shared calendar with earlier reminders.",
        } },
        { key: "safety_q04_d", pattern: "blame", text: {
          uz: "Avval uning fayli nega shu ahvolga yetganini aniqlayman — muddatlarni kuzatish kimga biriktirilgan boʻlsa, ish nima uchun oxirgi besh kunga qolganini oʻsha tushuntirsin.",
          ru: "Сначала выясню, почему его файл дошёл до такого состояния — за кем закреплён контроль сроков, тот пусть и объяснит, почему всё осталось на последние пять дней.",
          en: "First establish how his file got to this point — whoever is assigned to track expirations should explain why it came down to the last five days.",
        } },
        { key: "safety_q04_e", pattern: "ownership", text: {
          uz: "Dispetcher orqali hoziroq unga chiqaman, sanani va sertifikatsiz haydash mumkin emasligini aniq aytaman, tibbiy koʻrikka qanday ulgurishini u bilan bugunoq rejalashtiraman.",
          ru: "Прямо сейчас выйду на него через диспетчера, чётко назову дату и что без сертификата ездить нельзя, и сегодня же спланирую с ним, как он успеет пройти осмотр.",
          en: "Get through to him via dispatch right now, state the date clearly and that he cannot drive without the certificate, and plan with him today how he will fit in the exam.",
        } },
      ],
    },
    {
      key: "safety_q05",
      text: {
        uz: "Kompaniya kabinaga qaragan kameralarni joriy qildi. Bir haydovchi sizga yozib, bu kuzatuv ekanini va kamerasi oʻchirilmasa ishdan ketishini aytmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Компания ввела камеры, направленные в кабину. Один водитель пишет вам, что это слежка, и грозит уволиться, если его камеру не отключат. Что вы сделаете в первую очередь?",
        en: "The company has rolled out driver-facing cameras. One driver writes to you that this is surveillance and threatens to quit unless his camera is turned off. What would you do first?",
      },
      options: [
        { key: "safety_q05_a", pattern: "ownership", text: {
          uz: "Bugun unga qoʻngʻiroq qilib, xavotirini oxirigacha tinglayman, kamera nimani yozishi va yozuvlar qanday ishlatilishini aniq tushuntiraman, qoida hammaga birdek tegishli ekanini halol aytaman.",
          ru: "Сегодня позвоню ему, дослушаю его опасения до конца, точно объясню, что записывает камера и как используются записи, и честно скажу, что правило одно для всех.",
          en: "Call him today, hear his concerns out fully, explain exactly what the camera records and how footage is used, and tell him honestly that the rule applies to everyone.",
        } },
        { key: "safety_q05_b", pattern: "victim", text: {
          uz: "Qarorni rahbariyat qabul qiladi, gʻazabni esa biz eshitamiz — har yangi jihozda haydovchining birinchi qoʻngʻirogʻi nega aynan xavfsizlikka kelishini bilmayman.",
          ru: "Решение принимает руководство, а гнев выслушиваем мы — не знаю, почему при каждом новшестве первый звонок водителя достаётся именно безопасности.",
          en: "Management makes the decision, but we absorb the anger — I do not know why, with every new device, the driver’s first call lands on Safety.",
        } },
        { key: "safety_q05_c", pattern: "complaint", text: {
          uz: "Xavfsizlik menejeriga kameralar haydovchilarga hech qanday tushuntirishsiz oʻrnatilganini aytaman — har safar shu: avval joriy qilamiz, keyin norozilik toʻlqinini yigʻamiz.",
          ru: "Скажу менеджеру по безопасности, что камеры поставили без всяких разъяснений водителям — каждый раз так: сначала внедряем, потом собираем волну недовольства.",
          en: "Tell the safety manager the cameras went in without any explanation to drivers — it is the same every time: first we roll it out, then we collect the wave of resentment.",
        } },
        { key: "safety_q05_d", pattern: "waiting", text: {
          uz: "Bunday suhbat telefonda yaxshi chiqmaydi — haydovchi keyingi safar bazaga kelganda yuzma-yuz gaplashaman; ungacha masala biroz sovushi ham foydali.",
          ru: "Такой разговор по телефону не получится — поговорю лично, когда водитель в следующий раз приедет на базу; до тех пор вопросу даже полезно немного остыть.",
          en: "A talk like this will not go well by phone — I will speak with him in person the next time he is at the yard; letting it cool a little until then even helps.",
        } },
        { key: "safety_q05_e", pattern: "builder", text: {
          uz: "U bilan yozuv haydovchini oqlagan real holatlarni koʻrsatib gaplashaman, soʻng barcha haydovchilar uchun «kamera nimani yozadi, nimani yozmaydi» degan qisqa yodnoma tayyorlayman.",
          ru: "Поговорю с ним, показав реальные случаи, где запись оправдала водителя, а затем подготовлю для всех водителей короткую памятку «что камера пишет, а что нет».",
          en: "Talk with him using real cases where footage cleared a driver, then prepare a short one-pager for all drivers on what the camera does and does not record.",
        } },
      ],
    },
    {
      key: "safety_q06",
      text: {
        uz: "Kecha haydovchi shipper hududida orqaga yurishda yengil toʻqnashuvga yoʻl qoʻydi. Sugʻurta uchun bugun foto va tushuntirish xati kerak, haydovchi esa xabarlarga juda sekin javob bermoqda. Birinchi navbatda nima qilasiz?",
        ru: "Вчера водитель допустил лёгкое столкновение при движении задним ходом на территории шиппера. Для страховой сегодня нужны фото и объяснительная, а водитель отвечает на сообщения очень медленно. Что вы сделаете в первую очередь?",
        en: "Yesterday a driver had a minor backing collision at a shipper’s yard. The insurance company needs photos and a statement today, but the driver is very slow to answer messages. What would you do first?",
      },
      options: [
        { key: "safety_q06_a", pattern: "blame", text: {
          uz: "Avval hodisa haqidagi xabar menga nega bir kun kechikib yetganini aniqlayman — zanjir qaysi boʻgʻinda uzilgan boʻlsa, kechikish uchun oʻsha javob berishi kerak.",
          ru: "Сначала выясню, почему сообщение о происшествии дошло до меня с опозданием на сутки — в каком звене порвалась цепочка, тому и отвечать за задержку.",
          en: "First find out why word of the incident reached me a day late — whichever link in the chain broke is the one that should answer for the delay.",
        } },
        { key: "safety_q06_b", pattern: "builder", text: {
          uz: "Haydovchini dispetcher orqali ham toptirib, nimani suratga olishini bandma-band aytib turaman, hujjatlar yigʻilgach esa kabinada saqlanadigan «hodisadan keyingi qadamlar» varagʻini tayyorlayman.",
          ru: "Найду водителя в том числе через диспетчера, продиктую по пунктам, что снять, а когда документы будут собраны — подготовлю лист «шаги после происшествия», который будет храниться в кабине.",
          en: "Track the driver down through dispatch as well, walk him item by item through what to photograph, and once the documents are in, prepare a “steps after an incident” sheet kept in the cab.",
        } },
        { key: "safety_q06_c", pattern: "waiting", text: {
          uz: "Hodisadan keyin haydovchiga oʻziga kelish uchun vaqt kerak — kechgacha kutaman: shipper hududida kameralar bor, asosiy dalillar baribir yigʻiladi.",
          ru: "После происшествия водителю нужно время прийти в себя — подожду до вечера: на территории шиппера есть камеры, основные материалы всё равно соберутся.",
          en: "After an incident a driver needs time to collect himself — I will wait until evening: the shipper’s yard has cameras, so the key evidence will come together anyway.",
        } },
        { key: "safety_q06_d", pattern: "ownership", text: {
          uz: "Hoziroq oʻzim qoʻngʻiroq qilaman, kerakli fotolar va xat boʻyicha birma-bir yoʻnaltiraman, hozir yubora olganini qabul qilib, qolgan maʼlumotni shipperdan oʻzim soʻrayman.",
          ru: "Прямо сейчас сам позвоню, по пунктам сориентирую его по нужным фото и объяснительной, приму то, что он может отправить сразу, а остальное запрошу у шиппера сам.",
          en: "Call him myself right now, guide him point by point through the needed photos and statement, take whatever he can send immediately, and request the rest from the shipper myself.",
        } },
        { key: "safety_q06_e", pattern: "complaint", text: {
          uz: "Orientatsiyada hodisadan keyingi tartibni necha marta oʻtamiz, baribir har bir holat maʼlumotni tomchilab undirishga aylanadi — buni yana bir bor taʼkidlayman.",
          ru: "Сколько ни разбираем порядок действий после происшествия на ориентации, каждый случай всё равно превращается в выпрашивание информации по капле — лишний раз это отмечу.",
          en: "No matter how often we cover post-incident steps at orientation, every case still turns into squeezing information out drop by drop — I will note that once again.",
        } },
      ],
    },
    {
      key: "safety_q07",
      text: {
        uz: "Haydovchi yoʻlda DOT tekshiruvidan oʻtdi va unga tormoz sozlanmasi boʻyicha qoidabuzarlik yozildi — bu kompaniyaning CSA koʻrsatkichiga taʼsir qiladi. Birinchi navbatda nima qilasiz?",
        ru: "Водитель прошёл придорожную инспекцию DOT, и ему записали нарушение по регулировке тормозов — это влияет на показатель CSA компании. Что вы сделаете в первую очередь?",
        en: "A driver went through a roadside DOT inspection and was written up for a brake adjustment violation — this affects the company’s CSA score. What would you do first?",
      },
      options: [
        { key: "safety_q07_a", pattern: "complaint", text: {
          uz: "Ichimda norozi boʻlaman: mashina servisdan endigina chiqqan edi-ku — texnik tayyorgarlik oqsar ekan, bizning koʻrsatkich ham oqsayveradi.",
          ru: "Про себя возмущусь: машина ведь только что вышла из сервиса — пока хромает техническая подготовка, будет хромать и наш показатель.",
          en: "Grumble to myself that the truck just came out of the shop — as long as maintenance readiness limps, our score will keep limping right along with it.",
        } },
        { key: "safety_q07_b", pattern: "victim", text: {
          uz: "CSA koʻrsatkichi uchun mendan soʻrashadi, nuqsonlar esa men boshqarmaydigan joylardan chiqadi — boshqalarning ishi boʻyicha baholanish ogʻir.",
          ru: "За показатель CSA спрашивают с меня, а дефекты приходят из зон, которыми я не управляю, — тяжело, когда тебя оценивают по чужой работе.",
          en: "I answer for the CSA score, yet the defects come from areas I do not control — it is hard being graded on other people’s work.",
        } },
        { key: "safety_q07_c", pattern: "ownership", text: {
          uz: "Bugunoq tekshiruv hisobotini olib, yozuvni sinchiklab oʻrganaman, taʼmir hujjatlashtirilganiga ishonch hosil qilaman va haydovchiga keyingi qadamlarni tushuntiraman.",
          ru: "Сегодня же получу отчёт инспекции, внимательно изучу запись, удостоверюсь, что ремонт задокументирован, и объясню водителю дальнейшие шаги.",
          en: "Get the inspection report today, study the entry closely, make sure the repair is documented, and explain the next steps to the driver.",
        } },
        { key: "safety_q07_d", pattern: "blame", text: {
          uz: "Avval nuqson qayerda oʻtkazib yuborilganini aniqlayman: haydovchi pre-trip koʻrigini chala qilganmi yoki servis soʻnggi taʼmirda koʻrmay qolganmi — javobgar aniq boʻlishi kerak.",
          ru: "Сначала определю, где пропустили дефект: водитель провёл pre-trip поверхностно или сервис не заметил при последнем обслуживании — ответственный должен быть назван.",
          en: "First determine where the defect was missed: did the driver skim his pre-trip or did the shop overlook it at the last service — the responsible party has to be named.",
        } },
        { key: "safety_q07_e", pattern: "builder", text: {
          uz: "Hisobot va taʼmirni rasmiylashtiraman, dalillar yetarli boʻlsa DataQ orqali eʼtiroz tayyorlayman, soʻng servis bilan tez-tez uchraydigan nuqson turlarini oyma-oy koʻrib borishni kelishaman.",
          ru: "Оформлю отчёт и ремонт, при достаточных основаниях подготовлю оспаривание через DataQ, а затем договорюсь с сервисом ежемесячно разбирать самые частые типы нарушений.",
          en: "Process the report and the repair, prepare a DataQ challenge if the evidence supports one, then agree with the shop to review the most frequent violation types month by month.",
        } },
      ],
    },
    {
      key: "safety_q08",
      text: {
        uz: "Dispetcher shoshilinch yuk uchun haydovchini soʻramoqda, lekin bu haydovchida tugallanmagan qayta trening sababli xavfsizlik toʻxtatuvi turibdi. Dispetcher yuk kutib turganini aytib bosim qilmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Диспетчер просит водителя под срочный груз, но у этого водителя стоит блокировка от отдела безопасности из-за незавершённого повторного тренинга. Диспетчер давит: груз ждёт. Что вы сделаете в первую очередь?",
        en: "A dispatcher is asking for a driver for a hot load, but that driver has a safety hold for unfinished refresher training. The dispatcher is pushing: the load is waiting. What would you do first?",
      },
      options: [
        { key: "safety_q08_a", pattern: "waiting", text: {
          uz: "Bunday toʻxtatuv boʻyicha qaror yakka tartibda qabul qilinmaydi — xavfsizlik menejeri tushdan keyin qaytadi, dispetcherga oʻsha paytgacha kutib turishni aytaman.",
          ru: "Решение по такой блокировке не принимается в одиночку — менеджер по безопасности вернётся после обеда, скажу диспетчеру подождать до этого момента.",
          en: "A hold like this is not decided single-handedly — the safety manager is back after lunch, so I will tell the dispatcher to hold on until then.",
        } },
        { key: "safety_q08_b", pattern: "builder", text: {
          uz: "Toʻxtatuv sababini dispetcherga tushuntiraman, trening bugun masofadan tugatilishi mumkinligini tekshiraman va bunday holatlar oldindan koʻrinishi uchun toʻxtatuvlarni dispetcherlar taxtasida belgilashni taklif qilaman.",
          ru: "Объясню диспетчеру причину блокировки, проверю, можно ли завершить тренинг сегодня дистанционно, и предложу отмечать блокировки на доске диспетчеров, чтобы такие случаи были видны заранее.",
          en: "Explain the reason for the hold to the dispatcher, check whether the training can be finished remotely today, and propose flagging holds on the dispatch board so cases like this surface earlier.",
        } },
        { key: "safety_q08_c", pattern: "victim", text: {
          uz: "Yuk kechiksa «xavfsizlik toʻsqinlik qildi» deyishadi, treningni chala qoldirgan esa haydovchi — nega noqulay vaziyatda doim biz qolishimizni tushunish qiyin.",
          ru: "Если груз задержится, скажут «безопасность помешала», хотя тренинг не завершил водитель — трудно понять, почему в неловком положении всегда оказываемся мы.",
          en: "If the load runs late, people will say “Safety got in the way,” though it was the driver who left the training unfinished — hard to see why we always end up the bad guys.",
        } },
        { key: "safety_q08_d", pattern: "ownership", text: {
          uz: "Toʻxtatuvni saqlagan holda darhol nima qolganini aniqlayman va dispetcherga halol muddat aytaman — haydovchi qachon tayyor boʻlishini bilsa, u yukni real rejalashtira oladi.",
          ru: "Сохраняя блокировку, сразу уточню, что именно осталось пройти, и назову диспетчеру честный срок — зная, когда водитель будет готов, он сможет реально спланировать груз.",
          en: "Keep the hold in place, immediately find out exactly what remains to complete, and give the dispatcher an honest timeline — knowing when the driver will be ready lets him plan the load realistically.",
        } },
        { key: "safety_q08_e", pattern: "blame", text: {
          uz: "Avval shuni qayd etaman: yuk haydovchi holati tekshirilmay band qilingan — rejalashtirishdagi bu xato dispetcherlik tomonida, kechikish javobgarligi ham oʻsha yerda boʻlishi kerak.",
          ru: "Сначала зафиксирую: груз забронировали, не проверив статус водителя, — эта ошибка планирования на стороне диспетчерской, там же должна быть и ответственность за задержку.",
          en: "First put on record that the load was booked without checking the driver’s status — that planning miss is on dispatch’s side, and the responsibility for the delay should sit there too.",
        } },
      ],
    },
    {
      key: "safety_q09",
      text: {
        uz: "Oylik hisobotda butun flot boʻyicha keskin tormozlash va masofa saqlamaslik hodisalari sezilarli oshganini koʻrdingiz. Hozircha birorta ham avariya boʻlgani yoʻq. Birinchi navbatda nima qilasiz?",
        ru: "В месячном отчёте вы увидели заметный рост резких торможений и несоблюдения дистанции по всему флоту. Аварий пока не было ни одной. Что вы сделаете в первую очередь?",
        en: "In the monthly report you see a noticeable rise in hard-braking and following-distance events across the fleet. So far there has not been a single accident. What would you do first?",
      },
      options: [
        { key: "safety_q09_a", pattern: "ownership", text: {
          uz: "Bugun maʼlumotni haydovchi, yoʻnalish va vaqt kesimida oʻzim tahlil qilib, hodisalar eng koʻp toʻplangan guruhni aniqlayman va oʻsha haydovchilar bilan suhbatlarni boshlayman.",
          ru: "Сегодня сам разберу данные по водителям, маршрутам и времени, определю группу с наибольшим числом событий и начну беседы с этими водителями.",
          en: "Break the data down myself today by driver, route, and time, identify the group with the most events, and start conversations with those drivers.",
        } },
        { key: "safety_q09_b", pattern: "complaint", text: {
          uz: "Bu har doim ish qizigan mavsumda takrorlanadi — jadval shunchalik zich tuzilsa, xavfsizlik koʻrsatkichlari pastga ketaverishini yigʻilishda yana aytaman.",
          ru: "Это повторяется каждый горячий сезон — на собрании ещё раз скажу, что при настолько плотных графиках показатели безопасности неизбежно ползут вниз.",
          en: "This repeats every busy season — at the meeting I will say once more that with schedules packed this tight, safety numbers inevitably slide.",
        } },
        { key: "safety_q09_c", pattern: "builder", text: {
          uz: "Tahlildan chiqqan asosiy xulosalarni dispetcherlik bilan boʻlishaman va flotimizning real hodisalariga asoslangan qisqa haftalik xavfsizlik eslatmalarini yoʻlga qoʻyaman.",
          ru: "Поделюсь главными выводами анализа с диспетчерской и запущу короткие еженедельные заметки по безопасности, основанные на реальных событиях нашего флота.",
          en: "Share the key findings of the analysis with dispatch and start short weekly safety notes built on our own fleet’s real events.",
        } },
        { key: "safety_q09_d", pattern: "victim", text: {
          uz: "Ogohlantirishlarim avariya boʻlmaguncha hech kimga kerak emas — keyin esa «xavfsizlik qayoqqa qaragan» deb birinchi navbatda mendan soʻrashadi; shu tartib charchatadi.",
          ru: "Мои предупреждения никому не нужны, пока не случится авария, — а потом первым спросят с меня: «куда смотрела безопасность»; этот порядок выматывает.",
          en: "Nobody needs my warnings until an accident happens — and then I am the first to be asked where Safety was looking; that pattern wears you down.",
        } },
        { key: "safety_q09_e", pattern: "waiting", text: {
          uz: "Bir oylik oʻsish hali tendensiya emas — yana bir oy maʼlumot toʻplab, manzara aniq boʻlgandagina chora koʻraman: har tebranishga darhol reaksiya qilish ham toʻgʻri emas.",
          ru: "Рост за один месяц — ещё не тенденция: соберу данные ещё за месяц и приму меры, только когда картина будет ясной, — реагировать на каждое колебание тоже неправильно.",
          en: "One month of growth is not yet a trend — I will gather another month of data and act only when the picture is clear; reacting to every fluctuation is not right either.",
        } },
      ],
    },
    {
      key: "safety_q10",
      text: {
        uz: "Bir hafta oldin barcha haydovchilarga muhim xavfsizlik qoidasi boʻyicha yangilanish yuborgan edingiz. Tanlab soʻraganingizda, koʻpchilik uni umuman ochib koʻrmagani maʼlum boʻldi. Birinchi navbatda nima qilasiz?",
        ru: "Неделю назад вы разослали всем водителям обновление важного правила безопасности. Выборочно спросив, вы обнаружили, что большинство его даже не открывало. Что вы сделаете в первую очередь?",
        en: "A week ago you sent all drivers an update to an important safety rule. Spot-checking, you find that most of them never even opened it. What would you do first?",
      },
      options: [
        { key: "safety_q10_a", pattern: "builder", text: {
          uz: "Yangilanishni qisqa va sodda shaklda — ovozli xabar va bir sahifalik yodnoma qilib — qayta yuboraman, har bir haydovchidan tasdiq soʻrayman va muhim xabarlar uchun shu tartibni doimiy qilaman.",
          ru: "Разошлю обновление заново в коротком простом виде — голосовым сообщением и памяткой на страницу, попрошу подтверждение от каждого водителя и закреплю этот порядок для важных сообщений.",
          en: "Resend the update in a short, simple form — a voice message and a one-page memo, ask each driver for a confirmation, and make that the standard for important notices.",
        } },
        { key: "safety_q10_b", pattern: "blame", text: {
          uz: "Avval xabar qaysi boʻgʻinda yoʻqolganini aniqlayman — dispetcherlar uni nazorat qoʻngʻiroqlarida ogʻzaki yetkazishi kerak edi; qilmagan boʻlsa, kamchilik oʻsha tomonda.",
          ru: "Сначала выясню, в каком звене потерялось сообщение — диспетчеры должны были устно доносить его на контрольных звонках; если не делали, недоработка на их стороне.",
          en: "First identify where the message got lost — dispatchers were supposed to relay it verbally on check calls; if they did not, the gap is on their side.",
        } },
        { key: "safety_q10_c", pattern: "ownership", text: {
          uz: "Bugundan haydovchilarga oʻzim qoʻngʻiroq qilib, asosiy oʻzgarishlarni ogʻzaki yetkazaman va kim bilan gaplashganimni roʻyxat qilib boraman — qoida ishlashi uchun avval u yetib borishi kerak.",
          ru: "С сегодняшнего дня начну сам обзванивать водителей, устно доносить главные изменения и вести список, с кем уже поговорил, — чтобы правило работало, оно сначала должно дойти.",
          en: "Starting today, call the drivers myself, deliver the key changes verbally, and keep a list of who I have reached — for a rule to work, it first has to get through.",
        } },
        { key: "safety_q10_d", pattern: "waiting", text: {
          uz: "Reys paytida haydovchilar xabarlarga kam qaraydi — yana bir hafta beraman: uyga dam olishga chiqqanda koʻpchiligi baribir oʻqib oladi, keyin holatni qayta tekshiraman.",
          ru: "В рейсе водители редко смотрят сообщения — дам ещё неделю: на домашнем отдыхе большинство всё равно прочитает, потом проверю ситуацию заново.",
          en: "Drivers rarely check messages while on a run — I will give it another week: most will read it during their home time anyway, and then I will re-check.",
        } },
        { key: "safety_q10_e", pattern: "complaint", text: {
          uz: "Toʻlovga aloqasi boʻlmagan xabarni haydovchilar ochib ham koʻrmasligini yana bir bor qayd etaman — har bir qoida yangilanishi bizda aynan shu ahvolda tarqaladi.",
          ru: "В который раз отмечу, что сообщения, не связанные с оплатой, водители даже не открывают — каждое обновление правил у нас расходится именно так.",
          en: "Note once again that drivers do not even open messages unrelated to pay — every policy update at our company spreads exactly like this.",
        } },
      ],
    },
  ],
};
