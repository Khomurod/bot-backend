/**
 * SOS assessment content — Dispatch department (10 questions).
 *
 * Scope: broker communication and ETAs, appointments and rate cons, driver
 * contact gaps, HOS-constrained planning, breakdowns on the road, trailer
 * availability, detention and TONU claims, shift handoffs, covering a
 * teammate's board, recurring update complaints.
 *
 * Authoring rules: see the header of ./hr.js — all five options must read as
 * competent and choosable, the six tendencies are loci of first action rather
 * than keyword formulas. Hard constraints for this department: no option may
 * invent an ETA or a location, misinform a broker or a driver, plan a trip that
 * cannot be run legally on the driver's remaining hours, or skip a documented
 * claim. A less accountable instinct shows up as a different FIRST MOVE, never
 * as dishonest or illegal dispatching.
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
          uz: "Tirbandlik tarqashi mumkin — qancha kechikishi aniq boʻlmaguncha brokerga vaqt aytmayman: avval bir son, keyin boshqasini aytish ishonchni buzadi.",
          ru: "Пробка может рассосаться — не назову брокеру время, пока не станет ясно, на сколько он опаздывает: сначала одна цифра, потом другая — это и подрывает доверие.",
          en: "The traffic may still clear — I would not give the broker a time until the delay is clear: one figure now and another later is what breaks trust.",
        } },
        { key: "dispatch_q01_b", pattern: "victim", text: {
          uz: "Rahbarga bugunoq aytib qoʻyaman: kechikish yoʻldagi avariya sababli boʻlgan — kechikkan pickup mening koʻrsatkichimda qolsa, buni albatta ajratib koʻrish kerak.",
          ru: "Сегодня же скажу руководителю, что опоздание вызвано аварией на дороге: если опоздавшая погрузка останется на моих показателях, это обязательно надо разделять.",
          en: "I would tell my lead today that the delay comes from a road accident: if the late pickup lands on my numbers, that has to be separated from my own work.",
        } },
        { key: "dispatch_q01_c", pattern: "builder", text: {
          uz: "Brokerga rost yangi ETA beraman va ertalabki pickuplardan oldin yoʻl holatini tekshirishni doimiy qadam qilaman — bu safar emas, keyingi safar vaqt qozonadi.",
          ru: "Дам брокеру честное новое ETA и сделаю постоянным шагом проверку обстановки на дороге перед утренними погрузками: время это выиграет не сейчас, а в следующий раз.",
          en: "I would give the broker an honest new ETA and make a road-conditions check before morning pickups a standing step — it buys time next time, not this one.",
        } },
        { key: "dispatch_q01_d", pattern: "ownership", text: {
          uz: "Hoziroq brokerga qoʻngʻiroq qilib holatni va taxminiy yangi vaqtni rost aytaman, shipper keyinroq qabul qila oladimi aniqlayman va haydovchini xabardor qilib boraman.",
          ru: "Прямо сейчас позвоню брокеру, честно назову ситуацию и примерное новое время, выясню, примет ли шиппер позже, и буду держать водителя в курсе.",
          en: "I would call the broker right now, give the situation and an honest estimated new time, check whether the shipper can still take him later, and keep the driver posted.",
        } },
        { key: "dispatch_q01_e", pattern: "complaint", text: {
          uz: "Brokerni ogohlantiraman, lekin jamoada aytaman: bu yoʻnalishda apoyntmentlar juda tigʻiz qoʻyiladi — real transit vaqti hisobga olinmasa, bu har hafta qaytadi.",
          ru: "Брокера предупрежу, но в команде скажу: на этом направлении аппоинтменты ставят слишком плотно — пока не учитывают реальное транзитное время, это будет каждую неделю.",
          en: "I would warn the broker, but say in the team that appointments on this lane are set far too tight — with real transit time ignored, this comes back weekly.",
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
          uz: "ELD boʻyicha joylashuvni oʻzim tekshirib, brokerga real joylashuvga asoslangan oraliq javob beraman va haydovchi toʻxtagach aniq ETA ni tasdiqlashimni aytaman.",
          ru: "Сам проверю позицию по ELD, дам брокеру промежуточный ответ на основе реального местоположения и скажу, что точное ETA подтвержу, как только водитель остановится.",
          en: "I would check the ELD position myself, give the broker an interim answer from the real location, and say I will confirm the exact ETA once the driver stops.",
        } },
        { key: "dispatch_q02_b", pattern: "complaint", text: {
          uz: "Oraliq javobni oʻzim beraman, lekin rahbarga hoziroq aytaman: ish kunimning yarmi javob bermaydigan haydovchini qidirishga ketadi.",
          ru: "Промежуточный ответ дам сам, но прямо сейчас скажу руководителю: полдня уходит на поиск водителя, который не отвечает.",
          en: "I would give the interim answer myself, but tell my lead right now that half my day goes into chasing a driver who does not answer.",
        } },
        { key: "dispatch_q02_c", pattern: "blame", text: {
          uz: "Bu haydovchiga aloqa qoidalarini kim tushuntirganini koʻraman — onbordingda oʻtilmagan boʻlsa, tuzatish oʻsha bosqichda, har kunlik qidiruvda emas.",
          ru: "Посмотрю, кто объяснял этому водителю правила связи: если на онбординге это не прошли, исправлять надо там, а не ежедневным поиском.",
          en: "I would look at who explained the contact rules to this driver — if onboarding skipped them, the fix belongs at that step, not in a daily search.",
        } },
        { key: "dispatch_q02_d", pattern: "waiting", text: {
          uz: "Brokerga hozir aniq ETA yoʻqligini ochiq aytaman va haydovchi toʻxtab bogʻlangach beraman — taxminiy son keyin tuzatilsa, ishonch koʻproq yoʻqoladi.",
          ru: "Открыто скажу брокеру, что точного ETA сейчас нет, и дам его, когда водитель остановится и выйдет на связь: догадка, которую потом правят, стоит дороже.",
          en: "I would tell the broker openly there is no exact ETA yet and give it once the driver stops and checks in — a guess corrected later costs more trust.",
        } },
        { key: "dispatch_q02_e", pattern: "builder", text: {
          uz: "Brokerga GPS asosidagi oraliq maʼlumot yuboraman, haydovchini izlashda davom etaman va bogʻlangach, keyingi reyslarda har toʻxtashda qisqa xabar berishni kelishaman.",
          ru: "Отправлю брокеру промежуточные данные по GPS, продолжу искать водителя, а когда он выйдет на связь, договорюсь с ним о коротком сообщении на каждой остановке.",
          en: "I would send the broker a GPS-based interim update, keep trying the driver, and once he surfaces agree a short message at every stop for future trips.",
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
          uz: "Tungi smena izoh qoldirmaganini rahbarga hoziroq aniq koʻrsataman — uzilishni hozir belgilamasak, ertaga ham xuddi shunday smena topshiriladi.",
          ru: "Прямо сейчас ясно покажу руководителю, что ночная смена не оставила заметок: не обозначим разрыв — смену так же передадут и завтра.",
          en: "I would show my lead right now that the night shift left no notes — unless the break is marked, the shift is handed over the same way tomorrow.",
        } },
        { key: "dispatch_q03_b", pattern: "builder", text: {
          uz: "Rate con va ELD dan manzarani oʻzim tiklayman, apoyntmentni tasdiqlaman, keyin qisqa yozma smena topshirish shablonini yoʻlga qoʻyaman.",
          ru: "Сам восстановлю картину по rate con и ELD, подтвержу аппоинтмент, а затем налажу короткий письменный шаблон передачи смены.",
          en: "I would rebuild the picture myself from the rate con and the ELD, confirm the appointment, then set up a short written shift-handoff template.",
        } },
        { key: "dispatch_q03_c", pattern: "waiting", text: {
          uz: "Tungi dispetcherga yozib qoʻyaman va uygʻonishini kutaman — tafsilot unda; toʻliqmas maʼlumot bilan harakat qilsam, kelishilgan narsani buzib qoʻyishim mumkin.",
          ru: "Напишу ночному диспетчеру и подожду, пока он проснётся: детали у него; действуя по неполным данным, я могу сломать то, что уже согласовано.",
          en: "I would message the night dispatcher and wait for him to wake — the details are his; acting on partial data risks breaking what is already agreed.",
        } },
        { key: "dispatch_q03_d", pattern: "victim", text: {
          uz: "Ertalabki smena tungi smenaning tugallanmagan ishlaridan boshlanadi — natijam shunga qarab oʻlchanmasligi uchun buni hozirdan yozib qoʻyaman.",
          ru: "Утренняя смена начинается с незакрытых дел ночной — чтобы мой результат не мерили так же, зафиксирую это уже сейчас.",
          en: "The morning shift starts on the night shift’s loose ends — I would put that on record now so my result is not measured as if it had not.",
        } },
        { key: "dispatch_q03_e", pattern: "ownership", text: {
          uz: "Rate conni ochib, haydovchiga qoʻngʻiroq qilaman, yetishmayotgan maʼlumotni oʻzim toʻldiraman va broker qoʻngʻiroq qilishidan oldin yetkazish apoyntmentini tasdiqlayman.",
          ru: "Открою rate con, позвоню водителю, сам заполню недостающие данные и подтвержу аппоинтмент на выгрузку до звонка брокера.",
          en: "I would open the rate con, call the driver, fill in the missing details myself, and confirm the delivery appointment before the broker calls.",
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
          uz: "Haydovchiga aytaman, lekin jamoada aytaman: bu broker yana bekor qildi — u bilan ishlash shartlari qayta koʻrilmasa, bekor qilishlar shunday davom etadi.",
          ru: "Водителю скажу, но в команде отмечу: этот брокер снова отменил — пока не пересмотрят условия работы с ним, отмены так и будут продолжаться.",
          en: "I would tell the driver, but note in the team that this broker has cancelled again — unless the terms we work with him on are revisited, this continues.",
        } },
        { key: "dispatch_q04_b", pattern: "ownership", text: {
          uz: "Haydovchiga darhol qoʻngʻiroq qilib boʻlganini borligicha aytaman va shu joydan yangi yuk izlashni hoziroq boshlayman — kuni bekor ketmasligi kerak.",
          ru: "Сразу позвоню водителю, скажу как есть и прямо сейчас начну искать новый груз от его текущей точки — день не должен пропасть.",
          en: "I would call the driver at once, tell him straight what happened, and start looking for a new load from his position right now — the day should not be lost.",
        } },
        { key: "dispatch_q04_c", pattern: "victim", text: {
          uz: "Bekor qilish qarori brokerda, boʻsh yurilgan mil esa mening reysimda — hisobotni shu ikkisi alohida koʻrinadigan qilib bugun tayyorlab qoʻyaman.",
          ru: "Решение об отмене принимал брокер, а порожние мили остались на моём рейсе; отчёт подготовлю так, чтобы это было видно отдельно.",
          en: "The cancellation was the broker’s call while the empty miles sit on my trip — I would build my report so those two show separately.",
        } },
        { key: "dispatch_q04_d", pattern: "builder", text: {
          uz: "Haydovchiga rost aytaman, yaqindan reload izlayman va rate con boʻyicha TONU soʻrab, yozishmani hujjat qilib qoʻyaman — bunday holatlar uchun tartib shu.",
          ru: "Водителю скажу честно, поищу reload рядом и по rate con запрошу TONU, зафиксировав переписку документально — для таких случаев порядок именно такой.",
          en: "I would tell the driver honestly, hunt a reload nearby, and claim TONU per the rate con with the correspondence on file — that is the procedure for these cases.",
        } },
        { key: "dispatch_q04_e", pattern: "blame", text: {
          uz: "Bekor qilish xabari avval kelganmi tekshiraman — kimningdir pochtasida oʻqilmay turgan boʻlsa, gap oʻsha odam bilan, haydovchiga tushuntirishdan oldin.",
          ru: "Проверю, не пришло ли извещение об отмене раньше: если оно лежало непрочитанным у кого-то в почте, разговор будет с ним, ещё до объяснений водителю.",
          en: "I would check whether the cancellation notice came earlier — if it sat unread in someone’s inbox, the conversation is with them before the driver.",
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
          uz: "Bugun brokerga rost hisobni koʻrsatib apoyntmentni koʻchirishni kelishaman, keyin yuk olishdan oldin soatlarni tekshirish qadamini jarayonga kiritaman.",
          ru: "Сегодня покажу брокеру честный расчёт и договорюсь о переносе аппоинтмента, а затем внесу в процесс проверку часов до принятия груза.",
          en: "I would show the broker the honest math today and agree a new appointment, then add an hours check before a load is accepted to our process.",
        } },
        { key: "dispatch_q05_b", pattern: "waiting", text: {
          uz: "Soatlar dam olishga qarab oʻzgaradi — brokerga taxminiy son bermay, ertalabki aniq hisobni olib, shundan keyin yangi oyna soʻrayman.",
          ru: "Часы меняются в зависимости от отдыха — не стану давать брокеру примерную цифру, возьму точный утренний расчёт и уже потом попрошу новое окно.",
          en: "The hours shift with how his rest falls — rather than give the broker a rough figure, I would take the exact morning math and ask for a new window then.",
        } },
        { key: "dispatch_q05_c", pattern: "complaint", text: {
          uz: "Apoyntmentni koʻchiraman, lekin rahbarga aytaman: yuk olinayotganda haydovchining soati soʻralmaydi — bu tartib oʻzgarmasa, dispetcher har safar chiqish yoʻlsiz qoladi.",
          ru: "Аппоинтмент перенесу, но скажу руководителю: при взятии груза часы водителя не спрашивают — пока порядок не изменится, диспетчер каждый раз без выхода.",
          en: "I would move the appointment, but tell my lead nobody asks about the driver’s hours when a load is booked — unchanged, dispatch is left with no way out.",
        } },
        { key: "dispatch_q05_d", pattern: "ownership", text: {
          uz: "Avval haydovchi bilan hisobni qayta tekshiraman, keyin bugun brokerga qoʻngʻiroq qilib real yetib borish vaqtini ochiq aytaman va yangi oyna soʻrayman.",
          ru: "Сначала пересчитаю вместе с водителем, затем сегодня же позвоню брокеру, открыто назову реальное время прибытия и попрошу новое окно.",
          en: "I would recheck the math with the driver first, then call the broker today, state the realistic arrival time openly, and ask for a new window.",
        } },
        { key: "dispatch_q05_e", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: bu reys soat boʻyicha imkonsiz edi — kechikish mening koʻrsatkichimda qolsa, uni kim rejalashtirgani bilan birga koʻrilishi kerak.",
          ru: "Прямо скажу руководителю: этот рейс по часам был невозможен — если опоздание останется на моих показателях, смотреть надо вместе с тем, кто его планировал.",
          en: "I would tell my lead plainly the trip was impossible on the hours — if the delay stays on my numbers, it should be read alongside who planned it that way.",
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
          uz: "Uskuna holati ham, uni yardan chiqarish qarori ham menda emas — shuni rahbar bilan oldin aniq qilaman, keyin reys boʻyicha harakat qilaman.",
          ru: "Ни состояние техники, ни решение выпустить её с ярда не в моих руках — сначала проясню это с руководителем, а потом займусь рейсом.",
          en: "Neither the equipment’s condition nor the decision to release it is mine — I would settle that with my lead first, then work the trip.",
        } },
        { key: "dispatch_q06_b", pattern: "blame", text: {
          uz: "Bu treyler oxirgi marta qachon koʻrikdan oʻtgani va yardan kim chiqarganini aniqlayman — nosozlik masʼulligi shopda va javob ham oʻsha yerdan chiqadi.",
          ru: "Выясню, когда этот трейлер последний раз проходил осмотр и кто выпустил его с ярда: ответственность за поломку на стороне шопа, оттуда и ответ.",
          en: "I would establish when this trailer last passed inspection and who released it — a mechanical failure sits with the shop, and the answer comes from there.",
        } },
        { key: "dispatch_q06_c", pattern: "waiting", text: {
          uz: "Haydovchiga road service chaqirtiraman — mexanik kelib taʼmir vaqtini aytmaguncha brokerga vaqt aytmayman; aniqsiz son keyin ikki marta tuzatiladi.",
          ru: "Попрошу водителя вызвать road service — пока механик не приедет и не назовёт время ремонта, брокеру время называть не буду: неточную цифру потом правят дважды.",
          en: "I would have the driver call road service — until the mechanic names a repair time I would give the broker no time; a vague figure gets corrected twice.",
        } },
        { key: "dispatch_q06_d", pattern: "builder", text: {
          uz: "Road service ni tez ishga solaman, brokerni taxminiy muddat bilan ogohlantiraman, keyin reysdan soʻng bu treylerni tekshiruvga yozib, holatini shopga belgilaman.",
          ru: "Быстро запущу road service, предупрежу брокера с примерным сроком, а после рейса запишу этот трейлер на проверку и отмечу его состояние шопу.",
          en: "I would get road service moving fast, warn the broker with a rough timeline, then book this trailer for a check after the trip and flag its condition to the shop.",
        } },
        { key: "dispatch_q06_e", pattern: "ownership", text: {
          uz: "Haydovchi uchun road service ni oʻzim hoziroq tashkil qilaman va brokerga kechikish boʻlishi mumkinligini hozir rost aytaman, taʼmir vaqti aniq boʻlgach yangilaman.",
          ru: "Сам прямо сейчас организую водителю road service и честно скажу брокеру, что доставка может сдвинуться, а как станет ясно время ремонта — обновлю.",
          en: "I would arrange road service for the driver myself right now and tell the broker honestly that delivery may slip, updating him once the repair time is clear.",
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
          uz: "Treyler boʻlimi bilan hoziroq boshqa boʻsh treyler izlayman; mos keladigani boʻlmasa, brokerni erta ogohlantirib, yangi pickup vaqtini rost kelishaman.",
          ru: "Прямо сейчас поищу с трейлерным отделом другой свободный трейлер; если подходящего нет, заранее предупрежу брокера и честно согласую новое время погрузки.",
          en: "I would look for another free trailer with the Trailer Department right now; if nothing fits, I would warn the broker early and agree a new pickup time honestly.",
        } },
        { key: "dispatch_q07_b", pattern: "complaint", text: {
          uz: "Almashtirishga harakat qilaman, lekin jamoada aytaman: treyler statuslariga ishonib boʻlmaydi — statusni kim yangilashi belgilanmasa, bu har hafta qaytadi.",
          ru: "Попробую найти замену, но в команде скажу: статусам трейлеров доверять нельзя — пока не определят, кто их обновляет, это будет каждую неделю.",
          en: "I would try for a swap, but say in the team that trailer statuses cannot be trusted — until it is settled who updates them, this comes back weekly.",
        } },
        { key: "dispatch_q07_c", pattern: "builder", text: {
          uz: "Bugunni zaxira treyler yoki rost koʻchirish bilan yopaman, keyin treyler boʻlimiga «tayyor» statusi faqat shop tasdigʻidan keyin qoʻyilishini taklif qilaman.",
          ru: "Сегодняшний день закрою подменным трейлером или честным переносом, а затем предложу трейлерному отделу ставить статус «готов» только после подтверждения шопа.",
          en: "I would close today with a substitute trailer or an honest reschedule, then propose to the Trailer Department that “ready” be set only after the shop confirms.",
        } },
        { key: "dispatch_q07_d", pattern: "blame", text: {
          uz: "Notoʻgʻri statusni kim qoʻyganini yozma aniqlab olaman — kechikish treyler boʻlimida boshlangan boʻlsa, oʻsha uzilishni ular yopishi kerak.",
          ru: "Письменно выясню, кто поставил неверный статус: если задержка началась в трейлерном отделе, закрывать этот разрыв им.",
          en: "I would establish in writing who set the wrong status — if the delay started in the Trailer Department, they are the ones to close it.",
        } },
        { key: "dispatch_q07_e", pattern: "waiting", text: {
          uz: "Shopdan taʼmir qancha davom etishini soʻrayman va aniq chiqish vaqti aytilmaguncha boshqa qadam qoʻymayman — aniqsizlikda qilingan almashtirish ikki yukni buzadi.",
          ru: "Спрошу у шопа, сколько продлится ремонт, и до точного времени выхода других шагов делать не буду: замена вслепую ломает сразу два груза.",
          en: "I would ask the shop how long the repair runs and take no further step before an exact release time — a swap made blind breaks two loads instead of one.",
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
          uz: "Hozir jahli chiqqan — bahslashsam yomonlashadi. Yuk tushirilgach xotirjam gaplashamiz; detention soʻrovini esa vaqtlar aniq boʻlgach yuboraman.",
          ru: "Он сейчас на эмоциях — спор только ухудшит. Спокойно поговорим после выгрузки, а запрос на detention отправлю, когда будут точные времена.",
          en: "He is worked up — arguing makes it worse. We would talk calmly after unloading, and I would file the detention claim once the times are confirmed.",
        } },
        { key: "dispatch_q08_b", pattern: "builder", text: {
          uz: "Tinchlantiraman, check-in maʼlumotini qayta yuboraman, aniq vaqtlar bilan detention soʻrayman va muhim koʻrsatmalarga haydovchidan qisqa tasdiq olishni boshlaymiz.",
          ru: "Успокою, повторно отправлю данные check-in, запрошу detention с точными временами и начнём брать у водителей короткое подтверждение по ключевым инструкциям.",
          en: "I would calm him down, resend the check-in details, claim detention with exact times, and start taking a short confirmation from drivers on key instructions.",
        } },
        { key: "dispatch_q08_c", pattern: "victim", text: {
          uz: "Koʻrsatmalar oʻz vaqtida yuborilgan — oʻqilmagan xabar sababli chiqqan norozilik meni oʻlchamasligi uchun yuborilgan vaqtni yozib qoʻyaman.",
          ru: "Инструкции ушли вовремя — чтобы недовольство из-за непрочитанного сообщения не мерило меня, зафиксирую время отправки.",
          en: "The instructions went out on time — I would record the send time so anger over an unread message does not measure me.",
        } },
        { key: "dispatch_q08_d", pattern: "ownership", text: {
          uz: "Bahslashmay tinglayman, check-in qadamlarini darhol qayta yuboraman, kirish-chiqish vaqtlarini yozib olaman va bugun brokerga detention soʻrovini yuboraman.",
          ru: "Выслушаю без спора, сразу повторно отправлю шаги check-in, запишу времена въезда и выезда и сегодня же отправлю брокеру запрос на detention.",
          en: "I would listen without arguing, resend the check-in steps at once, take down the in and out times, and send the broker a detention claim today.",
        } },
        { key: "dispatch_q08_e", pattern: "blame", text: {
          uz: "Xabarlar tarixini ochib, koʻrsatma qachon va kimga ketganini aniqlayman — yozuv haydovchi tomonini koʻrsatsa, suhbat ham, tuzatish ham osonlashadi.",
          ru: "Открою историю сообщений и определю, когда и кому ушла инструкция: если запись показывает сторону водителя, и разговор, и исправление станут проще.",
          en: "I would open the message history and pin down when and to whom the instruction went — with the record pointing at the driver’s side, both talk and fix get easier.",
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
          uz: "Haydovchiga javob beraman, lekin rahbarga aytaman: kimdir kasal boʻlsa, hech kim boshqaning boardini bilmaydi — almashinuv tartibi belgilanmagani shunga olib keladi.",
          ru: "Водителю отвечу, но скажу руководителю: когда кто-то болеет, чужой борд не знает никто — к этому и приводит отсутствие порядка подмены.",
          en: "I would answer the driver, but tell my lead that when someone is out nobody knows another’s board — the missing cover procedure is what leads here.",
        } },
        { key: "dispatch_q09_b", pattern: "ownership", text: {
          uz: "Reysni tizimda oʻzim ochib, rate con asosida haydovchiga hoziroq javob beraman va hamkasbimga nima deganimni aniq yozib qoldiraman.",
          ru: "Сам открою рейс в системе, отвечу водителю прямо сейчас по rate con и оставлю коллеге точную запись о том, что именно я сказал.",
          en: "I would open the trip in the system myself, answer the driver right now from the rate con, and leave my teammate an exact note of what I told him.",
        } },
        { key: "dispatch_q09_c", pattern: "waiting", text: {
          uz: "Reys tarixini bilmasdan koʻrsatma bersam, hamkasbim kelishganiga qarshi chiqishim mumkin — haydovchidan biroz kutishni soʻrab, bu boardni kim olganini aniqlayman.",
          ru: "Дав указание без знания истории рейса, я могу пойти против того, что уже согласовал коллега — попрошу водителя немного подождать и выясню, кто взял этот борд.",
          en: "Giving direction without the trip’s history risks contradicting what my teammate agreed — I would ask the driver to hold and find out who has that board.",
        } },
        { key: "dispatch_q09_d", pattern: "builder", text: {
          uz: "Hozir tizimdan javob beraman, izoh qoldiraman, keyin har reys boʻyicha izoh yuritishni tartibga aylantiraman — shunda har qanday dispetcher oʻrnini bosa oladi.",
          ru: "Сейчас отвечу по системе, оставлю заметку, а затем сделаю порядком ведение заметок по каждому рейсу: тогда подменить сможет любой диспетчер.",
          en: "I would answer from the system now, leave a note, then make per-trip notes the procedure — with that, any dispatcher can step in.",
        } },
        { key: "dispatch_q09_e", pattern: "victim", text: {
          uz: "Bugun ikki board menda va ikkinchisining tarixini bilmayman — oʻz reyslarimda kechikish boʻlsa, qaysi qadam qaysi boardda boʻlganini yozib qoʻyaman.",
          ru: "Сегодня на мне два борда, и истории второго я не знаю — если по моим рейсам будут задержки, зафиксирую, к какому борду относится каждый шаг.",
          en: "I am carrying two boards today and do not know the history of the second — if my own trips slip, I would record which board each step belonged to.",
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
          uz: "Bu broker yuklari uchun oddiy umumiy update jadvalini taklif qilaman va birinchi variantni bugun oʻz reyslarimda sinab, jamoaga koʻrsataman.",
          ru: "Предложу простой общий график апдейтов по грузам этого брокера и сегодня обкатаю первый вариант на своих рейсах, чтобы показать команде.",
          en: "I would propose a simple shared update schedule for this broker’s loads and pilot the first version on my own trips today to show the team.",
        } },
        { key: "dispatch_q10_b", pattern: "blame", text: {
          uz: "Loglardan qaysi reyslarda va kimning smenasida update oʻtkazib yuborilganini aniqlayman — manzara aniq boʻlmasa, tanbeh butun jamoaga bir xil tarqaladi.",
          ru: "По логам определю, на каких рейсах и в чью смену апдейты пропустили: без точной картины замечание ровным слоем ляжет на всю команду.",
          en: "I would use the logs to pin down which trips and whose shifts missed the updates — without an exact picture the criticism covers the whole team evenly.",
        } },
        { key: "dispatch_q10_c", pattern: "complaint", text: {
          uz: "Oʻz reyslarimni tartibga solaman, lekin yigʻilishda aytaman: har birimizda oʻnlab trak, broker esa deyarli har soatda update kutadi — hajm koʻrilmasa, bu qaytadi.",
          ru: "Свои рейсы приведу в порядок, но на совещании скажу: у каждого из нас десятки траков, а брокер ждёт апдейт почти каждый час — без пересмотра объёма это повторится.",
          en: "I would put my own trips in order, but say at the meeting each of us runs dozens of trucks while this broker expects updates almost hourly — unaddressed, it repeats.",
        } },
        { key: "dispatch_q10_d", pattern: "victim", text: {
          uz: "Updatelarimni oʻz vaqtida yuboraman va shikoyat jamoaga yozilgan — shuning uchun oʻz reyslarim boʻyicha yozuvni hozirdan tayyorlab qoʻyaman.",
          ru: "Свои апдейты я отправляю вовремя, а жалоба адресована всей команде — поэтому по своим рейсам подготовлю выписку заранее, до разбора.",
          en: "My own updates go out on time while the complaint names the whole team — so I would have the record for my own trips ready before the review.",
        } },
        { key: "dispatch_q10_e", pattern: "ownership", text: {
          uz: "Bugun shu broker boʻyicha oʻz reyslarimni koʻrib chiqaman, har update vaqtiga eslatma qoʻyaman va bugungi updatelarni kutilganidan oldin yuboraman.",
          ru: "Сегодня разберу свои рейсы по этому брокеру, поставлю напоминание на каждое время апдейта и отправлю сегодняшние раньше, чем их ждут.",
          en: "I would go through my own trips for this broker today, set a reminder for each update time, and send today’s updates before they are expected.",
        } },
      ],
    },
  ],
};
