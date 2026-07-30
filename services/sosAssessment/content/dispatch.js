/**
 * SOS assessment content — Dispatch department (10 questions).
 *
 * Scope: late pickups and deliveries, unreachable drivers and unclear ETAs,
 * broker load changes/cancellations, HOS limits vs delivery windows, mid-route
 * equipment issues, driver misunderstandings of load instructions, shift
 * handoffs and team coverage, cross-department dependencies (trailer/yard),
 * preventing repeated communication failures.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - no option encourages unsafe driving, HOS violations, pressuring drivers,
 *    or hiding/false information toward brokers and customers.
 */

module.exports = {
  department: "dispatch",
  questions: [
    {
      key: "dispatch_q01",
      text: {
        uz: "Haydovchingiz qoʻngʻiroq qilmoqda: yoʻldagi avariya tufayli tirbandlikda qolgan va yuk olish apoyntmentiga kamida ikki soat kechikadi. Broker bu haqda hali bilmaydi. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Ваш водитель звонит: из-за аварии на дороге он стоит в пробке и опоздает на аппоинтмент погрузки минимум на два часа. Брокер об этом ещё не знает. Что вы, скорее всего, сделаете в первую очередь?",
        en: "Your driver calls: an accident has him stuck in traffic, and he will be at least two hours late for the pickup appointment. The broker does not know yet. What would you most likely do first?",
      },
      options: [
        { key: "dispatch_q01_a", pattern: "waiting", text: {
          uz: "Tirbandlik tarqalib ketishi ham mumkin — aniq necha soat kechikishi maʼlum boʻlmaguncha brokerga xabar bermayman: notoʻgʻri raqam aytib, keyin qayta tuzatishdan foyda yoʻq.",
          ru: "Пробка может и рассосаться — не буду сообщать брокеру, пока не станет ясно, на сколько именно он опоздает: назвать неверное время и потом переправлять нет смысла.",
          en: "The traffic may still clear — I will not message the broker until it is clear exactly how late he will be: giving a wrong time and correcting it later helps no one.",
        } },
        { key: "dispatch_q01_b", pattern: "victim", text: {
          uz: "Nega aynan mening reyslarimda doim shunday boʻladi, deb oʻylayman — avariya menga bogʻliq emas, lekin kechikkan pickup baribir mening koʻrsatkichimga yoziladi.",
          ru: "Подумаю: почему такое случается именно на моих рейсах — авария от меня не зависит, но опоздание на погрузку всё равно запишут на мой счёт.",
          en: "Wonder why this always happens on my loads in particular — the accident is not my doing, yet the late pickup will still be counted against me.",
        } },
        { key: "dispatch_q01_c", pattern: "builder", text: {
          uz: "Brokerga hoziroq halol yangi ETA beraman, shipperdan kechroq oyna soʻrayman va bundan keyin ertalabki pickuplar oldidan yoʻl holatini tekshirishni odat qilaman.",
          ru: "Сразу дам брокеру честное новое ETA, спрошу у шиппера более позднее окно и впредь возьму за правило проверять дорожную обстановку перед утренними погрузками.",
          en: "Give the broker an honest new ETA right away, ask the shipper about a later window, and from now on make it a habit to check road conditions before morning pickups.",
        } },
        { key: "dispatch_q01_d", pattern: "ownership", text: {
          uz: "Hoziroq brokerga qoʻngʻiroq qilib, vaziyatni va yangi taxminiy vaqtni ochiq aytaman, shipper kechroq qabul qila olishini aniqlayman va haydovchini yoʻl davomida xabardor qilib boraman.",
          ru: "Прямо сейчас позвоню брокеру, честно опишу ситуацию и новое ориентировочное время, уточню, примет ли шиппер позже, и буду держать водителя в курсе.",
          en: "Call the broker right now, lay out the situation and the new estimated time honestly, confirm whether the shipper can still receive him later, and keep the driver posted.",
        } },
        { key: "dispatch_q01_e", pattern: "complaint", text: {
          uz: "Jamoadagilarga bu yoʻnalishda apoyntmentlar juda tigʻiz qoʻyilishini aytaman — real transit vaqtini hech kim soʻramaydi, oqibatini esa dispetcher koʻtaradi.",
          ru: "Скажу коллегам, что аппоинтменты на этом направлении ставят слишком плотно — реальное время в пути никто не спрашивает, а расхлёбывает потом диспетчер.",
          en: "Tell my teammates that appointments on this lane are set way too tight — nobody asks about realistic transit time, and dispatch ends up dealing with the fallout.",
        } },
      ],
    },
    {
      key: "dispatch_q02",
      text: {
        uz: "Broker yuk boʻyicha aniq ETA ni zudlik bilan soʻramoqda, haydovchi esa bir soatdan beri qoʻngʻiroq va xabarlarga javob bermayapti. ELD boʻyicha truck harakatlanmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Брокер срочно запрашивает точное ETA по грузу, а водитель уже час не отвечает на звонки и сообщения. По ELD трак движется. Что вы сделаете в первую очередь?",
        en: "A broker urgently requests an exact ETA on a load, but the driver has not answered calls or messages for an hour. The ELD shows the truck moving. What would you do first?",
      },
      options: [
        { key: "dispatch_q02_a", pattern: "ownership", text: {
          uz: "ELD dagi joylashuvni oʻzim tekshirib, brokerga hozirgi real holat boʻyicha halol oraliq maʼlumot beraman va haydovchi toʻxtashi bilan aniq ETA ni tasdiqlab yuborishimni aytaman.",
          ru: "Сам проверю позицию по ELD, дам брокеру честную промежуточную информацию по фактическому местоположению и скажу, что подтвержу точное ETA, как только водитель остановится.",
          en: "Check the ELD position myself, give the broker an honest interim update based on the actual location, and say I will confirm the exact ETA as soon as the driver stops.",
        } },
        { key: "dispatch_q02_b", pattern: "complaint", text: {
          uz: "Ish kunimning yarmi javob bermaydigan haydovchilarni qidirishga ketayotganini yana his qilaman — oddiy update uchun ham har safar butun boshli qidiruv boshlanadi.",
          ru: "В который раз отмечу, что половина рабочего дня уходит на поиски не отвечающих водителей — ради обычного апдейта каждый раз целая спецоперация.",
          en: "Note once again that half my workday goes to chasing drivers who do not answer — even a routine update turns into a whole search operation every time.",
        } },
        { key: "dispatch_q02_c", pattern: "blame", text: {
          uz: "Avval bu haydovchiga aloqa qoidalarini kim tushuntirganini aniqlayman — onbordingda bu aniq aytilmagan boʻlsa, masalani oʻsha bosqichga masʼul xodimlar hal qilishi kerak.",
          ru: "Сначала выясню, кто объяснял этому водителю правила связи — если на онбординге это не проговорили, вопросом должны заняться те, кто отвечает за тот этап.",
          en: "First find out who explained the communication rules to this driver — if onboarding never covered them, the people who own that step should handle the issue.",
        } },
        { key: "dispatch_q02_d", pattern: "waiting", text: {
          uz: "Katta ehtimol u shunchaki rulda yoki aloqa yoʻq hududda — taxmin aytib xato qilmaslik uchun haydovchi oʻzi toʻxtab bogʻlanmaguncha brokerga javobni kechiktirib turaman.",
          ru: "Скорее всего, он просто за рулём или вне зоны связи — чтобы не передавать догадки, придержу ответ брокеру, пока водитель сам не выйдет на связь на остановке.",
          en: "Most likely he is simply driving or out of coverage — to avoid passing on guesses, I will hold the answer to the broker until the driver himself checks in at a stop.",
        } },
        { key: "dispatch_q02_e", pattern: "builder", text: {
          uz: "Brokerga GPS boʻyicha halol oraliq update yuboraman, haydovchini qidirishda davom etaman, u chiqqach esa keyingi reyslar uchun har toʻxtashda qisqa xabar berish tartibini kelishib olaman.",
          ru: "Отправлю брокеру честный промежуточный апдейт по GPS, продолжу искать водителя, а когда он выйдет на связь, договорюсь с ним о коротком сообщении на каждой остановке в следующих рейсах.",
          en: "Send the broker an honest GPS-based interim update, keep trying the driver, and once he surfaces, agree with him on a short message at every stop for future trips.",
        } },
      ],
    },
    {
      key: "dispatch_q03",
      text: {
        uz: "Ertalabki smenaga keldingiz: kechasi yuklangan reys boʻyicha hech qanday izoh yoʻq — yetkazish apoyntmenti tasdiqlanganmi, lumper masalasi hal boʻlganmi, nomaʼlum. Tungi dispetcher uyquga ketgan, broker esa tez orada qoʻngʻiroq qiladi. Birinchi navbatda nima qilasiz?",
        ru: "Вы пришли на утреннюю смену: по загруженному ночью рейсу нет ни одной заметки — неизвестно, подтверждён ли аппоинтмент на выгрузку и решён ли вопрос с лампером. Ночной диспетчер уже спит, а брокер скоро позвонит. Что вы сделаете в первую очередь?",
        en: "You start the morning shift and find a load picked up overnight with no notes at all — no confirmed delivery appointment, no word on the lumper. The night dispatcher is already asleep, and the broker will call soon. What would you do first?",
      },
      options: [
        { key: "dispatch_q03_a", pattern: "blame", text: {
          uz: "Avval tungi smena izoh qoldirmaganini rahbarga qayd qilib qoʻyaman — bu kimning kamchiligi ekani hozir belgilanmasa, keyin hammasi mening xatoyimdek koʻrinadi.",
          ru: "Сначала зафиксирую для руководителя, что ночная смена не оставила заметок — если сейчас не обозначить, чьё это упущение, потом всё будет выглядеть моей ошибкой.",
          en: "First put on record for the lead that the night shift left no notes — if it is not made clear now whose gap this is, it will later look like my mistake.",
        } },
        { key: "dispatch_q03_b", pattern: "builder", text: {
          uz: "Rate con va ELD dan holatni oʻzim tiklayman, apoyntmentni tasdiqlayman, soʻng smenalar orasida qisqa yozma topshirish shablonini taklif qilaman — kontekst boshqa yoʻqolmasligi uchun.",
          ru: "Сам восстановлю картину по рейт-кону и ELD, подтвержу аппоинтмент, а затем предложу короткий письменный шаблон передачи смены — чтобы контекст больше не терялся.",
          en: "Rebuild the picture from the rate con and ELD myself, confirm the appointment, and then propose a short written shift-handoff template so context stops getting lost.",
        } },
        { key: "dispatch_q03_c", pattern: "waiting", text: {
          uz: "Tungi dispetcherga xabar yozib qoʻyaman va u uygʻonguncha kutaman — tafsilotlar unda, chala maʼlumot bilan ish qilsam, vaziyatni yanada chalkashtirib yuborishim mumkin.",
          ru: "Напишу ночному диспетчеру и подожду, пока он проснётся — детали у него, а действия с неполной информацией могут только сильнее всё запутать.",
          en: "Message the night dispatcher and wait until he wakes up — he holds the details, and acting on incomplete information could tangle things up even more.",
        } },
        { key: "dispatch_q03_d", pattern: "victim", text: {
          uz: "Tungi smenaning chala ishlari nega doim ertalabkilarga qolishidan charchadim — har kunim oʻz reyslarim oʻrniga birovning ortidan tozalashdan boshlanadi.",
          ru: "Опять недоделки ночной смены достались утренним — каждый мой день начинается не с собственных рейсов, а с разгребания чужого.",
          en: "The night shift's loose ends land on the morning crew yet again — my every day starts with cleaning up after someone instead of running my own loads.",
        } },
        { key: "dispatch_q03_e", pattern: "ownership", text: {
          uz: "Rate con ni ochib, haydovchiga qoʻngʻiroq qilaman va yetishmayotgan tafsilotlarni oʻzim aniqlab, broker qoʻngʻirogʻidan oldin yetkazish apoyntmentini tasdiqlab qoʻyaman.",
          ru: "Открою рейт-кон, позвоню водителю, сам соберу недостающие детали и подтвержу аппоинтмент на выгрузку до звонка брокера.",
          en: "Open the rate con, call the driver, fill in the missing details myself, and confirm the delivery appointment before the broker calls.",
        } },
      ],
    },
    {
      key: "dispatch_q04",
      text: {
        uz: "Haydovchi shipperga 40 daqiqa qolganda broker yuk bekor qilinganini yozdi. Haydovchi bu pickup uchun ancha masofani boʻsh yurib kelgan va buni eshitib xafa boʻlishi aniq. Birinchi navbatda nima qilasiz?",
        ru: "Когда водителю оставалось 40 минут до шиппера, брокер написал, что груз отменён. Водитель прошёл ради этой погрузки приличный порожний перегон и явно расстроится. Что вы сделаете в первую очередь?",
        en: "With the driver 40 minutes from the shipper, the broker writes that the load is cancelled. The driver deadheaded a long way for this pickup and will clearly be upset. What would you do first?",
      },
      options: [
        { key: "dispatch_q04_a", pattern: "complaint", text: {
          uz: "Jamoaga bu broker yana bekor qilganini aytaman — ular uchun bu shunchaki xat, biz esa har safar yoqilgʻi va vaqtni bekorga sarflaymiz.",
          ru: "Скажу команде, что этот брокер снова отменил — для них это просто письмо, а мы каждый раз впустую жжём топливо и время.",
          en: "Tell the team this broker has cancelled on us yet again — for them it is just an email, while we burn fuel and hours for nothing every time.",
        } },
        { key: "dispatch_q04_b", pattern: "ownership", text: {
          uz: "Darhol haydovchiga qoʻngʻiroq qilib, vaziyatni toʻgʻridan-toʻgʻri aytaman va uning hozirgi nuqtasidan yangi yuk qidirishni shu zahoti boshlayman — kun boʻsh ketmasligi kerak.",
          ru: "Сразу позвоню водителю, скажу всё как есть и тут же начну искать новый груз от его текущей точки — день не должен пропасть.",
          en: "Call the driver immediately, tell him straight what happened, and start searching for a new load from his current position right away — the day should not go to waste.",
        } },
        { key: "dispatch_q04_c", pattern: "victim", text: {
          uz: "Bunday bekor qilishlar negadir doim mening boardimga toʻgʻri keladi — boshqalarning qarori uchun oxirida mening haydovchim va mening raqamlarim jabr koʻradi.",
          ru: "Такие отмены почему-то всегда приходятся на мой борд — за чужие решения в итоге страдают мой водитель и мои показатели.",
          en: "Somehow these cancellations always land on my board — in the end my driver and my numbers take the hit for decisions made by others.",
        } },
        { key: "dispatch_q04_d", pattern: "builder", text: {
          uz: "Haydovchiga ochiq aytib, yaqin atrofdan reload qidiraman va rate con shartlariga koʻra brokerdan TONU (bekor qilish toʻlovi) soʻrab, yozishmani hujjatlashtirib qoʻyaman.",
          ru: "Честно сообщу водителю, начну искать релоад поблизости и по условиям рейт-кона запрошу у брокера TONU (компенсацию за отмену), сохранив всю переписку.",
          en: "Tell the driver honestly, start hunting a reload nearby, and per the rate con request TONU (a cancellation fee) from the broker, keeping the correspondence documented.",
        } },
        { key: "dispatch_q04_e", pattern: "blame", text: {
          uz: "Avval bekor qilish xabari oldinroq kelgan-kelmaganini tekshiraman — u kimningdir pochtasida oʻqilmay yotgan boʻlsa, haydovchiga tushuntirishdan oldin buni kim oʻtkazib yuborgani aniq boʻlishi kerak.",
          ru: "Сначала проверю, не приходило ли уведомление об отмене раньше — если оно лежало непрочитанным в чьей-то почте, до разговора с водителем должно быть ясно, кто его пропустил.",
          en: "First check whether the cancellation notice arrived earlier — if it sat unread in someone's inbox, it should be clear who missed it before I explain things to the driver.",
        } },
      ],
    },
    {
      key: "dispatch_q05",
      text: {
        uz: "Reysni hisoblab koʻrdingiz: haydovchining qolgan soatlari (HOS) yetkazish apoyntmentiga ulgurishga imkon bermaydi — qonuniy yoʻl bilan u kamida uch soat kech yetib boradi. Birinchi navbatda nima qilasiz?",
        ru: "Просчитав рейс, вы видите: оставшихся часов водителя (HOS) не хватает, чтобы успеть к аппоинтменту на выгрузку — легально он приедет минимум на три часа позже. Что вы сделаете в первую очередь?",
        en: "Running the numbers on a trip, you see the driver's remaining hours (HOS) will not get him to the delivery appointment — legally he arrives at least three hours late. What would you do first?",
      },
      options: [
        { key: "dispatch_q05_a", pattern: "builder", text: {
          uz: "Brokerga bugunoq halol hisob-kitob bilan chiqib, apoyntmentni surishni kelishaman, soʻngra yuk qabul qilinishidan oldin soatlarni tekshirish qadamini jarayonga kiritishni taklif qilaman.",
          ru: "Сегодня же выйду на брокера с честным расчётом и согласую перенос аппоинтмента, а затем предложу добавить в процесс проверку часов до принятия груза.",
          en: "Go to the broker today with the honest math and agree on moving the appointment, then propose adding an hours check before any load is accepted to our process.",
        } },
        { key: "dispatch_q05_b", pattern: "waiting", text: {
          uz: "Soatlar hali oʻzgarishi mumkin — dam olish qanday tushishiga qarab manzara ertaga aniqroq boʻladi; brokerga xom raqam aytmasdan, aniq hisob chiqquncha kutaman.",
          ru: "Часы ещё могут измениться — в зависимости от того, как ляжет отдых, завтра картина будет точнее; не буду называть брокеру сырые цифры и дождусь точного расчёта.",
          en: "The hours may still shift — depending on how his rest falls, tomorrow's picture will be clearer; rather than give the broker rough numbers, I will wait for the exact math.",
        } },
        { key: "dispatch_q05_c", pattern: "complaint", text: {
          uz: "Yukni band qilishda haydovchining soatlari bilan hech kim qiziqmasligini yana bir bor taʼkidlayman — jadval qogʻozda chiroyli, amalda esa dispetcher ilojsiz ahvolda qoladi.",
          ru: "В очередной раз скажу, что при бронировании груза часами водителя никто не интересуется — на бумаге график красивый, а в реальности диспетчер остаётся в безвыходном положении.",
          en: "Point out once more that whoever books the loads never asks about the driver's hours — the schedule looks fine on paper, and in real life dispatch is left with no way out.",
        } },
        { key: "dispatch_q05_d", pattern: "ownership", text: {
          uz: "Avval hisobni haydovchi bilan birga qayta tekshiraman, soʻng brokerga bugunoq qoʻngʻiroq qilib, real yetib borish vaqtini ochiq aytaman va yangi oynani soʻrayman.",
          ru: "Сначала перепроверю расчёт вместе с водителем, затем сегодня же позвоню брокеру, открыто назову реальное время прибытия и попрошу новое окно.",
          en: "Recheck the math together with the driver first, then call the broker today, state the realistic arrival time openly, and ask for a new window.",
        } },
        { key: "dispatch_q05_e", pattern: "victim", text: {
          uz: "Yana jismonan ulgurib boʻlmaydigan reys menga tushdi, deb oʻylayman — kechikish mening statistikamga yoziladi, uni shunday band qilganlar esa hech narsa yoʻqotmaydi.",
          ru: "Подумаю: мне опять достался физически невыполнимый рейс — опоздание запишут в мою статистику, а те, кто его так забронировал, ничего не теряют.",
          en: "Think that once again I got a physically impossible trip — the late delivery goes into my stats, while those who booked it this way lose nothing.",
        } },
      ],
    },
    {
      key: "dispatch_q06",
      text: {
        uz: "Haydovchi yoʻldan qoʻngʻiroq qilmoqda: treyler gʻildiragi yorilib ketdi, u xavfsiz joyga toʻxtagan. Yetkazish oynasigacha vaqt kam, taʼmirlash qancha choʻzilishi hali nomaʼlum. Birinchi navbatda nima qilasiz?",
        ru: "Водитель звонит с дороги: на трейлере лопнула шина, он безопасно остановился. До окна выгрузки времени мало, сколько займёт ремонт — пока неизвестно. Что вы сделаете в первую очередь?",
        en: "A driver calls from the road: a trailer tire blew out and he has pulled over safely. The delivery window is close, and how long the repair will take is still unknown. What would you do first?",
      },
      options: [
        { key: "dispatch_q06_a", pattern: "victim", text: {
          uz: "Eng eski treylerlar negadir doim mening haydovchilarimga tushadi — har bir buzilish oxirida mening kechikkan yukim va mening jahli chiqqan brokerimga aylanadi.",
          ru: "Самые старые трейлеры почему-то всегда достаются моим водителям — каждая поломка в итоге превращается в мой опоздавший груз и моего злого брокера.",
          en: "Somehow the oldest trailers always end up with my drivers — every breakdown eventually turns into my late load and my angry broker.",
        } },
        { key: "dispatch_q06_b", pattern: "blame", text: {
          uz: "Avval bu treyler oxirgi marta qachon koʻrikdan oʻtganini va uni yarddan kim chiqarganini aniqlayman — texnik nosozlik uchun javobgarlik shop zimmasida boʻlishi kerak.",
          ru: "Сначала выясню, когда этот трейлер последний раз проходил осмотр и кто выпустил его со двора — ответственность за техническую неисправность должна лежать на шопе.",
          en: "First establish when this trailer last passed inspection and who released it from the yard — responsibility for a mechanical failure should sit with the shop.",
        } },
        { key: "dispatch_q06_c", pattern: "waiting", text: {
          uz: "Haydovchi road service chaqirsin — usta yetib kelib, taʼmir muddatini aytmaguncha hech kimni bezovta qilmayman: aniq vaqt boʻlmasa, brokerga qoʻngʻiroqdan maʼno kam.",
          ru: "Пусть водитель вызовет road service — пока мастер не приедет и не назовёт срок ремонта, никого дёргать не буду: без точного времени звонок брокеру бессмыслен.",
          en: "Have the driver call road service — until the mechanic arrives and names a repair time, I will not stir anyone up: calling the broker without exact timing has little point.",
        } },
        { key: "dispatch_q06_d", pattern: "builder", text: {
          uz: "Road service ni tezda joʻnataman, brokerga taxminiy muddat bilan halol ogohlantirish beraman va reysdan soʻng bu treylerni tekshiruvga yozdirib, holatini shopga maʼlum qilaman.",
          ru: "Быстро организую road service, честно предупрежу брокера с ориентировочным сроком и после рейса запишу этот трейлер на проверку, сообщив о его состоянии в шоп.",
          en: "Get road service moving fast, give the broker an honest heads-up with a rough timeline, and after the trip book this trailer for a checkup, flagging its condition to the shop.",
        } },
        { key: "dispatch_q06_e", pattern: "ownership", text: {
          uz: "Haydovchi uchun road service ni darhol oʻzim chaqiraman va brokerga yetkazish surilishi mumkinligini hoziroq halol aytaman — taʼmir vaqti aniqlashishi bilan yangilab boraman.",
          ru: "Сразу сам вызову водителю road service и уже сейчас честно скажу брокеру, что выгрузка может сдвинуться, — как только станет ясен срок ремонта, буду обновлять информацию.",
          en: "Arrange road service for the driver myself right away and tell the broker honestly now that delivery may slip — then keep him updated as soon as the repair time is clear.",
        } },
      ],
    },
    {
      key: "dispatch_q07",
      text: {
        uz: "Haydovchi biriktirilgan treylerni olish uchun yardga keldi, lekin treyler hali shopda — taʼmiri tugamagan, garchi tizimda tayyor deb koʻrsatilgan boʻlsa ham. Pickupgacha uch soat qoldi. Birinchi navbatda nima qilasiz?",
        ru: "Водитель приехал на ярд за закреплённым трейлером, но трейлер ещё в шопе — ремонт не закончен, хотя в системе стоит статус «готов». До погрузки три часа. Что вы сделаете в первую очередь?",
        en: "A driver arrives at the yard for his assigned trailer, but it is still in the shop — the repair is unfinished, even though the system shows it as ready. Pickup is three hours away. What would you do first?",
      },
      options: [
        { key: "dispatch_q07_a", pattern: "ownership", text: {
          uz: "Treyler boʻlimi bilan hoziroq boshqa boʻsh treyler qidiraman; mos varianti topilmasa, brokerni oldindan ogohlantirib, halol yangi pickup vaqtini kelishaman.",
          ru: "Сразу вместе с трейлерным отделом поищу другой свободный трейлер; если подходящего не найдётся, заранее предупрежу брокера и честно согласую новое время погрузки.",
          en: "Search for another available trailer with the Trailer Department right now; if nothing suitable turns up, warn the broker early and honestly agree on a new pickup time.",
        } },
        { key: "dispatch_q07_b", pattern: "complaint", text: {
          uz: "Hamkasblarga treyler statuslariga ishonib boʻlmasligini aytib beraman — tizimdagi maʼlumotning yarmi eskirgan, dispetcher esa buni doim eng nozik daqiqada bilib oladi.",
          ru: "Поделюсь с командой наболевшим: статусам трейлеров верить нельзя — половина данных в системе устарела, а диспетчер узнаёт об этом всегда в самый неподходящий момент.",
          en: "Tell my coworkers the trailer statuses cannot be trusted — half the data in the system is stale, and dispatch always finds out at the worst possible moment.",
        } },
        { key: "dispatch_q07_c", pattern: "builder", text: {
          uz: "Bugun masalani almashtirish yoki halol qayta kelishuv bilan yopaman, soʻng treyler boʻlimiga tayyor statusi faqat shop tasdigʻidan keyin qoʻyilishini taklif qilaman.",
          ru: "Сегодня закрою вопрос заменой или честным переносом, а затем предложу трейлерному отделу правило: статус «готов» ставится только после подтверждения шопа.",
          en: "Close today with a substitute trailer or an honest reschedule, then propose to the Trailer Department that the ready status be set only after the shop confirms it.",
        } },
        { key: "dispatch_q07_d", pattern: "blame", text: {
          uz: "Avval notoʻgʻri statusni kim qoʻyganini yozma tasdiqlatib olaman — kechikish sababi treyler boʻlimida ekani hujjatda qolsin, keyin bu dispetcher xatosi sanalmasin.",
          ru: "Сначала письменно зафиксирую, кто поставил неверный статус — причина задержки в трейлерном отделе, и это должно остаться в документах, чтобы потом не считали ошибкой диспетчера.",
          en: "First get it confirmed in writing who set the wrong status — the delay originates in the Trailer Department, and that should be on record so it is not counted as a dispatch error.",
        } },
        { key: "dispatch_q07_e", pattern: "waiting", text: {
          uz: "Shopdan taʼmir qancha davom etishini soʻrayman va ular aniq chiqish vaqtini aytmaguncha boshqa qadamlarni toʻxtatib turaman — aniqliksiz qilingan qaror vaziyatni ogʻirlashtirishi mumkin.",
          ru: "Спрошу у шопа, сколько продлится ремонт, и придержу остальные шаги, пока они не назовут точное время выхода — решение без ясности может только усложнить ситуацию.",
          en: "Ask the shop how long the repair will run and hold the other steps until they name an exact release time — a decision made without clarity could make things worse.",
        } },
      ],
    },
    {
      key: "dispatch_q08",
      text: {
        uz: "Haydovchi qabul qiluvchining hovlisidan jahl bilan qoʻngʻiroq qilmoqda: u toʻrt soat navbatda turgan, chunki check-in tartibi va apoyntment raqamini bilmagan. Uning aytishicha, unga hech kim tushuntirmagan — vaholanki koʻrsatmalar yuborilgan edi. Birinchi navbatda nima qilasiz?",
        ru: "Водитель злится и звонит со двора грузополучателя: он простоял четыре часа, потому что не знал порядок check-in и номер аппоинтмента. По его словам, ему никто ничего не объяснил — хотя инструкции отправлялись. Что вы сделаете в первую очередь?",
        en: "A driver calls angrily from the receiver's yard: he waited four hours because he did not know the check-in procedure or the appointment number. He says nobody explained anything — although the instructions were sent. What would you do first?",
      },
      options: [
        { key: "dispatch_q08_a", pattern: "waiting", text: {
          uz: "Hozir u qizishib turibdi — bahslashish faqat yomonlashtiradi. Yuk topshirilib, u tinchlangach, hammasini xotirjam muhokama qilamiz; masala shoshilinch yechim talab qilmaydi.",
          ru: "Сейчас он на взводе — спор только всё усугубит. Обсудим спокойно, когда груз будет сдан и он остынет; вопрос не требует немедленного решения.",
          en: "He is worked up right now — arguing will only make it worse. We will talk it through calmly once the load is delivered and he cools down; this does not need an instant fix.",
        } },
        { key: "dispatch_q08_b", pattern: "builder", text: {
          uz: "Uni tinchlantirib, check-in maʼlumotlarini qayta yuboraman, aniq vaqtlar bilan detention soʻrovini rasmiylashtiraman va muhim koʻrsatmalarga haydovchidan qisqa tasdiq javobini soʻrashni yoʻlga qoʻyaman.",
          ru: "Успокою его, заново отправлю данные по check-in, оформлю запрос detention с точным временем и начну просить у водителей короткое подтверждение на важные инструкции.",
          en: "Calm him down, resend the check-in details, file a detention request with the exact times, and start asking drivers for a short confirming reply to key instructions.",
        } },
        { key: "dispatch_q08_c", pattern: "victim", text: {
          uz: "Har bir haydovchiga koʻrsatmalarni oʻz vaqtida yuboraman, lekin ular oʻqilmasa ham, oxirida barcha norozilik baribir dispetcherga yogʻiladi — bu juda charchatadi.",
          ru: "Я вовремя отправляю инструкции каждому водителю, но даже когда их не читают, всё недовольство в итоге всё равно выливается на диспетчера — это выматывает.",
          en: "I send instructions to every driver on time, yet even when they go unread, all the frustration still pours down on dispatch in the end — it is exhausting.",
        } },
        { key: "dispatch_q08_d", pattern: "ownership", text: {
          uz: "Bahslashmasdan tinglayman, check-in qadamlarini shu zahoti qayta yuboraman va kirish-chiqish vaqtlarini olib, bugunoq brokerga detention soʻrovini joʻnataman.",
          ru: "Выслушаю не споря, тут же заново отправлю шаги check-in, возьму время въезда и выезда и сегодня же отправлю брокеру запрос на detention.",
          en: "Listen without arguing, resend the check-in steps right away, take down the in and out times, and send the broker a detention request today.",
        } },
        { key: "dispatch_q08_e", pattern: "blame", text: {
          uz: "Avval yozishmalar tarixini ochib, koʻrsatmalar qachon va kimga yuborilganini aniqlayman — xato haydovchi tomonida ekani hujjat bilan koʻrinib tursa, gaplashish oson boʻladi.",
          ru: "Сначала открою историю переписки и уточню, когда и кому отправлялись инструкции — пусть по документам будет видно, что упущение на стороне водителя, тогда разговор будет проще.",
          en: "First open the message history and pin down when and to whom the instructions were sent — once the record shows the miss is on the driver's side, the conversation gets easier.",
        } },
      ],
    },
    {
      key: "dispatch_q09",
      text: {
        uz: "Hamkasbingiz bugun kasal boʻlib, ishga chiqmadi. Uning haydovchisi sizga qoʻngʻiroq qilmoqda: shipperda turibdi va yuklash boʻyicha zudlik bilan javob kerak, lekin bu reys sizning boardingizda emas va tarixini bilmaysiz. Birinchi navbatda nima qilasiz?",
        ru: "Ваш коллега сегодня заболел и не вышел. Его водитель звонит вам: он стоит у шиппера, и ему срочно нужен ответ по загрузке, но этот рейс не на вашем борде, и его истории вы не знаете. Что вы сделаете в первую очередь?",
        en: "Your teammate called in sick today. His driver phones you: he is at the shipper and urgently needs an answer about the loading, but the trip is not on your board and you do not know its history. What would you do first?",
      },
      options: [
        { key: "dispatch_q09_a", pattern: "complaint", text: {
          uz: "Kimdir kasal boʻlsa, doim shu ahvol boshlanishini taʼkidlayman — hech kim boshqaning boardini bilmaydi, oxirida esa haydovchilar oʻrtada qolib ketadi.",
          ru: "Замечу, что стоит кому-то заболеть — начинается одно и то же: чужой борд никто не знает, а крайними в итоге остаются водители.",
          en: "Remark that the same thing starts every time someone is out sick — nobody knows anyone else's board, and in the end the drivers are the ones left hanging.",
        } },
        { key: "dispatch_q09_b", pattern: "ownership", text: {
          uz: "Reysni tizimdan oʻzim ochib, rate con boʻyicha haydovchiga hoziroq javob beraman va nima deganimni hamkasbimga yozib qoldiraman — u chiqqanda hammasi aniq boʻlsin.",
          ru: "Сам открою рейс в системе, отвечу водителю прямо сейчас по рейт-кону и напишу коллеге, что именно я ему сказал, — чтобы по выходе у него была полная картина.",
          en: "Open the trip in the system myself, answer the driver right now based on the rate con, and leave my teammate a note on exactly what I told him — so he returns to a full picture.",
        } },
        { key: "dispatch_q09_c", pattern: "waiting", text: {
          uz: "Reys tarixini bilmay koʻrsatma bersam, hamkasbimning kelishuvlariga zid chiqishi mumkin — haydovchidan biroz kutishini soʻrab, bu boardga masʼul qilib belgilangan odamni aniqlayman.",
          ru: "Если дам указание, не зная истории рейса, оно может пойти вразрез с договорённостями коллеги — попрошу водителя немного подождать и уточню, кого назначили ответственным за этот борд.",
          en: "If I give directions without knowing the trip's history, I may contradict what my teammate arranged — I will ask the driver to hold on and find out who was assigned to cover that board.",
        } },
        { key: "dispatch_q09_d", pattern: "builder", text: {
          uz: "Tizim boʻyicha hoziroq javob beraman, hamkasbga izoh qoldiraman va shu voqeadan soʻng har bir reys izohlari umumiy tizimda yuritilishini taklif qilaman — istalgan dispetcher oʻrnini bosa olishi uchun.",
          ru: "Отвечу прямо сейчас по системе, оставлю коллеге заметку, а после этого случая предложу вести заметки по каждому рейсу в общей системе — чтобы любой диспетчер мог подменить.",
          en: "Answer right now from the system, leave a note for my teammate, and after this propose keeping notes on every trip in the shared system — so any dispatcher can step in.",
        } },
        { key: "dispatch_q09_e", pattern: "victim", text: {
          uz: "Boshqalarning haydovchilari negadir doim aynan meni topadi — oʻz boardim oʻzimga yetarli, bunday kunlarda esa ikki kishining ishini bitta oʻzim tortaman.",
          ru: "Чужие водители почему-то всегда находят именно меня — своего борда хватает с головой, а в такие дни я один тяну работу за двоих.",
          en: "Other people's drivers somehow always find me of all people — my own board is plenty, and on days like this I end up pulling two jobs alone.",
        } },
      ],
    },
    {
      key: "dispatch_q10",
      text: {
        uz: "Yirik broker rahbariyatga shikoyat qildi: uchinchi hafta ketma-ket uning yuklari boʻyicha updatelar kech kelmoqda yoki umuman kelmayapti. Bu reyslarni jamoadagi turli dispetcherlar yuritgan. Rahbar masalani jamoa oldiga qoʻydi. Birinchi navbatda nima qilasiz?",
        ru: "Крупный брокер пожаловался руководству: третью неделю подряд апдейты по его грузам приходят с опозданием или не приходят вовсе. Эти рейсы вели разные диспетчеры команды. Руководитель вынес вопрос на команду. Что вы сделаете в первую очередь?",
        en: "A major broker complained to management: for the third week in a row, updates on his loads arrive late or not at all. Different dispatchers on the team handled those trips. The manager has put the issue to the team. What would you do first?",
      },
      options: [
        { key: "dispatch_q10_a", pattern: "builder", text: {
          uz: "Shu brokerning yuklari uchun oddiy umumiy update jadvalini taklif qilaman va birinchi loyihasini bugunoq oʻz reyslarimda sinab, jamoaga koʻrsataman.",
          ru: "Предложу простой общий график апдейтов по грузам этого брокера и первый вариант сегодня же обкатаю на своих рейсах, показав команде.",
          en: "Propose a simple shared update schedule for this broker's loads and pilot the first draft on my own trips today to show the team.",
        } },
        { key: "dispatch_q10_b", pattern: "blame", text: {
          uz: "Avval loglardan aynan qaysi reyslarda va kimning navbatchiligida updatelar oʻtkazib yuborilganini aniqlayman — butun jamoa tanqid qilinishidan oldin manzara aniq boʻlishi kerak.",
          ru: "Сначала по логам определю, на каких именно рейсах и в чью смену были пропущены апдейты — прежде чем критиковать всю команду, картина должна быть точной.",
          en: "First go through the logs to identify exactly which trips and whose shifts missed the updates — the picture should be accurate before the whole team takes the criticism.",
        } },
        { key: "dispatch_q10_c", pattern: "complaint", text: {
          uz: "Har birimizda oʻnlab trucklar borligini eslataman — bu broker esa deyarli har soatda update kutadi; bunday hajmda kechikishlarsiz ishlash amalda juda qiyin.",
          ru: "Напомню, что у каждого из нас десятки траков, а этот брокер ждёт апдейт чуть ли не каждый час — работать без опозданий при таких объёмах на практике очень трудно.",
          en: "Point out that each of us runs dozens of trucks while this broker expects an update almost every hour — working without slips at that volume is very hard in practice.",
        } },
        { key: "dispatch_q10_d", pattern: "victim", text: {
          uz: "Oʻz updatelarimni doim vaqtida yuboraman, lekin shikoyat butun jamoaga qaratilgani uchun endi men ham aybdorlar qatoridaman — puxta ishlaganim hisobga olinmaydi.",
          ru: "Свои апдейты я всегда отправляю вовремя, но жалоба адресована всей команде, и теперь я в том же списке виноватых — моя аккуратная работа в расчёт не берётся.",
          en: "I always send my updates on time, but the complaint names the whole team, so now I am on the same list of culprits — my careful work counts for nothing.",
        } },
        { key: "dispatch_q10_e", pattern: "ownership", text: {
          uz: "Bugunoq shu broker boʻyicha oʻz reyslarimni koʻrib chiqaman, har bir update vaqtiga eslatma qoʻyaman va bugungi updatelarni kutilgan muddatdan oldinroq joʻnataman.",
          ru: "Сегодня же пройдусь по своим рейсам этого брокера, поставлю напоминание на каждое время апдейта и сегодняшние апдейты отправлю раньше ожидаемого срока.",
          en: "Go through my own trips for this broker today, set a reminder for each update time, and send today's updates ahead of when they are expected.",
        } },
      ],
    },
  ],
};
