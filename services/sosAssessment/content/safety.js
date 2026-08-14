/**
 * SOS assessment content — Safety department (10 questions).
 *
 * Scope: HOS/ELD, telematics and coaching, refresher training, driver medical
 * certificates, driver-facing cameras, incident documentation and insurance,
 * DOT roadside inspections and CSA, safety holds, fleet event trends, policy
 * bulletins.
 *
 * Authoring rules: see the header of ./hr.js — all five options must read as
 * competent and choosable, the six tendencies are loci of first action rather
 * than keyword formulas, and no option may soften a required control. In this
 * department that is absolute: nothing here may let a driver run over hours,
 * lift a safety hold informally, release unsafe equipment, delay a required
 * report, or leave an incident undocumented. A less accountable instinct is
 * expressed by a different FOCUS, never by unsafe conduct.
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
          uz: "Haydovchi loglarni tasdiqlamaguncha yozuvga qoidabuzarlik kiritmayman — tasdiqlanmagan maʼlumot asosida qoʻyilgan yozuvni keyin tuzatish ancha qiyin.",
          ru: "Не стану заносить нарушение в его дело, пока он не заверит логи: запись, сделанная по непроверенным данным, потом исправляется куда труднее.",
          en: "I would not enter a violation before he certifies his logs — a record made on unconfirmed data is far harder to correct afterwards.",
        } },
        { key: "safety_q01_b", pattern: "complaint", text: {
          uz: "Holatni oʻzim tartib boʻyicha yozaman, lekin rahbarga aytaman: HOS ni har oy qayta tushuntiramiz, oshib ketishlar esa kamaymadi — trening formati koʻrilishi kerak.",
          ru: "Случай задокументирую сам, но скажу руководителю: HOS мы объясняем каждый месяц, а превышений не стало меньше — пересматривать надо сам формат обучения.",
          en: "I would document the case myself, but tell my manager we re-explain HOS monthly yet overages have not dropped — the training format needs revisiting.",
        } },
        { key: "safety_q01_c", pattern: "ownership", text: {
          uz: "Bugun logni oʻzim ochib, oshib ketish qayerdan boshlanganini aniqlayman, haydovchi bilan sababini gaplashaman va holatni tartib boʻyicha hujjatlashtiraman.",
          ru: "Сегодня сам открою лог, найду, откуда пошло превышение, поговорю с водителем о причине и задокументирую случай по регламенту.",
          en: "I would open the log myself today, find where the overage began, talk the cause through with the driver, and document the case per procedure.",
        } },
        { key: "safety_q01_d", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: soatni haydovchi oshiradi, reja dispetcherlikda tuziladi — koʻrsatkich baholanganda bu ikkisi menda emasligi hisobga olinishi kerak.",
          ru: "Прямо скажу руководителю: часы превышает водитель, план строит диспетчерская — оценивая показатель, стоит учитывать, что ни то, ни другое не в моих руках.",
          en: "I would tell my manager plainly that the driver runs the hours and dispatch builds the plan — neither is mine, and that should count when the number is judged.",
        } },
        { key: "safety_q01_e", pattern: "builder", text: {
          uz: "Holatni hujjatlashtirib, limitgacha bir soat qolganda haydovchi va dispetcherga ogohlantirish borishini yoʻlga qoʻyaman — bitta suhbat bu yigirma daqiqani qaytarmaydi.",
          ru: "Задокументирую случай и налажу оповещение водителю и диспетчеру за час до лимита: одним разговором эти двадцать минут не вернёшь.",
          en: "I would document the case and set up an alert to driver and dispatcher one hour before the limit — one conversation does not give those minutes back.",
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
          uz: "Siyosat talab qilgan keyingi qadamni qoʻyaman va takroriy holatlarda qaysi chora kelishini haydovchilarga oldindan eʼlon qilaman: nima kutilishini bilmagan odam xulqini oʻzgartirmaydi.",
          ru: "Применю следующий шаг, который требует политика, и заранее объявлю водителям, какая мера идёт за каким повтором: не зная, что его ждёт, человек поведение не меняет.",
          en: "I would apply the next step the policy requires and publish to drivers in advance which measure follows which repeat — nobody changes without knowing what is coming.",
        } },
        { key: "safety_q02_b", pattern: "blame", text: {
          uz: "Avval birinchi suhbat kim tomonidan va qanday hujjatlashtirilganini koʻraman — birinchi qadam yarim bajarilgan boʻlsa, takrorlanish aynan shundan boshlangan.",
          ru: "Сначала посмотрю, кем и как была задокументирована первая беседа: если первый шаг сделали наполовину, повтор начался именно оттуда.",
          en: "First I would look at who held the first conversation and how it was documented — if that step was half done, the repeat started right there.",
        } },
        { key: "safety_q02_c", pattern: "waiting", text: {
          uz: "Standart ogohlantirish tartib boʻyicha ketadi; qoʻshimcha chora esa oylik xavfsizlik yigʻilishida — holatni roʻyxatga qoʻshaman va qarorni birgalikda belgilaymiz.",
          ru: "Стандартное уведомление уйдёт по регламенту, а дополнительная мера — на месячном совещании по безопасности: внесу случай в список, и решим сообща.",
          en: "The standard notice goes out per procedure; any further measure belongs to the monthly safety meeting — I would list the case so the decision is a shared one.",
        } },
        { key: "safety_q02_d", pattern: "complaint", text: {
          uz: "Keyingi qadamni qoʻyaman va choralar tizimini yigʻilishga olib chiqaman: bir oyda uch marta takrorlanish suhbat xulqni oʻzgartirmasligini koʻrsatadi.",
          ru: "Следующий шаг применю и вынесу на совещание саму систему мер: три повтора за месяц показывают, что беседа поведение не меняет.",
          en: "I would apply the next step and take the measures themselves to the meeting: three repeats in a month show conversations do not change behavior.",
        } },
        { key: "safety_q02_e", pattern: "ownership", text: {
          uz: "Tezlik hisobotini oʻzim koʻrib chiqib, bugun haydovchi bilan toʻgʻridan-toʻgʻri gaplashaman va siyosat belgilagan keyingi qadamni hujjatlashtiraman.",
          ru: "Сам разберу отчёт по скорости, сегодня же поговорю с водителем напрямую и задокументирую следующий шаг, предписанный политикой.",
          en: "I would go through his speed report myself, talk to the driver directly today, and document the next step the policy prescribes.",
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
          uz: "Talab oʻz kuchida qoladi. Shu bilan birga bitta masalani ochiq qoʻyaman: trening tayinlash tartibi tajribali haydovchilarga tushunarli tilda yozilishi kerak.",
          ru: "Требование останется в силе. Заодно поставлю один вопрос: порядок назначения тренинга нужно изложить на языке, понятном опытным водителям.",
          en: "The requirement stands. Alongside it I would put one question openly: how training is assigned needs saying in language that reaches senior drivers.",
        } },
        { key: "safety_q03_b", pattern: "ownership", text: {
          uz: "Bugun u bilan gaplashib, treningga sabab boʻlgan aniq sanali hodisalarni koʻrsataman, savollarini eshitaman va talab oʻz kuchida qolishini xotirjam aytaman.",
          ru: "Сегодня поговорю с ним, покажу конкретные события с датами, из-за которых назначен тренинг, выслушаю его вопросы и спокойно скажу, что требование остаётся.",
          en: "I would talk with him today, show the specific dated events behind the assignment, hear his questions out, and say calmly that the requirement stands.",
        } },
        { key: "safety_q03_c", pattern: "blame", text: {
          uz: "Avval kamera tizimi hodisalarni toʻgʻri belgilayotganini tekshiraman — sozlama chegarasi notoʻgʻri boʻlsa, tuzatish provayder tomonida, haydovchida emas.",
          ru: "Сначала проверю, верно ли камеры отмечают события: если пороги настроены неправильно, исправлять надо у поставщика, а не у водителя.",
          en: "First I would check the cameras are flagging events correctly — if the thresholds are wrong, the correction sits with the vendor, not with the driver.",
        } },
        { key: "safety_q03_d", pattern: "builder", text: {
          uz: "Talabni bekor qilmayman, lekin trening tayinlanganda haydovchiga oʻz videosini koʻrsatish tartibini kiritaman — bahs koʻpincha aynan shu bosqichda tugaydi.",
          ru: "Требование не отменю, но введу порядок: при назначении тренинга водителю показывают его собственное видео — спор чаще всего заканчивается именно здесь.",
          en: "I would not lift the requirement, but I would make showing a driver his own footage part of assigning training — the argument usually ends right there.",
        } },
        { key: "safety_q03_e", pattern: "victim", text: {
          uz: "Talab qilish har doim xavfsizlik boʻlimiga tushadi — haydovchi bilan munosabatim faqat shu rol orqali oʻlchanmasligi uchun buni rahbar bilan kelishib olaman.",
          ru: "Требовать всегда приходится отделу безопасности — чтобы мои отношения с водителями не мерили только через эту роль, проясню это с руководителем.",
          en: "The demanding always lands on Safety — so my driver relations are not measured through that role alone, I would settle it with my manager first.",
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
          uz: "Rahbarga bugunoq yozib qoʻyaman: eslatmalar oʻz vaqtida ketgan va hujjat haydovchining oʻz masʼuliyatida — muddat oʻtsa, buni mening kuzatuvim deb baholash toʻgʻri emas.",
          ru: "Сегодня же отмечу руководителю: напоминания ушли вовремя, а документ — ответственность самого водителя; если срок сорвётся, считать это моим недосмотром неверно.",
          en: "I would note to my manager today that the reminders went out on time and the document is the driver’s own duty — a slip should not be read as my oversight.",
        } },
        { key: "safety_q04_b", pattern: "waiting", text: {
          uz: "Hozir yuk ostida — chalgʻitmayman, yetkazib bergandan keyin gaplashaman; besh kun bor va yuzma-yuz suhbatda imtihon sanasini birga belgilab olamiz.",
          ru: "Он сейчас под грузом — отвлекать не буду, поговорю после выгрузки; пять дней есть, и при личном разговоре вместе назначим дату осмотра.",
          en: "He is under a load — I would not distract him and would talk after delivery; there are five days, and face to face we can set the exam date together.",
        } },
        { key: "safety_q04_c", pattern: "builder", text: {
          uz: "Bugun dispetcherlik orqali bogʻlanaman va barcha muddatlarni oldindan ogohlantirishli kalendarga joriy qilaman — bu holatni oxirgi haftaga kuzatuv usuli olib keldi.",
          ru: "Свяжусь сегодня через диспетчерскую и внесу все сроки в общий календарь с ранними предупреждениями: к последней неделе привёл сам способ отслеживания.",
          en: "I would reach him through dispatch today and put every expiry into a shared calendar with early warnings — the tracking method is what brought this to the last week.",
        } },
        { key: "safety_q04_d", pattern: "blame", text: {
          uz: "Avval bu fayl qanday shu holatga kelganini oʻzim aniqlayman — muddatlarni kuzatish kimga biriktirilgan boʻlsa, ish ham oʻsha odamdan boshlanadi.",
          ru: "Сначала сам выясню, как этот файл дошёл до такого: за кем закреплено отслеживание сроков, с того человека и начинается работа.",
          en: "First I would establish myself how this file got here — whoever owns expiry tracking is the person the work starts with.",
        } },
        { key: "safety_q04_e", pattern: "ownership", text: {
          uz: "Dispetcherlik orqali hoziroq bogʻlanaman, sanani va sertifikatsiz yoʻlga chiqa olmasligini aniq aytaman va imtihonni qachon oʻtishini bugun birga rejalashtiramiz.",
          ru: "Свяжусь через диспетчерскую прямо сейчас, ясно назову дату и что без сертификата он ехать не может, и сегодня же спланируем с ним, когда он пройдёт осмотр.",
          en: "I would get through via dispatch right now, state the date and that he cannot drive without the certificate, and plan with him today when he fits the exam in.",
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
          uz: "Bugun oʻzim qoʻngʻiroq qilib xavotirini toʻliq eshitaman, kamera nimani yozadi va yozuv qanday ishlatiladi — tushuntiraman, qoida hamma uchun ekanini ochiq aytaman.",
          ru: "Сегодня сам позвоню, полностью выслушаю его опасения, объясню, что именно камера пишет и как используется запись, и честно скажу, что правило одно для всех.",
          en: "I would call him myself today, hear his concerns out in full, explain what the camera records and how footage is used, and say openly the rule is for everyone.",
        } },
        { key: "safety_q05_b", pattern: "victim", text: {
          uz: "Qarorni kompaniya qabul qildi, haydovchining birinchi qoʻngʻirogʻi esa bizga tushadi — bu farq koʻrinib turishi uchun holatni hozirdan qayd etaman.",
          ru: "Решение принимала компания, а первый звонок водителя приходит к нам — чтобы эта разница была видна, зафиксирую ситуацию уже сейчас.",
          en: "The company took the decision while the driver’s first call lands on us — I would put the situation on record now so that difference stays visible.",
        } },
        { key: "safety_q05_c", pattern: "complaint", text: {
          uz: "Haydovchi bilan hoziroq gaplashaman, ammo asosiy muammo boshqada: kameralar haydovchilarga tushuntirilmasdan oʻrnatildi — buni uskunani joriy qilganlar bilishi kerak.",
          ru: "С водителем поговорю прямо сейчас, но главная проблема в другом: камеры поставили, ничего водителям не объяснив — и знать об этом должны те, кто их внедрял.",
          en: "I would talk to the driver right now, but the real problem sits elsewhere: the cameras went in with no explanation, and the people who rolled them out should know.",
        } },
        { key: "safety_q05_d", pattern: "waiting", text: {
          uz: "Bunday suhbat telefonda yaxshi chiqmaydi — yardga kelganda yuzma-yuz gaplashaman; qoida bekor boʻlmaydi, lekin ishonch telefon orqali tiklanmaydi.",
          ru: "Такой разговор по телефону не выходит — поговорю лично, когда он будет на ярде; правило не отменяется, но доверие по телефону не возвращают.",
          en: "A conversation like this does not work by phone — I would talk face to face at the yard; the rule does not change, but trust is not rebuilt over a call.",
        } },
        { key: "safety_q05_e", pattern: "builder", text: {
          uz: "Yozuv haydovchini himoya qilgan real holatlarni koʻrsatib gaplashaman, keyin butun flot uchun kamera nimani yozadi va nimani yozmasligi haqida izoh tarqataman.",
          ru: "Поговорю, показав реальные случаи, где запись защитила водителя, а затем разошлю по флоту пояснение, что камера пишет и чего не пишет.",
          en: "I would talk with him using real cases where footage cleared a driver, then send the whole fleet a note on what the camera does and does not record.",
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
          uz: "Avval hodisa haqidagi xabar menga nega bir kun kech yetganini oʻzim aniqlayman — zanjir qayerda uzilgan boʻlsa, ertaga ham shu joyda uziladi.",
          ru: "Сначала сам выясню, почему известие о происшествии дошло до меня на день позже: где порвалась цепочка, там она порвётся и завтра.",
          en: "First I would establish myself why word of the incident reached me a day late — wherever the chain broke, it breaks there again tomorrow.",
        } },
        { key: "safety_q06_b", pattern: "builder", text: {
          uz: "Dispetcherlik orqali ham haydovchini topaman va hujjatlar yopilgach, kabinada turadigan «hodisadan keyingi qadamlar» varagʻini tayyorlayman.",
          ru: "Найду водителя и через диспетчерскую, а когда документы закроем, подготовлю памятку «шаги после происшествия», которая лежит в кабине.",
          en: "I would track the driver down through dispatch as well, and once the documents are in, prepare a “steps after an incident” sheet that lives in the cab.",
        } },
        { key: "safety_q06_c", pattern: "waiting", text: {
          uz: "Hodisadan keyin haydovchiga oʻziga kelish uchun vaqt kerak — kechgacha bosim qilmayman; shipper hududida kamera bor, asosiy dalil baribir yigʻiladi.",
          ru: "После происшествия водителю нужно время прийти в себя — до вечера давить не буду; на территории шиппера есть камеры, основные доказательства соберутся всё равно.",
          en: "After an incident a driver needs time to collect himself — I would not press until evening; the shipper’s yard has cameras, so the key evidence comes together anyway.",
        } },
        { key: "safety_q06_d", pattern: "ownership", text: {
          uz: "Oʻzim hoziroq qoʻngʻiroq qilib, kerakli foto va tushuntirish xatini band-band aytaman, yuborishga ulgurganini olaman, qolganini shipperdan oʻzim soʻrayman.",
          ru: "Сам позвоню прямо сейчас, по пунктам проговорю нужные фото и объяснительную, возьму то, что он успеет прислать, а остальное запрошу у шиппера сам.",
          en: "I would call him myself right now, walk him point by point through the photos and statement, take what he can send, and request the rest from the shipper myself.",
        } },
        { key: "safety_q06_e", pattern: "complaint", text: {
          uz: "Hujjatlarni oʻzim yigʻaman va masalani yana bir bor oʻrtaga qoʻyaman: hodisadan keyingi qadamlarni necha marta oʻtsak ham, maʼlumot tomchilab keladi.",
          ru: "Документы соберу сам и ещё раз поставлю вопрос: сколько бы раз мы ни разбирали шаги после происшествия, информация каждый раз идёт по капле.",
          en: "I would gather the documents myself and raise the question once more: however often we cover post-incident steps, the information still comes drop by drop.",
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
          uz: "Hisobotni yuritaman, lekin rahbarga aytaman: trak yaqinda shopdan chiqqan edi — texnik tayyorgarlik nazorati oʻzgarmasa, CSA raqami ham oʻzgarmaydi.",
          ru: "Отчёт проведу, но скажу руководителю: трак недавно вышел из шопа — пока не изменится контроль технической готовности, цифра CSA не изменится.",
          en: "I would process the report, but tell my manager the truck had just left the shop — until maintenance readiness control changes, the CSA number will not.",
        } },
        { key: "safety_q07_b", pattern: "victim", text: {
          uz: "CSA koʻrsatkichi menda, nosozliklar esa men boshqarmaydigan joyda paydo boʻladi — hisobotni shu ikkisi alohida koʻrinadigan qilib tayyorlayman.",
          ru: "Показатель CSA на мне, а неисправности появляются там, где я не управляю — отчёт подготовлю так, чтобы эти две вещи были видны отдельно.",
          en: "The CSA score is on me while the defects arise where I have no control — I would build the report so those two are visible separately.",
        } },
        { key: "safety_q07_c", pattern: "ownership", text: {
          uz: "Bugun inspeksiya hisobotini olib, yozuvni batafsil oʻrganaman, taʼmir hujjatlashtirilganiga ishonch hosil qilaman va haydovchiga keyingi qadamlarni tushuntiraman.",
          ru: "Сегодня получу отчёт инспекции, детально разберу запись, удостоверюсь, что ремонт задокументирован, и объясню водителю следующие шаги.",
          en: "I would get the inspection report today, study the entry closely, make sure the repair is documented, and explain the next steps to the driver.",
        } },
        { key: "safety_q07_d", pattern: "blame", text: {
          uz: "Nosozlik qaysi bosqichda oʻtkazib yuborilganini aniqlayman — pre-tripda yoki oxirgi servisda; ish faqat uzilgan bosqichning oʻzida oʻzgaradi.",
          ru: "Определю, на каком шаге неисправность пропустили — на пре-трипе или на последнем сервисе: меняется только тот шаг, где произошёл разрыв.",
          en: "I would determine at which step the defect was missed — the pre-trip or the last service; only the step where it broke actually changes.",
        } },
        { key: "safety_q07_e", pattern: "builder", text: {
          uz: "Hisobot va taʼmirni yopib, dalil yetarli boʻlsa DataQ eʼtirozini tayyorlayman, keyin shop bilan eng koʻp uchraydigan qoidabuzarliklarni har oy koʻrib chiqishni kelishaman.",
          ru: "Закрою отчёт и ремонт, при достаточных доказательствах подготовлю оспаривание DataQ, а затем согласую с шопом ежемесячный разбор самых частых нарушений.",
          en: "I would close the report and the repair, prepare a DataQ challenge if the evidence supports it, then agree a monthly review of the commonest violations with the shop.",
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
          uz: "Bunday toʻxtatuvni bir kishi olib tashlamaydi — xavfsizlik rahbari tushdan keyin keladi; dispetcherga toʻxtatuv kuchda ekanini va qaror shu yerdan chiqishini aytaman.",
          ru: "Такую блокировку не снимают в одиночку — руководитель по безопасности будет после обеда; скажу диспетчеру, что блокировка в силе и решение придёт оттуда.",
          en: "A hold like this is not lifted single-handedly — the safety manager is in after lunch; I would tell the dispatcher the hold stands and the decision comes from there.",
        } },
        { key: "safety_q08_b", pattern: "builder", text: {
          uz: "Toʻxtatuv sababini dispetcherga tushuntiraman, treningni bugun masofadan yopish mumkinmi tekshiraman va toʻxtatuvlar dispetcher boardida koʻrinishini yoʻlga qoʻyaman.",
          ru: "Объясню диспетчеру причину блокировки, проверю, можно ли закрыть тренинг сегодня удалённо, и налажу отображение блокировок на борде диспетчера.",
          en: "I would explain the reason for the hold to the dispatcher, check whether the training can be closed remotely today, and get holds shown on the dispatch board.",
        } },
        { key: "safety_q08_c", pattern: "victim", text: {
          uz: "Yuk kechiksa «xavfsizlik toʻsdi» deb qoladi, holbuki treningni haydovchi yopmagan — shuning uchun toʻxtatuv sababini bugun yozma qayd etaman.",
          ru: "Если груз опоздает, скажут «безопасность помешала», хотя тренинг не закрыл водитель — поэтому причину блокировки зафиксирую сегодня письменно.",
          en: "A late load becomes “Safety got in the way”, though the driver left the training open — so I would put the reason for the hold in writing today.",
        } },
        { key: "safety_q08_d", pattern: "ownership", text: {
          uz: "Toʻxtatuvni saqlab, aynan nima qolganini hoziroq aniqlayman va dispetcherga rost muddat aytaman — qachon tayyor boʻlishini bilsa, yukni real rejalashtiradi.",
          ru: "Блокировку сохраню, прямо сейчас выясню, что именно осталось, и дам диспетчеру честный срок: зная, когда водитель будет готов, он спланирует груз реально.",
          en: "I would keep the hold, find out right now exactly what is left, and give the dispatcher an honest timeline — knowing when the driver is ready, he can plan for real.",
        } },
        { key: "safety_q08_e", pattern: "blame", text: {
          uz: "Toʻxtatuv kuchida qoladi, men esa yuk haydovchining statusi tekshirilmasdan olinganini hoziroq yozib qoʻyaman — bu uzilish dispetcherlik tomonida.",
          ru: "Блокировка остаётся в силе, а я прямо сейчас зафиксирую, что груз взяли, не проверив статус водителя: этот разрыв на стороне диспетчерской.",
          en: "The hold stands, and I would put on record right now that the load was booked without checking the driver’s status — that break is on dispatch’s side.",
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
          uz: "Bugun maʼlumotni haydovchi, yoʻnalish va vaqt boʻyicha oʻzim ajrataman, hodisasi eng koʻp guruhni aniqlayman va oʻsha haydovchilar bilan suhbatni boshlayman.",
          ru: "Сегодня сам разложу данные по водителям, маршрутам и времени, найду группу с наибольшим числом событий и начну разговоры с этими водителями.",
          en: "I would break the data down myself today by driver, route and time, find the group with the most events, and start the conversations with those drivers.",
        } },
        { key: "safety_q09_b", pattern: "complaint", text: {
          uz: "Tahlilni qilaman, lekin yigʻilishda aytaman: bu har mavsumda qaytadi — jadval shunday tigʻiz boʻlsa, xavfsizlik raqamlari muqarrar pasayadi.",
          ru: "Анализ сделаю, но на совещании скажу: это повторяется каждый сезон — при таком плотном графике показатели безопасности неизбежно проседают.",
          en: "I would run the analysis, but say at the meeting this comes back every season — with schedules this tight, the safety numbers inevitably slide.",
        } },
        { key: "safety_q09_c", pattern: "builder", text: {
          uz: "Tahlil natijasini dispetcherlik bilan boʻlishaman va oʻz flotimizning real hodisalariga asoslangan qisqa haftalik xavfsizlik xabarlarini yoʻlga qoʻyaman.",
          ru: "Поделюсь результатами анализа с диспетчерской и налажу короткие еженедельные сводки по безопасности на реальных событиях нашего флота.",
          en: "I would share the findings with dispatch and start short weekly safety notes built on our own fleet’s real events.",
        } },
        { key: "safety_q09_d", pattern: "victim", text: {
          uz: "Ogohlantirishlarim avariya boʻlmaguncha eʼtiborga olinmaydi — shuning uchun bu oy kimga nima aytganimni oʻzim yozib boraman.",
          ru: "Мои предупреждения не воспринимают, пока не случится аварии — поэтому в этом месяце сам буду записывать, кому и что я сказал.",
          en: "My warnings are not taken up until there is an accident — so this month I would keep my own record of who I told what and when.",
        } },
        { key: "safety_q09_e", pattern: "waiting", text: {
          uz: "Bir oylik oʻsish hali tendensiya emas — yana bir oylik maʼlumot yigʻaman va manzara aniq boʻlganda chora koʻraman; har tebranishga reaksiya raqamni buzadi.",
          ru: "Рост за один месяц ещё не тренд — соберу данные ещё за месяц и приму меры, когда картина будет ясной: реакция на каждое колебание портит статистику.",
          en: "One month of growth is not a trend yet — I would gather another month and act when the picture is clear; reacting to every wobble distorts the numbers.",
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
          uz: "Yangilanishni ovozli xabar va bir sahifalik yodnoma shaklida qayta yuboraman va muhim xabarlar uchun tasdiq olishni doimiy tartibga aylantiraman.",
          ru: "Перешлю обновление голосовым сообщением и одностраничной памяткой и сделаю подтверждение получения постоянным порядком для важных рассылок.",
          en: "I would resend the update as a voice message and a one-page memo, and make a read-confirmation the standing procedure for important notices.",
        } },
        { key: "safety_q10_b", pattern: "blame", text: {
          uz: "Xabar qaysi bosqichda yoʻqolganini aniqlayman — dispetcherlar check-callda ogʻzaki yetkazishi kerak edi; qilinmagan boʻlsa, gap ular bilan boʻladi.",
          ru: "Определю, на каком шаге сообщение потерялось: диспетчеры должны были передать его словами на чек-колле; если не передали, разговор будет с ними.",
          en: "I would pin down where the message got lost — dispatchers were to relay it verbally on check calls; if they did not, the conversation is with them.",
        } },
        { key: "safety_q10_c", pattern: "ownership", text: {
          uz: "Bugundan haydovchilarga oʻzim qoʻngʻiroq qilib, asosiy oʻzgarishlarni ogʻzaki yetkazaman va kimga yetganini roʻyxat qilib boraman.",
          ru: "С сегодняшнего дня сам обзвоню водителей, передам ключевые изменения словами и буду вести список тех, до кого дошло.",
          en: "Starting today I would call the drivers myself, deliver the key changes verbally, and keep a list of who I have reached.",
        } },
        { key: "safety_q10_d", pattern: "waiting", text: {
          uz: "Haydovchi reysda xabarni kam ochadi — yana bir hafta beraman: koʻpchilik uyda oʻqiydi, shundan keyin oʻzim qayta tekshiraman.",
          ru: "В рейсе водитель сообщения открывает редко — дам ещё неделю: большинство прочтёт дома, и тогда сам проверю снова.",
          en: "Drivers rarely open messages on a run — I would give it another week: most read at home, and then I would re-check them myself.",
        } },
        { key: "safety_q10_e", pattern: "complaint", text: {
          uz: "Qayta yuboraman va xabar yetkazish kanali haqida savol qoʻyaman: toʻlovga tegishli boʻlmagan xabarlar shunchaki ochilmaydi, qoida esa shunday tarqaladi.",
          ru: "Перешлю и поставлю вопрос о самом канале доставки: сообщения не про оплату просто не открывают, а правило расходится именно так.",
          en: "I would resend it and put a question about the delivery channel itself: messages not about pay simply go unopened, and that is how a rule spreads.",
        } },
      ],
    },
  ],
};
