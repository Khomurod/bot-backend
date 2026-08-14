/**
 * SOS assessment content — Trailer department (10 questions).
 *
 * Scope: empty-trailer availability, drop-lot location records, double
 * assignment, pre-dispatch defects, outside rentals, outside repair shops,
 * annual inspection paperwork, damage disputes, tire/road-worthiness calls,
 * recurring yard-inventory drift.
 *
 * Authoring rules: see the header of ./hr.js — all five options must read as
 * competent and choosable, the six tendencies are loci of first action rather
 * than keyword formulas. Hard constraints for this department (see
 * docs/architecture/trailer-invariants.md): NO option may release or keep in
 * service a unit with a known defect, dispatch a trailer without a valid annual
 * inspection, let a driver continue on unsafe equipment, or drop the photo and
 * record trail. A less accountable instinct shows up as a different FIRST MOVE,
 * never as unsafe equipment handling.
 */

module.exports = {
  department: "trailer",
  questions: [
    {
      key: "trailer_q01",
      text: {
        uz: "Ertaga ertalab soat oltida haydovchi bron qilingan yuk uchun boʻsh treyler olishi kerak, lekin kechqurun tizim oʻsha yardda birorta ham boʻsh treyler yoʻqligini koʻrsatyapti. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Завтра в шесть утра водитель должен взять пустой трейлер под забронированный груз, но вечером система показывает, что на этом ярде нет ни одного свободного трейлера. Что вы, скорее всего, сделаете в первую очередь?",
        en: "Tomorrow at six a.m. a driver needs an empty trailer for a booked load, but this evening the system shows no free trailer at that yard. What would you most likely do first?",
      },
      options: [
        { key: "trailer_q01_a", pattern: "waiting", text: {
          uz: "Jadvalni dispetcherlik butun yuk manzarasini koʻrib tuzgan — kechasi treylerlarni koʻchirib yangi ziddiyat yaratgandan koʻra, ertalabki rejasini olib harakat qilaman.",
          ru: "График строила диспетчерская, видя всю картину грузов — вместо ночных перестановок трейлеров, которые создадут новые конфликты, возьму их утренний план.",
          en: "Dispatch built the schedule seeing the whole load picture — rather than move trailers at night and create fresh conflicts, I would work off their morning plan.",
        } },
        { key: "trailer_q01_b", pattern: "builder", text: {
          uz: "Kechqurungi qaytishlarni va yaqin stoyankalarni koʻraman, mos birini band qilaman, keyin ertangi treylersiz yuklarni koʻrsatadigan tushlik tekshiruvini yoʻlga qoʻyaman.",
          ru: "Посмотрю вечерние возвраты и ближние площадки, забронирую подходящий, а затем налажу дневную проверку, показывающую завтрашние грузы без трейлера.",
          en: "I would check tonight’s returns and nearby lots, reserve a suitable unit, then set up an afternoon check that surfaces tomorrow’s loads without a trailer.",
        } },
        { key: "trailer_q01_c", pattern: "victim", text: {
          uz: "Rahbarga aytib qoʻyaman: yuk ancha oldin bron qilingan, treyler boʻlimi esa oxirida biladi — ertangi kechikish bizning ishlashimiz deb baholanmasligi kerak.",
          ru: "Скажу руководителю: груз забронировали давно, а трейлерный отдел узнаёт последним — завтрашнюю задержку не стоит считать оценкой нашей работы.",
          en: "I would tell my lead the load was booked long ago while the Trailer Department finds out last — tomorrow’s delay should not be read as how we work.",
        } },
        { key: "trailer_q01_d", pattern: "ownership", text: {
          uz: "Kelayotgan treylerlarni va qoʻshni yardlarni bugun oʻzim koʻrib chiqaman, mos birini band qilaman va dispetcher bilan haydovchiga real holatni darhol aytaman.",
          ru: "Сегодня сам просмотрю приходящие трейлеры и соседние ярды, забронирую подходящий и сразу скажу диспетчеру и водителю реальную картину.",
          en: "I would go through the inbound trailers and neighboring yards myself tonight, hold a suitable unit, and give dispatch and the driver the real picture at once.",
        } },
        { key: "trailer_q01_e", pattern: "complaint", text: {
          uz: "Variantni oʻzim izlayman, lekin rahbarga aytaman: yuklar treyler bor-yoʻqligi tekshirilmasdan bron qilinadi — bu tartibda tungi qidiruv davom etadi.",
          ru: "Вариант поищу сам, но скажу руководителю: грузы бронируют, не проверяя наличие трейлера — пока не изменится порядок бронирования, поиски продолжатся.",
          en: "I would look for an option myself, but tell my lead loads are booked without checking trailer availability — the night-time trailer hunt then continues.",
        } },
      ],
    },
    {
      key: "trailer_q02",
      text: {
        uz: "Haydovchi 5312-treylerni olish uchun stoyankaga keldi, lekin treyler u yerda yoʻq — tizim esa uni aynan shu manzilda koʻrsatyapti. Yukni olib ketish bugunga belgilangan. Birinchi navbatda nima qilasiz?",
        ru: "Водитель приехал на площадку за трейлером 5312, но его там нет, хотя система показывает его именно по этому адресу. Забор груза назначен на сегодня. Что вы сделаете в первую очередь?",
        en: "A driver arrives at a drop lot to hook trailer 5312, but it is not there, although the system shows it at that exact location. The pickup is scheduled for today. What would you do first?",
      },
      options: [
        { key: "trailer_q02_a", pattern: "ownership", text: {
          uz: "Treylerning oxirgi harakatlarini hoziroq koʻraman, uni koʻchirgan haydovchiga qoʻngʻiroq qilaman va kutayotgan haydovchiga rost oraliq javob beraman.",
          ru: "Прямо сейчас посмотрю последние перемещения трейлера, позвоню водителю, который его двигал, и дам ждущему водителю честный промежуточный ответ.",
          en: "I would pull the trailer’s recent moves right now, call the driver who moved it, and give the waiting driver an honest interim answer.",
        } },
        { key: "trailer_q02_b", pattern: "complaint", text: {
          uz: "Treylerni izlayman, lekin dispetcherga aytaman: yozuvlarning yarmi eskirgan — kim yangilashi belgilanmasa, bunday yugurish har hafta boʻladi.",
          ru: "Трейлер поищу, но скажу диспетчеру: половина записей устарела — пока не определено, кто их обновляет, такая беготня будет каждую неделю.",
          en: "I would look for the trailer, but tell the dispatcher half the entries are stale — until it is settled who updates them, this scramble happens weekly.",
        } },
        { key: "trailer_q02_c", pattern: "blame", text: {
          uz: "Uni yozuvni yangilamasdan qoldirgan haydovchini aniqlayman — uzilish qayerda boʻlganini bilmasak, keyingi safar yana bir haydovchi boʻsh yugurib boradi.",
          ru: "Определю водителя, который оставил его, не обновив запись: не зная, где разрыв, в следующий раз порожняком поедет ещё один водитель.",
          en: "I would identify the driver who left it without updating the record — without knowing where the break is, another driver runs empty next time.",
        } },
        { key: "trailer_q02_d", pattern: "waiting", text: {
          uz: "Oxirgi koʻchirgan haydovchi smenasidan keyin bogʻlanadi — kutayotgan haydovchini taxmin bilan shaharning boshqa chetiga yuborgandan koʻra, uning tasdigʻini olaman.",
          ru: "Водитель, двигавший его последним, выйдет на связь после смены — вместо того чтобы гнать ждущего водителя через город по догадке, возьму его подтверждение.",
          en: "The driver who moved it last is reachable after his shift — rather than send the waiting driver across town on a guess, I would get his confirmation.",
        } },
        { key: "trailer_q02_e", pattern: "builder", text: {
          uz: "Treylerni yozuv va qoʻngʻiroqlar bilan topaman, bu pickup uchun eng yaqin boʻsh birlikni kelishaman, keyin har drop foto bilan tasdiqlanishini kiritaman.",
          ru: "Найду трейлер по записям и звонкам, согласую с диспетчером ближайшую свободную единицу под эту погрузку, а затем введу подтверждение каждого drop фотографией.",
          en: "I would locate the trailer through records and calls, agree the nearest free unit for this pickup with dispatch, then require a photo on every drop.",
        } },
      ],
    },
    {
      key: "trailer_q03",
      text: {
        uz: "Ikki dispetcher bitta boʻsh treylerni ikki xil haydovchiga biriktirib qoʻygan, ikkala haydovchi ham allaqachon yard tomon yoʻlda. Ikkala yuk ham bugunga rejalashtirilgan. Birinchi navbatda nima qilasiz?",
        ru: "Два диспетчера закрепили один и тот же пустой трейлер за двумя разными водителями, и оба водителя уже едут на ярд. Оба груза запланированы на сегодня. Что вы сделаете в первую очередь?",
        en: "Two dispatchers assigned the same empty trailer to two different drivers, and both drivers are already on their way to the yard. Both loads are scheduled for today. What would you do first?",
      },
      options: [
        { key: "trailer_q03_a", pattern: "blame", text: {
          uz: "Vaqt belgilaridan qaysi dispetcher band qilingan treylerni olganini aniqlayman — bandlikni buzgan tomon oʻz yukini qayta rejalashtirsa, tuzatish toʻgʻri joyda boʻladi.",
          ru: "По временным отметкам определю, какой диспетчер взял уже забронированный трейлер: если свой груз перепланирует та сторона, что нарушила бронь, исправление окажется на месте.",
          en: "From the timestamps I would establish which dispatcher took an already reserved trailer — with the side that broke the reservation re-planning, the fix lands right.",
        } },
        { key: "trailer_q03_b", pattern: "waiting", text: {
          uz: "Ikkala yuk ham dispetcherlikda va ustuvorlikni ular yaxshi biladi — men qaror qilib qoʻygandan koʻra, avval ikki dispetcher oʻzaro kelishib olishini soʻrayman.",
          ru: "Оба груза у диспетчерской, и приоритеты они знают лучше — вместо того чтобы решить за них, сначала попрошу двух диспетчеров договориться между собой.",
          en: "Both loads are dispatch’s and they know the priorities better — rather than decide for them, I would first have the two dispatchers settle it between themselves.",
        } },
        { key: "trailer_q03_c", pattern: "builder", text: {
          uz: "Boardda ikkinchi mos treylerni topaman, dispetcherlar bilan ikki haydovchini hoziroq ikki treylerga ajratamiz, keyin yagona bandlik belgisini kiritaman.",
          ru: "Найду на борде второй подходящий трейлер, с диспетчерами прямо сейчас разведём двух водителей на два трейлера, а затем введу единую отметку брони.",
          en: "I would find a second suitable trailer on the board, split the drivers across two units with the dispatchers now, then introduce one shared reservation mark.",
        } },
        { key: "trailer_q03_d", pattern: "victim", text: {
          uz: "Biriktirishni biz qilmaganmiz, lekin qoʻngʻiroqlar ham, ikki haydovchining noroziligi ham bizga tushadi — buni hozirdan rahbar bilan aniqlab olaman.",
          ru: "Закрепляли трейлер не мы, но и звонки, и недовольство обоих водителей приходят к нам — проясню это с руководителем сразу.",
          en: "We assigned nothing, yet both the calls and both drivers’ anger land on us — I would get that clear with my lead straight away.",
        } },
        { key: "trailer_q03_e", pattern: "ownership", text: {
          uz: "Ikkala dispetcherga hoziroq qoʻngʻiroq qilib, qaysi yuk vaqt boʻyicha tigʻizroq ekanini aniqlayman va ikkinchi haydovchiga aniq alternativ treyler taklif qilaman.",
          ru: "Прямо сейчас позвоню обоим диспетчерам, выясню, какой груз плотнее по времени, и предложу второму водителю конкретный альтернативный трейлер.",
          en: "I would call both dispatchers right now, work out which load is tighter on time, and offer the other driver a specific alternative trailer.",
        } },
      ],
    },
    {
      key: "trailer_q04",
      text: {
        uz: "Haydovchi olib ketishdan oldingi koʻrikda treyler eshigi yaxshi yopilmayotganini va bitta gabarit chirogʻi yonmayotganini aniqladi. Yuklashgacha ikki soat qoldi. Birinchi navbatda nima qilasiz?",
        ru: "На осмотре перед забором груза водитель обнаружил, что дверь трейлера плохо закрывается и не горит один габаритный фонарь. До погрузки два часа. Что вы сделаете в первую очередь?",
        en: "During the pickup inspection a driver finds that the trailer door does not close properly and one marker light is out. The loading appointment is in two hours. What would you do first?",
      },
      options: [
        { key: "trailer_q04_a", pattern: "builder", text: {
          uz: "Birlikni ishdan chiqarib, mobil taʼmir yoki almashtirish treylerini tashkil qilaman, dispetcherga rost muddat beraman va fotolarni fayliga qoʻshaman.",
          ru: "Выведу единицу из работы, организую мобильный ремонт или подменный трейлер, дам диспетчеру честный срок и приложу фото в файл единицы.",
          en: "I would take the unit out of service, get a mobile repair or a swap trailer moving, give dispatch an honest timeline, and attach the photos to its file.",
        } },
        { key: "trailer_q04_b", pattern: "victim", text: {
          uz: "Treylerni chiqarmayman. Nosoz birlik mening smenamda chiqdi, lekin uni bu holatga men keltirmadim — shuning uchun kimdan kelganini bugun yozib qoʻyaman.",
          ru: "Трейлер не выпущу. Неисправная единица всплыла в мою смену, но до этого состояния довёл её не я — поэтому сегодня зафиксирую, от кого она пришла.",
          en: "I would keep the unit out of service. The defect surfaced on my shift though I did not cause it — so today I would record who returned it this way.",
        } },
        { key: "trailer_q04_c", pattern: "complaint", text: {
          uz: "Treylerni bugun ishdan chiqaraman, lekin dispetcherga aytaman: treylerlar shikast bilan qaytadi va hech kim yozib qoʻymaydi — apoyntmentlar shundan kuyadi.",
          ru: "Сегодня выведу трейлер из работы, но скажу диспетчеру: трейлеры возвращают с повреждениями и никто их не фиксирует — от этого и горят аппоинтменты.",
          en: "I would take the unit out of service today, but tell the dispatcher trailers come back damaged and nobody writes it up — our intake procedure burns these appointments.",
        } },
        { key: "trailer_q04_d", pattern: "blame", text: {
          uz: "Treylerni ishga chiqarmayman va bu birlikni nosozliklarni belgilamasdan qaytargan haydovchini aniqlayman — taʼmirga pul sarflashdan oldin uning dispetcheri buni bilishi kerak.",
          ru: "В работу трейлер не выпущу и выясню, кто вернул эту единицу, не отметив дефекты: прежде чем тратить деньги на ремонт, его диспетчер должен об этом знать.",
          en: "I would keep the unit out of service and find who returned it without noting the defects — before money goes on repairs, his dispatcher should know.",
        } },
        { key: "trailer_q04_e", pattern: "ownership", text: {
          uz: "Nosozlikni haydovchining fotolari bilan tasdiqlab, bu birlikni ishdan chiqaraman, taʼmir yoki almashtirishni hoziroq tashkil qilaman va dispetcherga real yangi vaqt beraman.",
          ru: "Подтвержу дефекты фотографиями водителя, выведу единицу из работы, прямо сейчас организую ремонт или замену и дам диспетчеру реальное новое время.",
          en: "I would confirm the defects from the driver’s photos, take the unit out of service, arrange a repair or a swap right now, and give dispatch a real new time.",
        } },
      ],
    },
    {
      key: "trailer_q05",
      text: {
        uz: "Tashqi kompaniya shartnoma asosida treylerlaringizdan birini ijaraga olgan; qaytarish muddati oʻtganiga oʻn kun boʻldi, soʻnggi ikki xatga esa javob berishmadi. Birinchi navbatda nima qilasiz?",
        ru: "Сторонняя компания арендовала один из ваших трейлеров по договору; срок возврата прошёл десять дней назад, а на два последних письма они не ответили. Что вы сделаете в первую очередь?",
        en: "An outside company rented one of your trailers under an agreement; the return date passed ten days ago, and they have not replied to the last two emails. What would you do first?",
      },
      options: [
        { key: "trailer_q05_a", pattern: "complaint", text: {
          uz: "Bogʻlanishga urinaman, lekin rahbarga aytaman: ijarachilar har safar shunday — oldindan toʻlov va real kechikish jarimasi kiritilmasa, bu manzara oʻzgarmaydi.",
          ru: "Попробую связаться, но скажу руководителю: арендаторы ведут себя так каждый раз — пока не введут предоплату и реальные пени за просрочку, картина не изменится.",
          en: "I would try to reach them, but tell my manager renters behave this way every time — without prepayment and real late fees, none of this picture changes.",
        } },
        { key: "trailer_q05_b", pattern: "ownership", text: {
          uz: "Bugun ularning aloqa shaxsiga oʻzim qoʻngʻiroq qilib aniq qaytarish sanasini kelishaman va yozma tasdiqlab olaman, shartnomaning kechikish bandlarini esa oldin qayta oʻqiyman.",
          ru: "Сегодня сам позвоню их контактному лицу, согласую конкретную дату возврата и подтвержу письменно, а перед этим перечитаю пункты договора о просрочке.",
          en: "I would call their contact myself today, agree a specific return date and confirm it in writing, having re-read the contract’s late clauses first.",
        } },
        { key: "trailer_q05_c", pattern: "waiting", text: {
          uz: "Rasmiy xat ketgan va kompaniyalar hujjat bilan sekin ishlaydi — masalani yuqoriga koʻtarishdan oldin yana bir necha ish kuni beraman, aks holda hamkorlik keskinlashadi.",
          ru: "Официальное письмо ушло, а компании с документами работают медленно — прежде чем поднимать вопрос выше, дам ещё несколько рабочих дней, иначе отношения обострятся.",
          en: "The official letter is out and companies are slow with paperwork — before escalating I would give them a few more business days, or the relationship sours.",
        } },
        { key: "trailer_q05_d", pattern: "builder", text: {
          uz: "Bugun telefonda bogʻlanib aniq sanani yozma belgilayman, keyin har ijara tugashidan bir hafta oldin eslatma ketishini yoʻlga qoʻyaman — bu safar emas, keyingilari uchun.",
          ru: "Сегодня свяжусь по телефону и письменно зафиксирую дату, а затем налажу напоминание за неделю до конца каждой аренды — не для этого случая, а для следующих.",
          en: "I would reach them by phone today and fix the date in writing, then set up a reminder a week before every rental ends — not for this one, for the next ones.",
        } },
        { key: "trailer_q05_e", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: shartnoma ham, ijara shartlari ham mening darajamda tuzilmagan, lekin treyler kechikkanda savol bizga keladi — buni ajratib koʻrish kerak.",
          ru: "Прямо скажу руководителю: ни договор, ни условия аренды заключались не на моём уровне, а когда трейлер задерживается, спрашивают нас — это стоит разделять.",
          en: "I would tell my manager plainly neither the agreement nor its terms were set at my level, yet a late trailer brings the question to us — that should be separated.",
        } },
      ],
    },
    {
      key: "trailer_q06",
      text: {
        uz: "Treyler tashqi ustaxonada vaʼda qilingan muddatdan bir hafta oʻtib ham turibdi; dispetcherlik qachon tayyor boʻlishini soʻrayvermoqda, ustaxona esa mavhum javob beryapti. Birinchi navbatda nima qilasiz?",
        ru: "Трейлер стоит во внешней мастерской уже неделю сверх обещанного срока; диспетчерская постоянно спрашивает, когда он будет готов, а мастерская отвечает уклончиво. Что вы сделаете в первую очередь?",
        en: "A trailer has been at an outside repair shop for a week past the promised date, dispatch keeps asking when it will be available, and the shop answers vaguely. What would you do first?",
      },
      options: [
        { key: "trailer_q06_a", pattern: "waiting", text: {
          uz: "Navbat va ehtiyot qism holatini shop yaxshi biladi — bosim qism keltirmaydi; ikki kundan keyin aniq yangilik boʻlganda qayta bogʻlanaman.",
          ru: "Очередь и наличие запчастей шоп знает лучше — давление деталей не привезёт; свяжусь снова через пару дней, когда будут конкретные новости.",
          en: "The shop knows its queue and parts best — pressure does not make parts arrive; I would come back in a couple of days when there is real news.",
        } },
        { key: "trailer_q06_b", pattern: "ownership", text: {
          uz: "Bugun shopga qoʻngʻiroq qilib aniq holatni olaman — qaysi qism yoʻq, nima toʻsib turibdi, real sana qachon — va dispetcherlikka taxmin emas, shu faktni aytaman.",
          ru: "Сегодня позвоню в шоп и получу конкретику: какой детали нет, что блокирует, какая реальная дата — и передам диспетчерской именно этот факт, а не догадку.",
          en: "I would call the shop today and get specifics — which part is missing, what is blocking, the real date — and pass dispatch that fact instead of a guess.",
        } },
        { key: "trailer_q06_c", pattern: "complaint", text: {
          uz: "Aniq sana soʻrayman, lekin dispetcherga aytaman: bu shop har ishni choʻzadi, lekin treylerlarni yana shu yerga yuboramiz — servis tanlash tartibi qayta koʻrilishi kerak.",
          ru: "Точную дату запрошу, но скажу диспетчеру: этот шоп тянет каждую работу, а трейлеры мы всё равно отправляем туда — порядок выбора сервиса надо пересмотреть.",
          en: "I would ask for an exact date, but tell dispatch this shop drags out every job while we keep sending trailers there — how we pick a shop needs revisiting.",
        } },
        { key: "trailer_q06_d", pattern: "builder", text: {
          uz: "Shopdan aniq toʻsiq va sanani olaman, yana choʻzilsa deb zaxira variantni tayyorlab qoʻyaman va dispetcherlik uchun haftalik ochiq taʼmirlar roʻyxatini boshlaymiz.",
          ru: "Возьму у шопа конкретный блокер и дату, подготовлю резервный вариант на случай новой задержки и начнём для диспетчерской еженедельный список открытых ремонтов.",
          en: "I would get the exact blocker and date from the shop, line up a fallback in case it slips again, and start a weekly open-repairs list for dispatch.",
        } },
        { key: "trailer_q06_e", pattern: "blame", text: {
          uz: "Bu shopni kim tanlagani va taʼmirni yozma muddatsiz kim tasdiqlaganini bugun oʻzim koʻraman — rejadagi bu teshik aynan oʻsha qarordan boshlangan.",
          ru: "Сегодня сам посмотрю, кто выбрал этот шоп и кто согласовал ремонт без письменного срока: эта дыра в планировании началась с того решения.",
          en: "I would look myself today at who chose this shop and approved the repair with no written deadline — this hole in the planning began there.",
        } },
      ],
    },
    {
      key: "trailer_q07",
      text: {
        uz: "Ertangi yuk uchun treylerni tayyorlayapsiz va uning yillik texnik koʻrik hujjati jildda yoʻqligini, treylerdagi stiker esa oʻqib boʻlmas holga kelganini payqadingiz. Birinchi navbatda nima qilasiz?",
        ru: "Вы готовите трейлер под завтрашний груз и замечаете, что документа о ежегодной инспекции нет в папке, а наклейка на самом трейлере стала нечитаемой. Что вы сделаете в первую очередь?",
        en: "You are preparing a trailer for tomorrow’s load and notice that its annual inspection paperwork is not in the folder, and the sticker on the trailer itself is unreadable. What would you do first?",
      },
      options: [
        { key: "trailer_q07_a", pattern: "victim", text: {
          uz: "Treylerni chiqarmayman va rahbarga aytaman: hujjatdagi bu boʻshliq mendan oldin paydo boʻlgan — ertangi kechikish mening sekinligim deb baholanmasligi kerak.",
          ru: "Трейлер не выпущу и скажу руководителю: этот пробел в документах возник задолго до меня — завтрашнюю задержку не стоит считать моей медлительностью.",
          en: "I would keep the trailer back and tell my lead this paperwork gap arose long before me — tomorrow’s hold-up should not be read as my slowness.",
        } },
        { key: "trailer_q07_b", pattern: "blame", text: {
          uz: "Treylerni ushlab turaman va bu birlikning oxirgi koʻrigini kim oʻtkazgan, hujjatni jildga kim qoʻyishi kerak boʻlganini aniqlayman — yozuvni tiklash ham oʻsha yerdan boshlanadi.",
          ru: "Трейлер задержу и выясню, кто проводил последнюю инспекцию этой единицы и кто должен был положить документ в папку: восстановление записи начинается там же.",
          en: "I would hold the trailer and establish who did its last inspection and who was to file the document — restoring the record starts in the same place.",
        } },
        { key: "trailer_q07_c", pattern: "ownership", text: {
          uz: "Treylerni hozircha ushlab turaman, bugun texnik tizimdan va shopdan koʻrik yozuvini oʻzim izlayman — amaldagi koʻrik topilmasa, chiqarishdan oldin yangisini buyuraman.",
          ru: "Пока задержу трейлер, сегодня сам поищу запись об инспекции в техсистеме и в шопе — если действующей инспекции не найдётся, до выпуска закажу новую.",
          en: "I would hold the trailer and search the maintenance system and the shop for the inspection record today — with none valid, I book one before release.",
        } },
        { key: "trailer_q07_d", pattern: "waiting", text: {
          uz: "Treyler fayllarini yuritadigan ofis xodimi ertalab keladi — arxivni oʻzim titib boshqa hujjatlarni aralashtirmaslik uchun uning javobini olaman; treyler shu vaqtgacha chiqmaydi.",
          ru: "Сотрудница, ведущая файлы трейлеров, будет с утра — чтобы, копаясь в архиве, не перепутать чужие документы, дождусь её ответа; до тех пор трейлер не выйдет.",
          en: "The office employee who keeps the trailer files is in first thing — rather than turn the archive over and misplace papers, I would get her answer; it stays parked.",
        } },
        { key: "trailer_q07_e", pattern: "builder", text: {
          uz: "Chiqarishdan oldin yozuvni tiklayman yoki koʻrikni qayta oʻtkazaman, keyin oylik hujjat tekshiruvini kiritaman — muddatlar oxirgi kunda emas, oldin koʻrinishi kerak.",
          ru: "До выпуска восстановлю запись или проведу инспекцию заново, а затем введу ежемесячную проверку документов: сроки должны быть видны заранее, а не в последний день.",
          en: "I would restore the record or redo the inspection before release, then add a monthly document check — expiries should surface early, not on the last day.",
        } },
      ],
    },
    {
      key: "trailer_q08",
      text: {
        uz: "Treylerni olayotgan haydovchi kuzovda shikast borligini aytib, bu undan oldin ham bor boʻlganini taʼkidlamoqda; oldingi haydovchi esa treylerni butun topshirganini aytyapti. Taʼmir arzon tushmaydi. Birinchi navbatda nima qilasiz?",
        ru: "Водитель, забирающий трейлер, сообщает о повреждении кузова и говорит, что оно было до него; предыдущий водитель уверяет, что сдал трейлер целым. Ремонт обойдётся недёшево. Что вы сделаете в первую очередь?",
        en: "A driver hooking a trailer reports body damage and says it was there before him; the previous driver insists he returned the unit intact. The repair will not be cheap. What would you do first?",
      },
      options: [
        { key: "trailer_q08_a", pattern: "ownership", text: {
          uz: "Bugun mavjud narsani yigʻaman — ikki koʻrik hisoboti, fotolar, yard darvozasi yozuvlari — va faktlarni rahbarga borligicha qoʻyaman, hatto aniq javob chiqmasa ham.",
          ru: "Сегодня соберу всё, что есть — два отчёта осмотра, фото, записи с ворот ярда — и выложу руководителю факты как есть, даже если однозначного ответа не выйдет.",
          en: "I would gather what exists today — both inspection reports, photos, yard gate records — and lay the facts before my manager as they are, answer or no answer.",
        } },
        { key: "trailer_q08_b", pattern: "victim", text: {
          uz: "Rahbarga aytib qoʻyaman: bahsni biz yaratmadik, lekin hakam boʻlish bizga tushadi — ikki haydovchining noroziligi bizning ish sifatimizga baho boʻlmasligi kerak.",
          ru: "Скажу руководителю: спор создали не мы, а быть судьёй приходится нам — недовольство двух водителей не должно становиться оценкой качества нашей работы.",
          en: "I would tell my manager we did not create the dispute yet the refereeing falls to us — two unhappy drivers should not become a verdict on our department.",
        } },
        { key: "trailer_q08_c", pattern: "builder", text: {
          uz: "Dalillarni yigʻib, «aniqlanmadi» boʻlsa ham rost xulosa beraman, keyin har ulash va uzatishda majburiy foto tartibini kiritaman — keyingi bahs faktga tayanadi.",
          ru: "Соберу доказательства и дам честный вывод, даже если это «установить не удалось», а затем введу обязательное фото при каждом прицеплении и сдаче.",
          en: "I would assemble the evidence and give an honest conclusion, “undetermined” included, then require photos at every hook and drop so the next dispute rests on facts.",
        } },
        { key: "trailer_q08_d", pattern: "complaint", text: {
          uz: "Dalil yigʻaman, lekin rahbarga aytaman: haydovchilarning yarmi olishda foto qilmaydi — foto talabi nazorat qilinmasa, har tirnalgan joy uzoq tekshiruvga aylanadi.",
          ru: "Доказательства соберу, но скажу руководителю: половина водителей не фотографирует при приёмке — пока требование фото не контролируют, каждая царапина превращается в долгую проверку.",
          en: "I would gather the evidence, but tell my manager half the drivers skip pickup photos — with that requirement unenforced, every scratch becomes a long investigation.",
        } },
        { key: "trailer_q08_e", pattern: "blame", text: {
          uz: "Treyler oxirgi marta oldingi haydovchida boʻlgan — avval uning koʻrik hisobotini va dispetcherining izohini olaman: masʼullik zanjiri shu yerdan tekshiriladi.",
          ru: "Последним трейлер был у предыдущего водителя — сначала возьму его отчёт осмотра и пояснение его диспетчера: цепочка ответственности проверяется отсюда.",
          en: "The previous driver had the unit last — I would start with his inspection report and his dispatcher’s account: that is where the chain gets checked.",
        } },
      ],
    },
    {
      key: "trailer_q09",
      text: {
        uz: "Kechqurun haydovchi sizga yozmoqda: hozirgina ulagan treyleri bir tomonga tortyapti, bitta shinasi esa qattiq yeyilganga oʻxshaydi, lekin uning fikricha, yetkazib berishga baribir ulgursa kerak. Birinchi navbatda nima qilasiz?",
        ru: "Поздно вечером водитель пишет вам: только что прицепленный трейлер тянет в сторону, а одна шина выглядит сильно изношенной, но, по его мнению, до доставки он, скорее всего, доедет. Что вы сделаете в первую очередь?",
        en: "Late in the evening a driver texts you that the trailer he just hooked pulls to one side and one tire looks badly worn, but he thinks he can probably still make the delivery. What would you do first?",
      },
      options: [
        { key: "trailer_q09_a", pattern: "builder", text: {
          uz: "Bugun kechasi eng yaqin shopda shina tekshiruvini tashkil qilaman, yetkazish vaqtini dispetcherlik bilan qayta rejalashtiraman, keyin birlikni koʻrikka yozaman.",
          ru: "Сегодня же организую проверку шины в ближайшем шопе, перепланирую с диспетчерской время доставки, а затем поставлю эту единицу на разбор по истории шин.",
          en: "I would arrange a tire check at the nearest shop tonight, re-plan the delivery time with dispatch, then book this unit for a review of its tire history.",
        } },
        { key: "trailer_q09_b", pattern: "complaint", text: {
          uz: "Yoʻlda davom etishga ruxsat bermayman va rahbarga aytaman: yeyilgan shina bilan birliklar shopdan chiqadi — qabul nazorati oʻzgarmasa, bunday tunlar takrorlanadi.",
          ru: "Ехать дальше не разрешу и скажу руководителю: единицы выходят из шопа с изношенными шинами — пока не изменится контроль приёмки, такие ночи будут повторяться.",
          en: "I would not let him continue and would tell my manager units leave the shop on worn tires — with intake control unchanged, nights like this repeat.",
        } },
        { key: "trailer_q09_c", pattern: "waiting", text: {
          uz: "Haydovchidan keyingi xavfsiz joyda tunashni soʻrayman — shina boʻyicha qaror texnik rahbarda, shuning uchun ertalab uning qarorini olib harakat qilamiz.",
          ru: "Попрошу водителя переночевать на ближайшей безопасной стоянке — решение по шине за техническим руководителем, поэтому утром будем действовать по его решению.",
          en: "I would have the driver park for the night at the next safe stop — the tire call belongs to the maintenance manager, so we act on his decision in the morning.",
        } },
        { key: "trailer_q09_d", pattern: "ownership", text: {
          uz: "Haydovchini eng yaqin xavfsiz joyga toʻxtataman, road service yoki shop tekshiruvini bugun kechasi oʻzim tashkil qilaman va dispetcherlikka real manzarani darhol aytaman.",
          ru: "Остановлю водителя на ближайшей безопасной стоянке, сам сегодня же организую road service или проверку в шопе и сразу сообщу диспетчерской реальную картину.",
          en: "I would stop the driver at the nearest safe place, arrange road service or a shop check myself tonight, and give dispatch the real picture at once.",
        } },
        { key: "trailer_q09_e", pattern: "victim", text: {
          uz: "Yoʻlda davom etishga ruxsat bermayman. Bu birlik oʻtgan hafta shopda edi — kechikish sababini shu bilan birga yozib qoʻyaman.",
          ru: "Ехать дальше не разрешу. Эта единица была в шопе всего неделю назад — причину задержки зафиксирую вместе с этим фактом.",
          en: "I would not let him continue. This unit was in the shop only last week — I would record the reason for the delay together with that fact.",
        } },
      ],
    },
    {
      key: "trailer_q10",
      text: {
        uz: "Oylik yard tekshiruvi oʻn toʻrtta treylerning tizimda qayd etilgan joyi haqiqatga mos kelmasligini koʻrsatdi — bunday raqamlar ketma-ket uchinchi oy takrorlanyapti. Birinchi navbatda nima qilasiz?",
        ru: "Ежемесячная проверка ярда показала, что у четырнадцати трейлеров записанное в системе местоположение не совпадает с реальным — такие цифры уже третий месяц подряд. Что вы сделаете в первую очередь?",
        en: "The monthly yard check shows that for fourteen trailers the recorded location does not match reality — the third month in a row with numbers like this. What would you do first?",
      },
      options: [
        { key: "trailer_q10_a", pattern: "blame", text: {
          uz: "Kimning koʻchirishlari yozilmaganini — qaysi haydovchi va dispetcher — aniqlab, roʻyxatni ularning rahbarlariga beraman: yozuv kimda uzilsa, tuzatish ham oʻsha yerda.",
          ru: "Определю, чьи перемещения не записаны — какие водители и диспетчеры — и передам список их руководителям: где рвётся запись, там и исправление.",
          en: "I would establish whose moves went unlogged — which drivers and dispatchers — and give that list to their leads: where the record breaks is where it gets fixed.",
        } },
        { key: "trailer_q10_b", pattern: "builder", text: {
          uz: "Oʻn toʻrtta yozuvni tuzataman, keyin dispetcherlik bilan bitta oddiy qoidani kelishaman: joylashuv tasdiqlanmaguncha drop yoki hook yopilmaydi.",
          ru: "Исправлю четырнадцать записей, а затем согласую с диспетчерской одно простое правило: drop или hook не закрывается без подтверждения местоположения.",
          en: "I would fix the fourteen entries through calls and records, then agree one simple rule with dispatch: no drop or hook closes without a confirmed location.",
        } },
        { key: "trailer_q10_c", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: boardga maʼlumotni boshqalar kiritadi, men esa har oy qoʻlda tuzataman — bu xatolar bizning boʻlim koʻrsatkichi deb baholanmasligi kerak.",
          ru: "Прямо скажу руководителю: данные в борд вносят другие, а я каждый месяц правлю вручную — эти ошибки не стоит считать показателем нашего отдела.",
          en: "I would tell my manager plainly others enter the data while I correct it by hand every month — these errors should not be read as our department’s number.",
        } },
        { key: "trailer_q10_d", pattern: "waiting", text: {
          uz: "Treylerlar uchun GPS kuzatuv loyihasi vaʼda qilingan — hozir katta qoʻlda tozalash ikki marta ish boʻladi, shuning uchun roʻyxatni tizim kelguniga qoldiraman.",
          ru: "Проект GPS-отслеживания трейлеров уже обещан — большая ручная чистка сейчас будет двойной работой, поэтому список отложу до появления системы.",
          en: "A GPS tracking project for the trailers is already promised — a big manual cleanup now is double work, so I would hold the list until the system arrives.",
        } },
        { key: "trailer_q10_e", pattern: "ownership", text: {
          uz: "Bu hafta oʻn toʻrtta yozuvni oʻzim tekshirib tuzataman, har xato qayerdan chiqqanini belgilab boraman — board yana ishonchli boʻlishi kerak.",
          ru: "На этой неделе сам проверю и исправлю четырнадцать записей, отмечая, откуда пошла каждая ошибка — борду надо вернуть доверие.",
          en: "I would verify and correct all fourteen entries myself this week, noting where each error came from — the board has to be trustworthy again.",
        } },
      ],
    },
  ],
};
