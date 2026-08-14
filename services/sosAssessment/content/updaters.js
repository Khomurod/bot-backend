/**
 * SOS assessment content — Updaters department (10 questions).
 *
 * Scope: broker and customer status updates, ELD signal gaps and the customer
 * tracking link, position mismatches, ETA while loading is still running,
 * delivery confirmations, shift handoff notes, long unexplained stops, seal and
 * pallet data after loading, morning update waves under growing volume.
 *
 * Authoring rules: see the header of ./hr.js — all five options must read as
 * competent and choosable, the six tendencies are loci of first action rather
 * than keyword formulas. Hard constraints for this department: no option may
 * invent or guess a position or an ETA, pass unverified data to a customer as
 * confirmed, or sit on a possible emergency. A less accountable instinct shows
 * up as a different FIRST MOVE, never as fabricated tracking information.
 */

module.exports = {
  department: "updaters",
  questions: [
    {
      key: "updaters_q01",
      text: {
        uz: "Broker qoʻngʻiroq qilib, yuk hozir qayerdaligini darhol bilishi kerakligini aytmoqda. Haydovchi telefon koʻtarmayapti, oxirgi update ikki soat oldin berilgan. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Брокер звонит и говорит, что ему прямо сейчас нужно знать, где груз. Водитель не берёт трубку, последнее обновление было два часа назад. Что вы, скорее всего, сделаете в первую очередь?",
        en: "A broker calls saying he needs to know right now where the load is. The driver is not picking up, and the last update was two hours ago. What would you most likely do first?",
      },
      options: [
        { key: "updaters_q01_a", pattern: "ownership", text: {
          uz: "Brokerga tasdiqlangan faktni beraman — ELD boʻyicha oxirgi joylashuv va vaqti; haydovchini izlayotganimni aytaman va yarim soatda oʻzim qayta bogʻlanaman.",
          ru: "Дам брокеру подтверждённый факт — последнюю позицию по ELD и её время, открыто скажу, что ищу водителя, и сам перезвоню в течение получаса.",
          en: "I would give the broker the confirmed fact — the last ELD position and its time — say openly that I am chasing the driver, and call back myself within half an hour.",
        } },
        { key: "updaters_q01_b", pattern: "complaint", text: {
          uz: "Javob beraman, lekin rahbarga aytaman: broker darhol javob talab qiladi, haydovchi esa koʻtarmaydi — aloqa talabi belgilanmasa, biz har kuni ikki oʻt orasida qolamiz.",
          ru: "Ответ дам, но скажу руководителю: брокер требует ответ сразу, а водитель не берёт трубку — пока не установят требование по связи, мы каждый день между двух огней.",
          en: "I would answer, but tell my lead the broker demands an answer instantly while the driver does not pick up — with no contact requirement set, we stay between two fires.",
        } },
        { key: "updaters_q01_c", pattern: "builder", text: {
          uz: "Brokerga oxirgi tasdiqlangan joylashuvni aytaman, haydovchi va dispetcherga parallel yozaman, keyin bu broker yuklari uchun doimiy update jadvalini kelishaman.",
          ru: "Сообщу брокеру последнюю подтверждённую позицию, параллельно напишу водителю и диспетчеру, а затем согласую постоянный график апдейтов по грузам этого брокера.",
          en: "I would tell the broker the last confirmed position, message the driver and the dispatcher in parallel, then agree a standing update schedule for this broker’s loads.",
        } },
        { key: "updaters_q01_d", pattern: "waiting", text: {
          uz: "Brokerdan biroz vaqt soʻrayman: ikki soatlik maʼlumot eskirgan boʻlishi mumkin, haydovchi tasdiqlamaguncha aniq gap aytmaslik toʻgʻriroq.",
          ru: "Попрошу у брокера немного времени: данные двухчасовой давности могут быть устаревшими, и пока водитель не подтвердит, точнее ничего не утверждать.",
          en: "I would ask the broker for a little time: two-hour-old data may be stale, and until the driver confirms it is sounder to state nothing definite.",
        } },
        { key: "updaters_q01_e", pattern: "victim", text: {
          uz: "Rahbarga aytib qoʻyaman: haydovchi telefonni koʻtarishi menda emas, broker esa javobni darhol talab qiladi — bu mening ish sifatim deb baholanmasligi kerak.",
          ru: "Скажу руководителю: берёт ли водитель трубку, от меня не зависит, а брокер требует ответ немедленно — такие звонки не стоит считать качеством моей работы.",
          en: "I would tell my lead whether the driver picks up is not in my hands while the broker wants an answer instantly — that is not a measure of my work.",
        } },
      ],
    },
    {
      key: "updaters_q02",
      text: {
        uz: "Reys oʻrtasida trakdan toʻrt soatdan beri ELD signali kelmayotganini payqadingiz — mijoz koʻradigan kuzatuv havolasida mashina bir joyda turgandek koʻrinadi. Birinchi navbatda nima qilasiz?",
        ru: "Посреди рейса вы заметили, что от трака четыре часа нет сигнала ELD — по отслеживающей ссылке, которую видит клиент, машина выглядит стоящей на месте. Что вы сделаете в первую очередь?",
        en: "Mid-trip you notice the truck has not sent an ELD signal for four hours — on the tracking link the customer sees, the unit looks parked in one place. What would you do first?",
      },
      options: [
        { key: "updaters_q02_a", pattern: "waiting", text: {
          uz: "Bunday uzilishlar aloqa boʻlmagan joylarda tez-tez boʻladi va oʻzi tiklanadi — signal qaytishini kutib, shundan keyin holatga qarab harakat qilaman.",
          ru: "Такие разрывы часто бывают в зонах без покрытия и восстанавливаются сами — подожду возврата сигнала и уже тогда буду действовать по ситуации.",
          en: "Gaps like this are common in dead zones and usually restore themselves — I would wait for the signal to return and act on the situation then.",
        } },
        { key: "updaters_q02_b", pattern: "builder", text: {
          uz: "Haydovchi bilan real joylashuvni tasdiqlab yozaman, signal qaytguncha updatelarni qoʻlda yuritaman va bu trakni ELD egasiga tekshirish uchun belgilayman.",
          ru: "Подтвержу с водителем реальную позицию и зафиксирую её, до возврата сигнала буду вести апдейты вручную и отмечу этот трак на проверку владельцу ELD.",
          en: "I would confirm the real position with the driver and log it, keep the updates manual until the signal returns, and flag this truck to the ELD owner for a check.",
        } },
        { key: "updaters_q02_c", pattern: "blame", text: {
          uz: "Bu trakning ELD qurilmasi kimda ekanini va oldingi uzilish ogohlantirishlarini kim olganini aniqlayman — uzilish qayerda boʻlsa, tuzatish ham oʻsha yerda.",
          ru: "Выясню, за кем закреплено ELD-устройство этого трака и кто получал предыдущие оповещения о разрывах: где разрыв, там и исправление.",
          en: "I would establish who owns this truck’s ELD unit and who received the earlier gap alerts — where the break is, that is where the fix belongs.",
        } },
        { key: "updaters_q02_d", pattern: "ownership", text: {
          uz: "Haydovchiga hoziroq bogʻlanib, real joylashuvi va holatini tasdiqlayman va tekshirilgan maʼlumotni tizimga kiritaman — mijoz koʻrgan manzara toʻgʻri boʻlishi kerak.",
          ru: "Прямо сейчас свяжусь с водителем, подтвержу его реальную позицию и статус и внесу проверенные данные в систему: картина, которую видит клиент, должна быть верной.",
          en: "I would reach the driver right now, confirm his real position and status, and enter the verified data in the system — what the customer sees has to be right.",
        } },
        { key: "updaters_q02_e", pattern: "complaint", text: {
          uz: "Qoʻlda yuritaman va uskuna masalasini yigʻilishga olib chiqaman: bu ELD qurilmalari doim uzilib qoladi, oqibatini esa bizning boʻlim koʻtaradi.",
          ru: "Буду вести вручную и вынесу вопрос техники на совещание: эти ELD-устройства постоянно отваливаются, а последствия тянет наш отдел.",
          en: "I would keep it manual and take the equipment question to the meeting: these units keep dropping out while our department carries the consequences.",
        } },
      ],
    },
    {
      key: "updaters_q03",
      text: {
        uz: "Tizimda trak yetkazib berish joyidan 60 mil narida koʻrinmoqda, haydovchi esa allaqachon mijoz hududida turib, boʻsh eshik kutayotganini aytdi. Ayni paytda broker status soʻramoqda. Birinchi navbatda nima qilasiz?",
        ru: "Система показывает трак в 60 милях от места доставки, а водитель говорит, что уже стоит на территории клиента и ждёт свободные ворота. Тем временем брокер запрашивает статус. Что вы сделаете в первую очередь?",
        en: "The system shows the truck 60 miles from the delivery point, but the driver says he is already on the customer’s property waiting for an open door. Meanwhile the broker is asking for a status. What would you do first?",
      },
      options: [
        { key: "updaters_q03_a", pattern: "victim", text: {
          uz: "Tizim va haydovchi maʼlumoti mos kelmasa ham, javob bizdan soʻraladi — qaysi maʼlumot qaysi manbadan kelganini yozib qoʻyaman.",
          ru: "Даже когда данные системы и водителя не сходятся, ответ спрашивают у нас — зафиксирую, какие данные пришли из какого источника.",
          en: "Even when the system and the driver disagree the answer is asked of us — I would record which data came from which source.",
        } },
        { key: "updaters_q03_b", pattern: "waiting", text: {
          uz: "Manzara mos kelmaguncha brokerga aniq javob bermayman — GPS yangilanishini kutaman: qisqa kechikish qarama-qarshi maʼlumot yuborishdan yaxshi.",
          ru: "Пока картина не сойдётся, точного ответа брокеру не дам — дождусь обновления GPS: короткая задержка лучше, чем противоречивые данные.",
          en: "Until the picture lines up I would give the broker no definite answer — I would wait for the GPS to refresh: a short delay beats sending a contradiction.",
        } },
        { key: "updaters_q03_c", pattern: "ownership", text: {
          uz: "Haydovchidan joylashuv pini yoki check-inini soʻrayman, qaysi maʼlumot toʻgʻri ekanini aniqlab, brokerga tasdiqlangan statusni oʻzim beraman.",
          ru: "Попрошу у водителя пин локации или check-in, определю, какие данные верны, и сам передам брокеру подтверждённый статус.",
          en: "I would ask the driver for a location pin or his check-in, establish which data is right, and pass the broker the confirmed status myself.",
        } },
        { key: "updaters_q03_d", pattern: "blame", text: {
          uz: "Tafovut qayerdan chiqqanini aniqlayman — trak tizimda notoʻgʻri biriktirilganmi yoki haydovchi boshqa yuk haqida gapiryaptimi; tuzatish xato boʻlgan joyda boʻlishi kerak.",
          ru: "Определю, откуда взялось расхождение: трак неверно привязан в системе или водитель говорит о другом грузе; исправлять надо там, где ошибка.",
          en: "I would work out where the mismatch came from — the truck attached wrong in the system, or the driver talking about another load; the fix belongs at the error.",
        } },
        { key: "updaters_q03_e", pattern: "builder", text: {
          uz: "Joylashuvni haydovchi orqali tasdiqlab brokerga aniq status beraman, keyin tizimdagi biriktirishni tekshirtiraman — keyingi smena shu tafovutga urilmasligi kerak.",
          ru: "Подтвержу позицию через водителя и дам брокеру точный статус, а затем добьюсь проверки привязки в системе: следующая смена не должна упереться в то же расхождение.",
          en: "I would confirm the position through the driver and give the broker an accurate status, then get the system assignment checked so the next shift does not hit it.",
        } },
      ],
    },
    {
      key: "updaters_q04",
      text: {
        uz: "Haydovchi yuklash joyida besh soatdan beri turibdi, yuklash hali tugamagan. Mijoz esa yetkazib berish boʻyicha aniq ETA soʻramoqda — real vaqt yuklash qachon tugashiga bogʻliq. Birinchi navbatda nima qilasiz?",
        ru: "Водитель стоит на погрузке уже пять часов, и она ещё не закончена. Клиент запрашивает точное ETA по доставке — реальное время зависит от того, когда завершится погрузка. Что вы сделаете в первую очередь?",
        en: "The driver has been sitting at the shipper for five hours and loading is still not finished. The customer is asking for an exact delivery ETA — the real time depends on when loading ends. What would you do first?",
      },
      options: [
        { key: "updaters_q04_a", pattern: "builder", text: {
          uz: "Mijozga holatni aytib, yoʻlga chiqqach aniq ETA yuborishni kelishaman, dispetcherlikdan yuklash tugash vaqtini soʻrayman va besh soatlik kutishni ularga belgilayman.",
          ru: "Скажу клиенту, как есть, и договорюсь прислать точное ETA после выезда, запрошу у диспетчерской ожидаемое время окончания погрузки и отмечу им пятичасовой простой.",
          en: "I would tell the customer where things stand and agree to send a firm ETA after departure, ask dispatch for the expected finish, and flag the five-hour wait to them.",
        } },
        { key: "updaters_q04_b", pattern: "blame", text: {
          uz: "Bu yuk qanday muddat bilan sotilganini koʻraman — mijozga real boʻlmagan oyna vaʼda qilingan boʻlsa, tushuntirish ham oʻsha tomondan kelishi toʻgʻri.",
          ru: "Посмотрю, с каким сроком продавали этот груз: если клиенту обещали нереальное окно, объяснять правильнее той стороне.",
          en: "I would look at what timeline this load was sold on — if the customer was promised an unrealistic window, the explanation rightly comes from that side.",
        } },
        { key: "updaters_q04_c", pattern: "victim", text: {
          uz: "Mendan menga bogʻliq boʻlmagan raqam soʻralmoqda — yuklashni men boshqarmayman, shuning uchun kutish vaqtini oʻzim qayd etib boraman.",
          ru: "С меня спрашивают цифру, которая от меня не зависит — погрузкой управляю не я, поэтому сам буду фиксировать время простоя.",
          en: "I am asked for a number that does not depend on me — I do not run the loading, so I would log the waiting time myself.",
        } },
        { key: "updaters_q04_d", pattern: "complaint", text: {
          uz: "Mijozga holatni aytaman, ammo asosiy gap boshqada: bu shipper doim sekin ishlaydi va bunday kutishlar tez-tez boʻladi.",
          ru: "Клиенту скажу, как есть, но суть в другом: этот шиппер всегда работает медленно, и такие простои случаются часто.",
          en: "I would tell the customer where things stand, but the real point is elsewhere: this shipper is always slow and waits like this are frequent.",
        } },
        { key: "updaters_q04_e", pattern: "ownership", text: {
          uz: "Mijozga borligicha aytaman — yuklash tugamagan va hozir aniq vaqt yoʻq — va trak yoʻlga chiqishi bilan birinchi navbatda unga xabar berishimni aytaman.",
          ru: "Скажу клиенту как есть — погрузка не окончена и точного времени пока нет — и пообещаю сообщить ему первым, как только трак выедет.",
          en: "I would tell the customer exactly where it stands — loading unfinished, no exact time yet — and give my word to notify him first the moment the truck rolls.",
        } },
      ],
    },
    {
      key: "updaters_q05",
      text: {
        uz: "Ertalab kecha kechqurun yetkazib berilgan yuk boʻyicha brokerga tasdiqlovchi update yuborilmaganini payqadingiz. Broker tun boʻyi javob kutib, norozi xat yozgan va rahbariyatni nusxaga qoʻshgan. Birinchi navbatda nima qilasiz?",
        ru: "Утром вы обнаружили, что по грузу, доставленному вчера вечером, брокеру так и не ушло подтверждающее обновление. За ночь брокер написал недовольное письмо, поставив руководство в копию. Что вы сделаете в первую очередь?",
        en: "In the morning you discover that the delivery confirmation for a load delivered last night never went out to the broker. Overnight the broker wrote an unhappy email and copied management. What would you do first?",
      },
      options: [
        { key: "updaters_q05_a", pattern: "complaint", text: {
          uz: "Tasdiqni yuboraman, lekin jamoada aytaman: kechki smenadagi yuk hajmida bitta update oʻtkazib yuborilishi muqarrar — ish tartibi koʻrilmasa, bu qaytadi.",
          ru: "Подтверждение отправлю, но в команде скажу: при объёме вечерней смены пропуск одного апдейта неизбежен — пока не пересмотрят порядок работы, это повторится.",
          en: "I would send the confirmation, but say in the team that at the evening shift’s volume a missed update is inevitable — unrevised, the routine guarantees a repeat.",
        } },
        { key: "updaters_q05_b", pattern: "ownership", text: {
          uz: "Brokerga tasdiqlangan yetkazish vaqtini va hujjatlarni hoziroq yuboraman, kechikish uchun uzr soʻrayman va bugun uning savollari bilan oʻzim shugʻullanishimni yozaman.",
          ru: "Прямо сейчас отправлю брокеру подтверждённое время доставки и документы, извинюсь за задержку и напишу, что сегодня его вопросами занимаюсь лично я.",
          en: "I would send the broker the confirmed delivery time and the paperwork right now, apologize for the delay, and write that I am handling his questions personally today.",
        } },
        { key: "updaters_q05_c", pattern: "victim", text: {
          uz: "Bu update kechki smenada oʻtkazib yuborilgan — xatni ertalab birinchi men ochdim, shuning uchun kim nima qilgani aniq boʻlishi kerak.",
          ru: "Этот апдейт пропустили в вечернюю смену — письмо утром я лишь открыл первым, и должно быть ясно, кто что сделал.",
          en: "This update was missed on the evening shift — I only opened the email first, and who did what should be clear.",
        } },
        { key: "updaters_q05_d", pattern: "builder", text: {
          uz: "Brokerga uzr bilan tasdiq yuboraman, keyin smena oxirida yuborilmagan updatelarni tekshirishni qisqa qadam qilib kiritaman — bunday xato ertalabgacha yetmasligi kerak.",
          ru: "Отправлю брокеру подтверждение с извинением, а затем введу проверку неотправленных апдейтов в конце смены: такая ошибка не должна доживать до утра.",
          en: "I would send the broker the confirmation with an apology, then add a short end-of-shift check for unsent updates — a miss like this should not survive to morning.",
        } },
        { key: "updaters_q05_e", pattern: "waiting", text: {
          uz: "Rahbariyat nusxada — javob berishdan oldin rahbar qanday pozitsiya olishini bilib olaman: broker bir masalada ikki xil javob olmasligi kerak.",
          ru: "Руководство в копии — прежде чем отвечать, узнаю позицию руководителя: брокер не должен получить по одному вопросу два разных ответа.",
          en: "Management is on copy — before replying I would learn my lead’s position: the broker must not receive two different answers on one question.",
        } },
      ],
    },
    {
      key: "updaters_q06",
      text: {
        uz: "Siz smenani qabul qilib oldingiz, lekin topshiruv yozuvlari faol yuklarning yarminigina qamrab olgan — bir nechta yuk boʻyicha oxirgi update qachon ketgani va brokerga nima deyilgani nomaʼlum. Birinchi navbatda nima qilasiz?",
        ru: "Вы приняли смену, но записи передачи покрывают только половину активных грузов — по нескольким грузам неясно, когда уходило последнее обновление и что обещали брокеру. Что вы сделаете в первую очередь?",
        en: "You take over the shift, but the handoff notes cover only half of the active loads — for several loads it is unclear when the last update went out and what the broker was told. What would you do first?",
      },
      options: [
        { key: "updaters_q06_a", pattern: "blame", text: {
          uz: "Izohlarni shu holatda kim qoldirganini aniqlab, rahbarga bildiraman — smena qanday topshirilgani belgilanmasa, keyingi smena ham shunday oʻtadi.",
          ru: "Выясню, кто оставил заметки в таком виде, и сообщу руководителю: если не обозначить, как передали смену, следующая пройдёт так же.",
          en: "I would establish who left the notes in this state and let my lead know — unless how the shift was handed over is marked, the next one goes the same way.",
        } },
        { key: "updaters_q06_b", pattern: "waiting", text: {
          uz: "Oldingi smenadagi hamkasb bir necha soatdan keyin bogʻlanadi — chala maʼlumot bilan harakat qilgandan koʻra, u bilan aniqlashtirib keyin davom etaman.",
          ru: "Коллега с прошлой смены выйдет на связь через несколько часов — вместо действий по неполным данным уточню у него и продолжу после этого.",
          en: "The coworker from the last shift is reachable in a few hours — rather than act on partial data I would clarify with him and continue after that.",
        } },
        { key: "updaters_q06_c", pattern: "builder", text: {
          uz: "Statuslarni tizim va xabarlar tarixidan oʻzim tiklayman, noaniq yuklarni bittalab tekshiraman, keyin har yuk uchun majburiy maydonlari bor topshiruv shablonini kiritaman.",
          ru: "Сам восстановлю статусы по системе и истории сообщений, проверю неясные грузы по одному, а затем введу шаблон передачи с обязательными полями.",
          en: "I would rebuild the statuses from the system and message history, check the unclear loads one by one, then introduce a handoff template with required fields.",
        } },
        { key: "updaters_q06_d", pattern: "ownership", text: {
          uz: "Noaniq yuklardan boshlayman: tizim tarixini koʻraman, kerak boʻlsa haydovchilarga qoʻngʻiroq qilaman va har yukning hozirgi holatini oʻzim aniqlayman.",
          ru: "Начну с неясных грузов: посмотрю историю в системе, при необходимости позвоню водителям и сам установлю текущее состояние каждого груза.",
          en: "I would start with the unclear loads: go through the system history, call the drivers where needed, and establish the current state of each load myself.",
        } },
        { key: "updaters_q06_e", pattern: "complaint", text: {
          uz: "Statuslarni oʻzim tiklayman, keyin topshiruv talabini rahbarlar oldiga qoʻyaman: izohlar necha oydan beri yuzaki yuritiladi.",
          ru: "Статусы восстановлю сам, а затем поставлю перед руководителями требование к передаче: заметки месяцами ведутся поверхностно.",
          en: "I would rebuild the statuses myself, then put the handoff requirement to the leads: the notes have been kept shallow for months.",
        } },
      ],
    },
    {
      key: "updaters_q07",
      text: {
        uz: "GPSda trak katta yoʻl chetida uch soatdan beri qimirlamay turibdi, reja boʻyicha esa u allaqachon yoʻlda boʻlishi kerak edi. Haydovchi qoʻngʻiroqlarga ham, xabarlarga ham javob bermayapti. Birinchi navbatda nima qilasiz?",
        ru: "По GPS трак уже три часа стоит без движения на обочине трассы, хотя по плану давно должен быть в пути. Водитель не отвечает ни на звонки, ни на сообщения. Что вы сделаете в первую очередь?",
        en: "The GPS shows the truck sitting motionless on the highway shoulder for three hours when it should long since be moving. The driver is answering neither calls nor messages. What would you do first?",
      },
      options: [
        { key: "updaters_q07_a", pattern: "victim", text: {
          uz: "Dispetcherga xabar beraman va rahbarga aytib qoʻyaman: bir vaqtda oʻnlab trakni kuzatamiz — biror narsa boʻlsa, birinchi savol updaterga qaralmasligi kerak.",
          ru: "Сообщу диспетчеру и скажу руководителю: мы следим за десятками траков одновременно — если что-то случится, первый вопрос не должен быть к апдейтеру.",
          en: "I would notify the dispatcher and tell my lead we watch dozens of trucks at once — if something has happened, the first question should not be the updater’s.",
        } },
        { key: "updaters_q07_b", pattern: "ownership", text: {
          uz: "Dispetcherga shu daqiqada chiqaraman: aniq joylashuv, trak qancha vaqt turgani va haydovchi bilan aloqa yoʻqligi — bu ushlab turiladigan narsa emas.",
          ru: "Прямо сейчас выведу диспетчеру: точная позиция, сколько трак стоит и что связи с водителем нет — это не то, с чем можно сидеть.",
          en: "I would escalate to the dispatcher this minute: the exact position, how long it has stood, and that the driver is unreachable — this is not something to sit on.",
        } },
        { key: "updaters_q07_c", pattern: "complaint", text: {
          uz: "Dispetcherga xabar beraman, lekin jamoada aytaman: haydovchilar dam olishda telefonni oʻchirishga oʻrgangan — aloqa talabi kuchaytirilmasa, bunday sukunatlar davom etadi.",
          ru: "Сообщу диспетчеру, но в команде скажу: водители привыкли выключать телефон на отдыхе — пока не усилят требование по связи, такие молчания продолжатся.",
          en: "I would notify the dispatcher, but say in the team drivers have got used to switching phones off on breaks — untightened, these silences continue.",
        } },
        { key: "updaters_q07_d", pattern: "builder", text: {
          uz: "Faktlarni dispetcherga darhol yetkazaman va zaxira kontaktlarga urinaman; masala yopilgach, «aloqa yoʻq va uzoq toʻxtash» holatlari uchun eskalatsiya qoidasini kelishaman.",
          ru: "Немедленно передам факты диспетчеру и попробую резервные контакты, а после согласую правило эскалации для таких случаев.",
          en: "I would pass the facts to the dispatcher at once and try the backup contacts, then agree an escalation rule for “no contact plus a long stop”.",
        } },
        { key: "updaters_q07_e", pattern: "blame", text: {
          uz: "Dispetcher allaqachon bilishi mumkin — avval shuni tekshiraman: haydovchi bilan gaplashib bizga aytmagan boʻlsa, uzilish ham, javob ham oʻsha tomonda.",
          ru: "Диспетчер может уже знать — сначала проверю это: если он говорил с водителем и нам не сказал, и разрыв, и ответ на той стороне.",
          en: "The dispatcher may already know — I would check that first: if he spoke with the driver and did not tell us, both the break and the answer sit on that side.",
        } },
      ],
    },
    {
      key: "updaters_q08",
      text: {
        uz: "Broker qoʻngʻiroq qilib aytdi: sizning updateingizda yetkazib berish ertaga 08:00 deb turibdi, qabul qiluvchi esa vaqt 14:00 ga koʻchirilganini tasdiqlagan. Maʼlum boʻlishicha, dispetcher vaqtni oʻzgartirgan, lekin sizga hech kim aytmagan. Birinchi navbatda nima qilasiz?",
        ru: "Брокер звонит: в вашем обновлении доставка стоит на завтра 08:00, а получатель подтвердил перенос на 14:00. Выясняется, что диспетчер перенёс время, но вам никто не сказал. Что вы сделаете в первую очередь?",
        en: "A broker calls: your update says delivery tomorrow at 08:00, but the receiver has confirmed the appointment moved to 14:00. It turns out dispatch rescheduled and no one told you. What would you do first?",
      },
      options: [
        { key: "updaters_q08_a", pattern: "ownership", text: {
          uz: "Yangi vaqtni dispetcher bilan hoziroq tasdiqlab, brokerga tuzatilgan updateni oʻzim yuboraman — mijozning maʼlumoti bugun toʻgʻri boʻlishi kerak.",
          ru: "Прямо сейчас подтвержу новое время у диспетчера и сам отправлю брокеру исправленное обновление: информация у клиента должна стать верной сегодня.",
          en: "I would confirm the new time with the dispatcher right now and send the broker a corrected update myself — the customer’s information has to be right today.",
        } },
        { key: "updaters_q08_b", pattern: "blame", text: {
          uz: "Dispetcherlik vaqtni bizga aytmasdan oʻzgartirganini rahbarga yozaman — notoʻgʻri update qaysi uzilishdan chiqqani aniq qayd etilishi kerak.",
          ru: "Напишу руководителю, что диспетчерская изменила время, не сказав нам: должно быть чётко зафиксировано, из какого разрыва вышел неверный апдейт.",
          en: "I would write to my lead that dispatch changed the time without telling us — it should be clearly on record which break produced the wrong update.",
        } },
        { key: "updaters_q08_c", pattern: "waiting", text: {
          uz: "Tuzatishni shoshmayman: dispetcher boʻshagach vaqtni oʻzi tasdiqlasin — broker orqali kelgan gap bizga rasmiy manba emas, yana xato yubormaslik kerak.",
          ru: "С исправлением не спешу: пусть диспетчер сам подтвердит время, когда освободится — слова через брокера для нас не официальный источник, второй ошибки быть не должно.",
          en: "I would not rush the correction: let the dispatcher confirm the time himself when free — word via the broker is not an official source, and a second error is worse.",
        } },
        { key: "updaters_q08_d", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: bizdan aniqlik talab qilinadi, kirish maʼlumoti esa bizdan orqada oʻzgaradi — xatoni broker aytgani mening ishim deb koʻrilmasligi kerak.",
          ru: "Прямо скажу руководителю: точности требуют от нас, а входные данные меняются за нашей спиной — то, что об ошибке сказал брокер, не стоит считать моей работой.",
          en: "I would tell my lead plainly accuracy is demanded of us while the inputs change behind our backs — the broker catching it is not a measure of my work.",
        } },
        { key: "updaters_q08_e", pattern: "builder", text: {
          uz: "Yangi vaqtni tasdiqlab brokerga tuzatilgan update yuboraman, keyin dispetcher bilan har apoyntment oʻzgarishi update kanaliga darhol yozilishini kelishaman.",
          ru: "Подтвержу новое время и отправлю брокеру исправленное обновление, а затем договорюсь с диспетчером сразу писать любое изменение аппоинтмента в канал апдейтов.",
          en: "I would confirm the new time and send the broker a corrected update, then agree with the dispatcher that every appointment change is posted to the updates channel.",
        } },
      ],
    },
    {
      key: "updaters_q09",
      text: {
        uz: "Haydovchi yuklanib yoʻlga chiqqanini aytdi, lekin plomba raqami bilan palletlar sonini yubormadi. Brokerning tizimi bu maʼlumotlarni yuklashdan keyin bir soat ichida talab qiladi. Haydovchi hozir harakatda. Birinchi navbatda nima qilasiz?",
        ru: "Водитель сообщил, что загрузился и выехал, но не прислал номер пломбы и количество паллет. Система брокера требует эти данные в течение часа после погрузки. Водитель сейчас в движении. Что вы сделаете в первую очередь?",
        en: "The driver reported he is loaded and rolling, but did not send the seal number or the pallet count. The broker’s system requires this data within an hour of loading. The driver is on the move now. What would you do first?",
      },
      options: [
        { key: "updaters_q09_a", pattern: "builder", text: {
          uz: "Maʼlumotni BOL suratidan olaman yoki haydovchidan xavfsiz toʻxtashda soʻrayman, keyin plomba va pallet sonini «yuklandi» qoʻngʻirogʻining doimiy bandi qilaman.",
          ru: "Возьму данные с фото BOL или попрошу у водителя на безопасной остановке, а затем сделаю пломбу и число паллет постоянным пунктом звонка «загрузился».",
          en: "I would take the data from the BOL photo or ask the driver at a safe stop, then make the seal and pallet count a permanent item of the “loaded” call.",
        } },
        { key: "updaters_q09_b", pattern: "complaint", text: {
          uz: "Maʼlumotni olaman, lekin rahbarga aytaman: haydovchilar «yuklandim» deb yozib, ishni tugagan deb hisoblaydi — talab aniq belgilanmasa, har safar shunday boʻladi.",
          ru: "Данные получу, но скажу руководителю: водители пишут «загрузился» и считают дело сделанным — пока требование не прописано ясно, так будет каждый раз.",
          en: "I would get the data, but tell my lead drivers write “loaded” and consider the job done — until the requirement is stated clearly, this happens every time.",
        } },
        { key: "updaters_q09_c", pattern: "victim", text: {
          uz: "Plomba raqamini haydovchi yubormadi, muddat buzilsa esa savol bizga keladi — soʻrov qachon ketganini hoziroq yozib qoʻyaman.",
          ru: "Номер пломбы не прислал водитель, а при нарушении срока вопрос придёт к нам — прямо сейчас зафиксирую, когда ушёл запрос.",
          en: "The driver did not send the seal number yet a missed deadline brings the question to us — I would record right now when the request went out.",
        } },
        { key: "updaters_q09_d", pattern: "waiting", text: {
          uz: "Haydovchi baribir tez orada yoqilgʻi yoki dam olish uchun toʻxtaydi — rulda odamni chalgʻitmasdan, maʼlumot oʻsha toʻxtashda kelishini kutaman.",
          ru: "Водитель всё равно скоро остановится на заправку или отдых — не отвлекая человека за рулём, возьму данные именно на этой остановке.",
          en: "The driver will stop for fuel or rest soon anyway — rather than distract a man at the wheel, I would let the numbers come at that stop instead.",
        } },
        { key: "updaters_q09_e", pattern: "ownership", text: {
          uz: "Avval haydovchi yuborgan hujjat suratlarini tekshiraman — raqamlar koʻpincha BOLda; boʻlmasa, xavfsiz toʻxtashda soʻrab, hammasini muddat ichida oʻzim kiritaman.",
          ru: "Сначала проверю присланные водителем фото документов — цифры обычно в BOL; если нет, попрошу на безопасной остановке и сам внесу всё в срок.",
          en: "I would first check the document photos the driver sent — the numbers are usually on the BOL; if not, I would ask at a safe stop and enter it all in time.",
        } },
      ],
    },
    {
      key: "updaters_q10",
      text: {
        uz: "Soʻnggi ikki haftada ertalabki updatelar bir necha marta oxirgi daqiqada yoki kechikib ketdi — bugun buni mijoz ham payqab, eslatma yozdi. Yuklar soni oshgan, ish tartibi esa avvalgicha qolgan. Birinchi navbatda nima qilasiz?",
        ru: "За последние две недели утренние обновления несколько раз уходили в последнюю минуту или с опозданием — сегодня это заметил клиент и написал замечание. Количество грузов выросло, а порядок работы остался прежним. Что вы сделаете в первую очередь?",
        en: "Over the past two weeks the morning updates have several times gone out at the last minute or late — today a customer noticed and wrote a remark. The load count has grown, but the working routine is unchanged. What would you do first?",
      },
      options: [
        { key: "updaters_q10_a", pattern: "complaint", text: {
          uz: "Yigʻilishda aytaman: bir odamga tushayotgan yuk soni bilan hozirgi tartibda kechikish tabiiy — oʻsgan hajm bir necha marta aytilgan, qaror esa yuqorida.",
          ru: "Скажу на совещании: при таком числе грузов на человека и текущем порядке опоздания естественны — о выросшем объёме говорили не раз, а решение выше.",
          en: "I would say at the meeting that with this load count per person and the current routine, late updates are natural — the growth has been raised, the call is above me.",
        } },
        { key: "updaters_q10_b", pattern: "builder", text: {
          uz: "Ertalabni qayta tuzaman: statuslarni kechqurundan tayyorlayman, keyin ertalabki updatelarni ustuvorlik boʻyicha ikki toʻlqinga boʻlishni taklif qilaman.",
          ru: "Перестрою утро: статусы подготовлю с вечера, а затем предложу команде разделить утренние апдейты на две волны по приоритету.",
          en: "I would rebuild the morning: prepare the statuses the evening before, then propose splitting the morning updates into two priority waves.",
        } },
        { key: "updaters_q10_c", pattern: "ownership", text: {
          uz: "Bugun oʻz ertalabimni koʻrib chiqaman: birinchi soatni nima yeyayotganini aniqlayman va asosiy mijozlar updateini eng boshiga koʻchiraman.",
          ru: "Сегодня разберу собственное утро: выясню, что съедает первый час, и передвину апдейты ключевых клиентов в самое начало.",
          en: "I would go through my own morning today: work out what eats the first hour and move the key customers’ updates to the very start.",
        } },
        { key: "updaters_q10_d", pattern: "blame", text: {
          uz: "Kechikkan updatelar aynan kimning yuklarida boʻlganini koʻraman — sabab maʼlumotni boshqa boʻlim kech berishi boʻlsa, savol ham oʻsha yerga qoʻyilishi kerak.",
          ru: "Посмотрю, по чьим именно грузам апдейты опаздывали: если причина в том, что данные поздно даёт другой отдел, вопрос надо ставить там.",
          en: "I would look at whose loads the late updates involved — if the cause is another department handing data over late, the question belongs there.",
        } },
        { key: "updaters_q10_e", pattern: "waiting", text: {
          uz: "Hajm oshganini rahbariyat oʻzi koʻrib turadi — jadval yoki xodim boʻyicha qarorni kutaman: har kim tartibni oʻzicha oʻzgartirsa, umumiy ish chalkashadi.",
          ru: "Рост объёма руководство видит и само — дождусь решения по графику или по людям: если каждый перестроит порядок по-своему, общая работа спутается.",
          en: "Management can see the growth themselves — I would wait for a decision on the schedule or staffing: if everyone reshapes the routine their own way, it tangles.",
        } },
      ],
    },
  ],
};
