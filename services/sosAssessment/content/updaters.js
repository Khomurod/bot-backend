/**
 * SOS assessment content — Updaters department (10 questions).
 *
 * Scope: driver location/status updates, pickup and delivery confirmations,
 * unclear ETAs, unreachable drivers, ELD/GPS tracking gaps, late updates
 * discovered after the fact, urgent broker/customer requests, shift handoffs,
 * communication with dispatch and drivers, conflicting data, escalation,
 * preventing missed updates.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - no option ever invents an ETA, guesses a location, or hides uncertainty
 *    from a broker/customer — "say what is confirmed and when you will know
 *    more" is the standard.
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
          uz: "Brokerga tasdiqlangan faktni beraman — ELDdagi oxirgi joylashuv va uning vaqtini aytaman, haydovchiga chiqayotganimni ochiq aytib, yarim soat ichida oʻzim qayta qoʻngʻiroq qilishga soʻz beraman.",
          ru: "Дам брокеру подтверждённый факт — последнюю позицию по ELD и её время, честно скажу, что вызваниваю водителя, и пообещаю сам перезвонить в течение получаса.",
          en: "Give the broker the confirmed fact — the last ELD position and its time — say openly that I am chasing the driver, and promise to call back myself within half an hour.",
        } },
        { key: "updaters_q01_b", pattern: "complaint", text: {
          uz: "Hamkasblarga brokerlar javobni shu zahoti talab qilishini, haydovchilar esa telefon koʻtarmasligini aytaman — biz doim ana shu ikki oʻt orasida qolamiz.",
          ru: "Скажу коллегам, что брокеры требуют ответ немедленно, а водители не берут трубку — мы вечно оказываемся между двух огней.",
          en: "Tell my coworkers that brokers demand an answer instantly while drivers do not pick up — we always end up caught between the two fires.",
        } },
        { key: "updaters_q01_c", pattern: "builder", text: {
          uz: "Brokerga oxirgi tasdiqlangan joylashuvni aytaman, haydovchi va dispetcherga parallel yozaman, masala yopilgach esa shu brokerning yuklari boʻyicha doimiy update jadvalini kelishib olishni taklif qilaman.",
          ru: "Назову брокеру последнюю подтверждённую позицию, параллельно напишу водителю и диспетчеру, а после закрытия вопроса предложу согласовать постоянный график обновлений по грузам этого брокера.",
          en: "Tell the broker the last confirmed position, message the driver and the dispatcher in parallel, and once it is settled, propose a standing update schedule for this broker’s loads.",
        } },
        { key: "updaters_q01_d", pattern: "waiting", text: {
          uz: "Brokerdan ozgina vaqt soʻrayman: ikki soat oldingi maʼlumot eskirgan boʻlishi mumkin, haydovchining oʻzi tasdiqlamaguncha aniq bir gap aytmaganim toʻgʻriroq boʻladi.",
          ru: "Попрошу у брокера немного времени: данные двухчасовой давности могли устареть, и пока водитель сам не подтвердит, правильнее не называть ничего определённого.",
          en: "Ask the broker for a little time: two-hour-old data may be stale, and until the driver himself confirms, it is safer not to state anything definite.",
        } },
        { key: "updaters_q01_e", pattern: "victim", text: {
          uz: "Nega bunday shoshilinch qoʻngʻiroqlar doim mening smenamga toʻgʻri keladi, deb oʻylayman — kun tinch oʻtayotgan edi, endi hamma eʼtibor menga qadaladi.",
          ru: "Подумаю: почему такие срочные звонки всегда выпадают на мою смену — день шёл спокойно, а теперь всё внимание будет приковано ко мне.",
          en: "Wonder why these urgent calls always land on my shift — the day was going smoothly, and now all the attention is about to be fixed on me.",
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
          uz: "Bunday uzilishlar aloqasiz hududlarda tez-tez boʻladi va odatda oʻz-oʻzidan tiklanadi — signal qaytishini kutaman, shundan keyin holatga qarab ish tutaman.",
          ru: "Такие обрывы часто случаются в зонах без связи и обычно восстанавливаются сами — подожду возвращения сигнала и уже тогда буду действовать по ситуации.",
          en: "Gaps like this happen often in dead zones and usually restore on their own — I will wait for the signal to come back and act on the situation then.",
        } },
        { key: "updaters_q02_b", pattern: "builder", text: {
          uz: "Haydovchidan haqiqiy joylashuvni tasdiqlab tizimga kiritaman, signal tiklangunicha updatelarni qoʻlda berib turaman va uskunani tekshirtirish uchun bu trakni ELD masʼuliga xabar qilaman.",
          ru: "Уточню у водителя реальную позицию и внесу её в систему, до восстановления сигнала буду давать обновления вручную и сообщу об этом траке ответственному за ELD, чтобы проверили оборудование.",
          en: "Confirm the real position with the driver and log it, keep the updates going manually until the signal returns, and report this truck to the ELD owner so the unit gets checked.",
        } },
        { key: "updaters_q02_c", pattern: "blame", text: {
          uz: "Avval bu trakning ELD qurilmasiga kim masʼulligini va avvalgi uzilishlar haqidagi ogohlantirishlar kimga borganini aniqlayman — kamchilik qaysi boʻlimda ekanini bilish kerak.",
          ru: "Сначала выясню, кто отвечает за ELD-устройство этого трака и кому уходили предупреждения о прошлых обрывах — надо понять, в каком отделе упущение.",
          en: "First find out who is responsible for this truck’s ELD unit and who received the alerts about earlier gaps — we need to know which department dropped this.",
        } },
        { key: "updaters_q02_d", pattern: "ownership", text: {
          uz: "Hoziroq haydovchi bilan bogʻlanib, haqiqiy joylashuvi va holatini aniqlayman, soʻng tasdiqlangan maʼlumotni tizimga kiritaman — mijoz koʻrayotgan manzara yana toʻgʻri boʻlishi kerak.",
          ru: "Прямо сейчас свяжусь с водителем, уточню реальную позицию и статус, затем внесу подтверждённые данные в систему — картина у клиента должна снова стать верной.",
          en: "Reach the driver right now, confirm his actual position and status, then post the verified information in the system — the picture the customer sees needs to be accurate again.",
        } },
        { key: "updaters_q02_e", pattern: "complaint", text: {
          uz: "Bu ELD qurilmalari doim uzilib qolishini yana bir bor aytaman — texnika muammosi yillar davomida hal boʻlmaydi, oqibatini esa har safar bizning boʻlim koʻtaradi.",
          ru: "В который раз скажу, что эти ELD-устройства постоянно отваливаются — проблема с техникой годами не решается, а последствия каждый раз ложатся на наш отдел.",
          en: "Say once more that these ELD units keep dropping out — the equipment problem has gone unsolved for years, and every time our department carries the consequences.",
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
          uz: "Qaysi maʼlumotni bersam ham, notoʻgʻri chiqsa javobi menga qolishi xayolimdan oʻtadi — tizim bilan haydovchi orasidagi tafovutlar uchun oxirida doim biz javob beramiz.",
          ru: "Мелькнёт мысль: какие данные ни передай, если они окажутся неверными, отвечать мне — за расхождения между системой и водителями в итоге всегда отдуваемся мы.",
          en: "It crosses my mind that whichever data I pass on, if it proves wrong the answer lands on me — in the end it is always us answering for gaps between the system and the drivers.",
        } },
        { key: "updaters_q03_b", pattern: "waiting", text: {
          uz: "Manzara bir-biriga mos kelmaguncha brokerga qatʼiy javob bermay turaman — GPS yangilanishini kutaman: ziddiyatli maʼlumot uzatgandan koʻra biroz kechiktirgan maʼqul.",
          ru: "Пока картина не сойдётся, не буду давать брокеру определённый ответ — дождусь обновления GPS: лучше небольшая задержка, чем переданное противоречие.",
          en: "Hold off on a definite answer to the broker until the picture lines up — wait for the GPS to refresh: a short delay is better than passing on a contradiction.",
        } },
        { key: "updaters_q03_c", pattern: "ownership", text: {
          uz: "Haydovchidan joyini tasdiqlashni soʻrayman — masalan, lokatsiya yoki kirish belgisini yuborsin — qaysi maʼlumot toʻgʻriligini aniqlab, brokerga tasdiqlangan statusni oʻzim yetkazaman.",
          ru: "Попрошу водителя подтвердить местоположение — например, прислать геометку или отметку о заезде, — определю, какие данные верны, и сам передам брокеру подтверждённый статус.",
          en: "Ask the driver to confirm where he is — say, by sending a location pin or his check-in — establish which data is right, and pass the confirmed status to the broker myself.",
        } },
        { key: "updaters_q03_d", pattern: "blame", text: {
          uz: "Avval bu tafovut kimning xatosidan chiqqanini aniqlayman — trak tizimda notoʻgʻri biriktirilganmi yoki haydovchi boshqa yukni aytayaptimi; xatoga kim yoʻl qoʻygan boʻlsa, oʻsha toʻgʻrilasin.",
          ru: "Сначала разберусь, чья ошибка дала расхождение — трак неверно прикреплён в системе или водитель говорит о другом грузе; кто допустил ошибку, тот пусть и исправляет.",
          en: "First work out whose mistake created the mismatch — the truck is attached wrong in the system, or the driver is talking about another load; whoever made the error should fix it.",
        } },
        { key: "updaters_q03_e", pattern: "builder", text: {
          uz: "Joyni haydovchi orqali tasdiqlab, brokerga aniq statusni beraman, soʻng tizimdagi biriktiruvni tekshirtirib xatoni tuzattiraman — keyingi smena ham shu tafovutga qoqilmasin.",
          ru: "Подтвержу позицию через водителя и дам брокеру точный статус, затем добьюсь проверки привязки в системе и исправления ошибки — чтобы следующая смена не споткнулась о то же расхождение.",
          en: "Confirm the position through the driver and give the broker an accurate status, then get the system assignment checked and corrected — so the next shift does not trip over the same mismatch.",
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
          uz: "Mijozga holatni boricha aytib, trak yoʻlga chiqishi bilan aniq ETA berishga kelishaman, dispetcherdan yuklashning kutilayotgan tugash vaqtini surishtiraman va besh soatlik kutish haqida uni ogohlantiraman.",
          ru: "Скажу клиенту как есть и договорюсь, что точное ETA дам сразу после выезда, уточню у диспетчера ожидаемое время окончания погрузки и предупрежу его о пятичасовом простое.",
          en: "Tell the customer how things stand and agree to send a firm ETA right after departure, ask dispatch for the expected loading finish time, and flag the five-hour detention to them.",
        } },
        { key: "updaters_q04_b", pattern: "blame", text: {
          uz: "Avval bu yuk mijozga qanday muddat bilan sotilganini koʻraman — unga boʻlmaydigan vaqt vaʼda qilingan boʻlsa, endi mijozga buni vaʼda bergan tomon tushuntirgani toʻgʻri boʻladi.",
          ru: "Сначала посмотрю, с какими сроками этот груз продали клиенту — если ему пообещали нереальное время, объясняться по-хорошему должна та сторона, которая это обещала.",
          en: "First look at what timeline this load was sold with — if the customer was promised an unrealistic window, the side that made that promise should really be the one explaining.",
        } },
        { key: "updaters_q04_c", pattern: "victim", text: {
          uz: "Mendan oʻzimga umuman bogʻliq boʻlmagan raqam talab qilinayotgani alam qiladi — yuklashni men boshqarmayman, lekin kechikish uchun gapni baribir men eshitaman.",
          ru: "Обидно, что с меня требуют цифру, которая от меня никак не зависит — погрузкой управляю не я, но выслушивать за задержку буду именно я.",
          en: "It stings that I am being asked for a number that does not depend on me at all — I do not control the loading, yet I am the one who will hear about the delay.",
        } },
        { key: "updaters_q04_d", pattern: "complaint", text: {
          uz: "Mijozga bu yuklash joyi doim sekin ishlashini, bunday kutishlar bizda tez-tez boʻlib turishini aytaman — afsuski, bu bizga bogʻliq boʻlmagan eski muammo.",
          ru: "Скажу клиенту, что этот грузоотправитель всегда работает медленно и такие ожидания случаются часто — увы, это давняя проблема, которая от нас не зависит.",
          en: "Let the customer know this shipper always works slowly and waits like this happen often — sadly, an old problem that is out of our hands.",
        } },
        { key: "updaters_q04_e", pattern: "ownership", text: {
          uz: "Mijozga hozirgi holatni ochiq aytaman — yuklash tugamagan, aniq vaqt hali yoʻq — va trak yoʻlga chiqishi bilan birinchi boʻlib unga oʻzim xabar berishga soʻz beraman.",
          ru: "Открыто скажу клиенту текущее положение — погрузка не завершена, точного времени пока нет — и дам слово, что сообщу ему первым, как только трак выедет.",
          en: "Openly tell the customer where things stand — loading is not finished and there is no exact time yet — and give my word to notify him first as soon as the truck rolls.",
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
          uz: "Jamoada kechki smenaga tushadigan yuk hajmi bilan qaysidir update tushib qolishi tabiiy ekanini aytaman — ish shunday tashkil etilgan ekan, hammasiga ulgurishning iloji yoʻq.",
          ru: "Замечу в команде, что при объёме грузов вечерней смены какое-то обновление неизбежно выпадает — при такой организации работы успеть всё просто невозможно.",
          en: "Point out to the team that with the evening shift’s load volume, some update inevitably slips — with the work organized like this, keeping up with everything is simply impossible.",
        } },
        { key: "updaters_q05_b", pattern: "ownership", text: {
          uz: "Hoziroq brokerga tasdiqlangan yetkazib berish vaqti va hujjatni yuboraman, kechikish uchun uzr soʻrayman va bugun savollariga oʻzim javob berishimni yozaman.",
          ru: "Прямо сейчас отправлю брокеру подтверждённое время доставки и документ, извинюсь за задержку и напишу, что сегодня на его вопросы отвечаю лично я.",
          en: "Send the broker the confirmed delivery time and the paperwork right now, apologize for the delay, and write that I am personally handling his questions today.",
        } },
        { key: "updaters_q05_c", pattern: "victim", text: {
          uz: "Kechagi smenada oʻtkazib yuborilgan xato uchun bugun mening kunim buzilayotganidan ranjiyman — xatni birinchi boʻlib ochganim uchun barcha savollar endi menga qaraydi.",
          ru: "Станет обидно, что из-за промаха вчерашней смены испорчен мой день — раз письмо первым открыл я, все вопросы теперь смотрят в мою сторону.",
          en: "Feel hurt that yesterday’s shift’s miss is wrecking my day — since I was the one who opened the email first, all the questions now look my way.",
        } },
        { key: "updaters_q05_d", pattern: "builder", text: {
          uz: "Brokerga tasdiqni yuborib uzr soʻrayman, soʻng smena yopilishida yuborilmagan updatelarni tekshiradigan qisqa roʻyxat joriy qilishni taklif qilaman — bunday xato ertalabgacha yashamasin.",
          ru: "Отправлю брокеру подтверждение и извинюсь, а затем предложу ввести короткую проверку неотправленных обновлений при закрытии смены — чтобы такая ошибка не доживала до утра.",
          en: "Send the broker the confirmation with an apology, then propose a short end-of-shift check of unsent updates — so a miss like this never survives until morning.",
        } },
        { key: "updaters_q05_e", pattern: "waiting", text: {
          uz: "Xatda rahbariyat ham nusxada turibdi — javob yozishdan oldin rahbar qanday pozitsiya tanlashini kutaman: brokerga ikki xil javob ketib qolmasligi kerak.",
          ru: "В копии письма стоит руководство — прежде чем отвечать, дождусь, какую позицию выберет руководитель: брокеру не должны уйти два разных ответа.",
          en: "Management is on the copy line — before replying, I will wait to see what position the manager takes: the broker must not receive two different answers.",
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
          uz: "Avval yozuvlarni kim shu holatda qoldirganini aniqlab, rahbarga bildiraman — har kim oʻz smenasini qanday topshirganiga oʻzi javob berishi kerak.",
          ru: "Сначала установлю, кто оставил записи в таком виде, и сообщу руководителю — каждый должен сам отвечать за то, как передал свою смену.",
          en: "First establish who left the notes in this state and let the manager know — everyone should answer for how they handed over their own shift.",
        } },
        { key: "updaters_q06_b", pattern: "waiting", text: {
          uz: "Oldingi smenadagi hamkasb bir necha soatdan keyin aloqaga chiqadi — chala maʼlumot bilan aralashgandan koʻra, undan hammasini aniqlab olgunimcha oʻsha yuklarga tegmay turaman.",
          ru: "Коллега с прошлой смены выйдет на связь через несколько часов — чем действовать с неполными данными, лучше не трогать эти грузы, пока всё у него не уточню.",
          en: "The coworker from the last shift will be reachable in a few hours — rather than act on partial data, I will leave those loads alone until I can clarify everything with him.",
        } },
        { key: "updaters_q06_c", pattern: "builder", text: {
          uz: "Tizim va yozishmalar orqali holatlarni oʻzim tiklab, noaniq yuklarni birma-bir tekshiraman, soʻng har bir yuk uchun majburiy bandlari bor topshiruv shablonini joriy qilishni taklif qilaman.",
          ru: "Сам восстановлю статусы по системе и переписке, проверю неясные грузы по одному, а затем предложу ввести шаблон передачи смены с обязательными пунктами по каждому грузу.",
          en: "Rebuild the statuses myself from the system and the message history, verify the unclear loads one by one, then propose a handoff template with mandatory fields for every load.",
        } },
        { key: "updaters_q06_d", pattern: "ownership", text: {
          uz: "Noaniq yuklardan boshlayman: tizim tarixini koʻrib chiqaman, kerak boʻlsa haydovchilarga qoʻngʻiroq qilaman va har bir yukning hozirgi holatini oʻzim aniqlab olaman.",
          ru: "Начну с неясных грузов: просмотрю историю в системе, где нужно — позвоню водителям, и сам выясню текущее состояние каждого груза.",
          en: "Start with the unclear loads: go through the system history, call the drivers where needed, and establish the current state of every load myself.",
        } },
        { key: "updaters_q06_e", pattern: "complaint", text: {
          uz: "Topshiruv yozuvlari necha oydan beri yuzaki yuritilayotganini yana bir bor koʻtaraman — chala yozuvlar bilan smena qabul qilish har safar lotereyaga oʻxshab qolyapti.",
          ru: "Ещё раз подниму вопрос, что записи передачи месяцами ведутся поверхностно — принимать смену с половинными записями каждый раз как лотерея.",
          en: "Raise once again that the handoff notes have been kept superficial for months — taking over a shift on half-filled notes is a lottery every single time.",
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
          uz: "Biror gap boʻlgan boʻlsa, birinchi savol «updater qayoqqa qaragan» boʻlishini oʻylayman — bir vaqtning oʻzida oʻnlab trakni kuzatayotganimizni esa hech kim hisobga olmaydi.",
          ru: "Подумаю: если что-то случилось, первым вопросом будет «куда смотрел апдейтер» — а то, что мы следим за десятками траков одновременно, никто не учтёт.",
          en: "Think that if something has happened, the first question will be “where was the updater looking” — while no one will account for us watching dozens of trucks at once.",
        } },
        { key: "updaters_q07_b", pattern: "ownership", text: {
          uz: "Vaziyatni shu zahoti dispetcherga yetkazaman: aniq joylashuvni, qancha vaqtdan beri turganini va haydovchi aloqaga chiqmayotganini aytaman — bunday holat ustida oʻtirib boʻlmaydi.",
          ru: "Немедленно передам ситуацию диспетчеру: точную позицию, сколько времени стоит трак и что водитель не выходит на связь — с таким сидеть нельзя.",
          en: "Escalate to the dispatcher this minute: the exact position, how long the truck has been sitting, and that the driver is unreachable — this is not something to sit on.",
        } },
        { key: "updaters_q07_c", pattern: "complaint", text: {
          uz: "Haydovchilar dam olishda telefonini oʻchirib qoʻyishi odatga aylanganini aytaman — har safargi bunday jimlik bizga qancha asabga tushishini faqat oʻzimiz bilamiz.",
          ru: "Замечу, что у водителей вошло в привычку выключать телефон на отдыхе — сколько нервов нам стоит каждая такая тишина, знаем только мы.",
          en: "Say that drivers have made a habit of switching their phones off on breaks — only we know how many nerves each of these silences costs us.",
        } },
        { key: "updaters_q07_d", pattern: "builder", text: {
          uz: "Dispetcherga faktlarni darhol yetkazib, zaxira raqamlar orqali urinishni davom ettiraman; masala hal boʻlgach, «aloqa yoʻq va uzoq toʻxtash» holatlari uchun aniq eskalatsiya tartibini taklif qilaman.",
          ru: "Сразу передам факты диспетчеру и продолжу пробовать запасные контакты; когда ситуация разрешится, предложу закрепить чёткий порядок эскалации для случаев «нет связи и долгая стоянка».",
          en: "Pass the facts to the dispatcher at once and keep trying backup contacts; once it is resolved, propose a defined escalation rule for “no contact plus a long stop” cases.",
        } },
        { key: "updaters_q07_e", pattern: "blame", text: {
          uz: "Avval dispetcher bundan xabardor-xabardor emasligini tekshiraman — u haydovchi bilan gaplashib bizga aytmagan boʻlsa, xavotirning sababi ham, javobgarligi ham oʻsha tomonda.",
          ru: "Сначала проверю, знает ли об этом диспетчер — если он говорил с водителем и не сообщил нам, то и причина тревоги, и ответственность за неё на той стороне.",
          en: "First check whether the dispatcher already knows — if he spoke with the driver and did not tell us, both the cause of the alarm and the answerability for it sit on that side.",
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
          uz: "Hoziroq dispetcherdan yangi vaqtni tasdiqlab olaman va brokerga tuzatilgan updateni oʻzim yuboraman — mijozdagi maʼlumot bugunoq toʻgʻri holatga kelishi kerak.",
          ru: "Сразу уточню у диспетчера новое время и сам отправлю брокеру исправленное обновление — данные у клиента должны стать верными уже сегодня.",
          en: "Confirm the new time with the dispatcher right away and send the broker a corrected update myself — the customer’s information needs to be right again today.",
        } },
        { key: "updaters_q08_b", pattern: "blame", text: {
          uz: "Rahbarga vaqtni dispetcher oʻzgartirgani-yu bizga bildirilmaganini yozaman — notoʻgʻri update kimning kamchiligi tufayli ketgani aniq qayd etilishi kerak.",
          ru: "Напишу руководителю, что время изменил диспетчер и нас не уведомили — должно быть чётко зафиксировано, из-за чьего упущения ушло неверное обновление.",
          en: "Write to the manager that dispatch changed the time without notifying us — it should be recorded clearly whose omission caused the wrong update to go out.",
        } },
        { key: "updaters_q08_c", pattern: "waiting", text: {
          uz: "Tuzatishga shoshilmayman: dispetcher boʻshagach yangi vaqtni oʻzi tasdiqlasin — broker orqali kelgan gap biz uchun rasmiy manba emas, yana bir xato yuborib qoʻyishni istamayman.",
          ru: "Не буду спешить с исправлением: пусть диспетчер, когда освободится, сам подтвердит время — слова через брокера для нас не официальный источник, не хочу отправить ещё одну ошибку.",
          en: "Not rush the correction: let the dispatcher confirm the time himself once he frees up — word passed through the broker is not an official source for us, and I would rather not send another error.",
        } },
        { key: "updaters_q08_d", pattern: "victim", text: {
          uz: "Bizni aniqlik uchun baholashadi-yu, maʼlumot esa orqamizdan oʻzgaraveradi — xatoni broker aytib berganda esa izza boʻlib qoladigan yana biz boʻlamiz.",
          ru: "Неприятно: нас оценивают за точность, а данные меняют у нас за спиной — и когда об ошибке сообщает брокер, краснеть приходится нам.",
          en: "It feels unfair: we are judged on accuracy while the inputs change behind our backs — and when it is the broker who reports the error, we are the ones left red-faced.",
        } },
        { key: "updaters_q08_e", pattern: "builder", text: {
          uz: "Yangi vaqtni tasdiqlab, brokerga tuzatilgan update yuboraman, soʻng dispetcher bilan kelishib olaman: har bir vaqt oʻzgarishi shu zahoti updatelar kanaliga yozib boriladi.",
          ru: "Подтвержу новое время и отправлю брокеру исправленное обновление, а затем договорюсь с диспетчером: каждый перенос сразу пишется в канал обновлений.",
          en: "Confirm the new time and send the broker a corrected update, then agree with the dispatcher that every appointment change is posted to the updates channel immediately.",
        } },
      ],
    },
    {
      key: "updaters_q09",
      text: {
        uz: "Haydovchi yuklanib yoʻlga chiqqanini aytdi, lekin plomba raqami bilan palletlar sonini yubormagan. Brokerning tizimi bu maʼlumotlarni yuklashdan keyin bir soat ichida talab qiladi. Haydovchi hozir harakatda. Birinchi navbatda nima qilasiz?",
        ru: "Водитель сообщил, что загрузился и выехал, но не прислал номер пломбы и количество паллет. Система брокера требует эти данные в течение часа после погрузки. Водитель сейчас в движении. Что вы сделаете в первую очередь?",
        en: "The driver reported he is loaded and rolling, but did not send the seal number or the pallet count. The broker’s system requires this data within an hour of loading. The driver is on the move now. What would you do first?",
      },
      options: [
        { key: "updaters_q09_a", pattern: "builder", text: {
          uz: "Maʼlumotni BOL rasmidan olib kiritaman, topilmasa haydovchidan xavfsiz toʻxtaganda yuborishini soʻrayman, keyin esa plomba va pallet sonini yuklash qoʻngʻirogʻining doimiy bandiga aylantiraman.",
          ru: "Возьму данные с фото BOL, а если их там нет — попрошу водителя прислать на безопасной остановке; затем сделаю пломбу и число паллет постоянным пунктом звонка о погрузке.",
          en: "Pull the data from the BOL photo, or ask the driver to send it at a safe stop, then make the seal and pallet count a permanent item of the loaded call.",
        } },
        { key: "updaters_q09_b", pattern: "complaint", text: {
          uz: "Haydovchilar «yuklandim» deb ikki ogʻiz yozadi-da, vazifa bajarildi deb hisoblaydi — har bir raqamni undirish har safar alohida kurashga aylanishini aytaman.",
          ru: "Поделюсь с коллегами: водители пишут «загрузился» в два слова и считают дело сделанным — выбивание каждой цифры всякий раз превращается в отдельную борьбу.",
          en: "Say that drivers write “loaded” in two words and consider the job done — prying every number out of them turns into its own battle every single time.",
        } },
        { key: "updaters_q09_c", pattern: "victim", text: {
          uz: "Muddat oʻtib ketsa, gap haydovchiga emas, bizga tegishi koʻnglimni xira qiladi — maʼlumotni yubormagan u-yu, hisob beradigan biz boʻlamiz.",
          ru: "Досадно, что если срок будет сорван, спросят не с водителя, а с нас — данные не прислал он, а отчитываться придётся нам.",
          en: "It is galling that if the deadline slips, the questions will come to us, not the driver — he is the one who did not send the data, yet we will be the ones reporting on it.",
        } },
        { key: "updaters_q09_d", pattern: "waiting", text: {
          uz: "Haydovchi baribir yaqin orada yonilgʻi yoki tanaffus uchun toʻxtaydi — harakatdagi odamni chalgʻitmay, maʼlumotni oʻshanda yuborishini kutaman.",
          ru: "Водитель всё равно скоро остановится на заправку или перерыв — не буду отвлекать человека за рулём и дождусь данных тогда.",
          en: "The driver will stop for fuel or a break soon anyway — rather than distract a man behind the wheel, I will wait for the data to arrive then.",
        } },
        { key: "updaters_q09_e", pattern: "ownership", text: {
          uz: "Avval haydovchi yuborgan hujjat rasmlarini koʻraman — kerakli raqamlar odatda BOLda turadi; topilmasa, haydovchidan xavfsiz toʻxtashda yuborishini soʻrab, muddat ichida oʻzim kiritaman.",
          ru: "Сначала проверю фото документов от водителя — нужные цифры обычно есть в BOL; если их нет, попрошу прислать на безопасной остановке и сам внесу всё в срок.",
          en: "First check the document photos the driver sent — the numbers are usually on the BOL; if not, ask him to send them at a safe stop and enter everything within the deadline myself.",
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
          uz: "Yigʻilishda bir kishiga tushayotgan yuk soni bilan hozirgi jadvalda kechikishlar tabiiy ekanini aytaman — hajm oshgani haqida necha marta gapirganmiz.",
          ru: "Скажу на планёрке, что при таком количестве грузов на человека задержки при нынешнем графике естественны — про выросший объём говорили уже не раз.",
          en: "Say at the meeting that with this many loads per person, delays are natural under the current schedule — the grown volume has been raised more than once.",
        } },
        { key: "updaters_q10_b", pattern: "builder", text: {
          uz: "Ertalabki ishni qayta quraman: statuslarni bir kun oldin kechqurun tayyorlab qoʻyaman, soʻng jamoaga ertalabki updatelarni muhimlik boʻyicha ikki toʻlqinga boʻlishni taklif qilaman.",
          ru: "Перестрою утро: буду готовить статусы с вечера, а затем предложу команде разбить утренние обновления на две волны по приоритету.",
          en: "Restructure the morning: prepare the statuses the evening before, then propose to the team splitting the morning updates into two waves by priority.",
        } },
        { key: "updaters_q10_c", pattern: "ownership", text: {
          uz: "Bugunoq oʻz ertalabki tartibimni koʻrib chiqaman: birinchi soatni nima yeb qoʻyayotganini aniqlayman va asosiy mijozlarning updatelarini eng boshiga qoʻyaman.",
          ru: "Сегодня же разберу своё утро: пойму, что съедает первый час, и поставлю обновления ключевых клиентов в самое начало.",
          en: "Go through my own morning today: figure out what eats up the first hour and move the key customers’ updates to the very start.",
        } },
        { key: "updaters_q10_d", pattern: "blame", text: {
          uz: "Avval kechikkan updatelar aynan kimning yuklariga toʻgʻri kelganini koʻraman — sabab boshqa boʻlim maʼlumotni kech berishida boʻlsa, savolni oʻsha yerga qoʻyish kerak.",
          ru: "Сначала посмотрю, по чьим именно грузам были опоздания — если причина в том, что другой отдел поздно даёт данные, вопрос нужно ставить там.",
          en: "First look at exactly whose loads the late updates involved — if the cause is another department handing data over late, that is where the question should be put.",
        } },
        { key: "updaters_q10_e", pattern: "waiting", text: {
          uz: "Hajm oshganini rahbariyat ham koʻrib turibdi — jadval yoki shtat boʻyicha qaror chiqishini kutaman: har kim tartibni oʻzicha oʻzgartirsa, umumiy ishda chalkashlik boʻladi.",
          ru: "Руководство само видит рост объёма — дождусь решения по графику или штату: если каждый начнёт менять порядок по-своему, в общей работе будет путаница.",
          en: "Management can see the volume growth themselves — I will wait for a decision on the schedule or staffing: if everyone reshuffles the routine their own way, shared work turns chaotic.",
        } },
      ],
    },
  ],
};
