/**
 * SOS assessment content — Trailer Department (10 questions).
 *
 * Scope: trailer availability for scheduled loads, missing/mislocated
 * trailers, assignment conflicts, damage found at pickup, inspections,
 * overdue rental returns by outside companies, shop repair delays, missing
 * inspection/registration paperwork, damage-responsibility disputes,
 * coordination with dispatch and maintenance, trailer-tracking accuracy.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - options never encourage releasing unsafe equipment, skipping required
 *    inspections, or ignoring required documentation.
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
          uz: "Bu jadvalni yuklarning toʻliq manzarasini koʻrib dispetcherlik tuzgan — kechasi treylerlarni surib yangi chalkashlik chiqargandan koʻra, ularning ertalabki rejasini kutganim maʼqul.",
          ru: "Это расписание строила диспетчерская, видя всю картину по грузам, — лучше дождаться их утреннего плана, чем ночью двигать трейлеры и создавать новые накладки.",
          en: "Dispatch built this schedule seeing the whole load picture — better to wait for their morning plan than to move trailers around at night and create new conflicts.",
        } },
        { key: "trailer_q01_b", pattern: "builder", text: {
          uz: "Bugungi qaytishlar va yaqin stoyankalarni koʻrib mos treylerni band qilaman, dispetcherlikka aytaman, soʻng ertangi yuklar treylersiz qolmasligi uchun kunlik tushdan keyingi tekshiruvni yoʻlga qoʻyaman.",
          ru: "Просмотрю сегодняшние возвраты и ближайшие площадки, зарезервирую подходящий трейлер, сообщу диспетчерской и заведу дневную проверку, которая заранее выявляет завтрашние грузы без трейлера.",
          en: "Check tonight’s inbound returns and nearby lots, reserve a suitable unit, tell dispatch, and set up an afternoon check that flags next-day loads still left without a trailer.",
        } },
        { key: "trailer_q01_c", pattern: "victim", text: {
          uz: "Treyler boʻlimi yana hammadan oxirida bilib olyapti-da: yuk allaqachon bron qilingan, ertangi kechikish esa baribir bizning hisobimizga yoziladi.",
          ru: "Про себя отмечу, что трейлерный отдел снова узнаёт обо всём последним — груз забронировали давно, а завтрашнюю задержку всё равно запишут на нас.",
          en: "Note to myself that the Trailer Department is once again the last to find out — the load was booked long ago, yet tomorrow’s delay will still be counted against us.",
        } },
        { key: "trailer_q01_d", pattern: "ownership", text: {
          uz: "Bugun kechqurunoq kelayotgan treylerlar va qoʻshni yardlarni oʻzim koʻrib chiqaman, mos treylerni shu yukka band qilaman va dispetcher bilan haydovchiga hozirning oʻzida aniq holatni aytaman.",
          ru: "Сегодня же вечером сам просмотрю прибывающие трейлеры и соседние ярды, закреплю подходящий трейлер за этим грузом и сразу сообщу диспетчеру и водителю реальную картину.",
          en: "Go through the incoming trailers and neighboring yards myself tonight, hold a suitable unit for this load, and give the dispatcher and the driver the real picture right away.",
        } },
        { key: "trailer_q01_e", pattern: "complaint", text: {
          uz: "Hamkasblarga yuklar avval treyler bor-yoʻqligi tekshirilmasdan bron qilinayotganini aytaman — tizimdagi roʻyxat bilan yarddagi real holat allaqachon mos kelmay qolgan.",
          ru: "Скажу коллегам, что грузы бронируют, не проверяя наличие трейлеров, — список в системе и реальная картина на ярде давно не совпадают.",
          en: "Tell my coworkers that loads keep getting booked without anyone checking trailer availability first — the system board and the real yard have not matched for a long time.",
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
          uz: "Darhol treylerning soʻnggi harakatlar tarixini ochaman, uni oxirgi olib yurgan haydovchiga qoʻngʻiroq qilib hozir qayerdaligini aniqlayman va kutayotgan haydovchiga halol oraliq javob beraman.",
          ru: "Сразу подниму последние перемещения трейлера, позвоню водителю, который вёз его последним, найду, где он реально стоит, и дам ожидающему водителю честный промежуточный ответ.",
          en: "Pull the trailer’s recent movements right away, call the driver who moved it last, find where it actually stands, and give the waiting driver an honest interim answer.",
        } },
        { key: "trailer_q02_b", pattern: "complaint", text: {
          uz: "Dispetcherga treyler hisobimiz qay ahvolga kelganini aytaman — yozuvlarning yarmi eskirgan, bugun esa buni oʻz boshidan oʻtkazish navbati shu haydovchiga kelgan, xolos.",
          ru: "Скажу диспетчеру, что вот до чего дошёл наш учёт трейлеров — половина записей устарела, и сегодня просто очередь этого водителя почувствовать это на себе.",
          en: "Tell the dispatcher this is what our trailer tracking has come to — half the entries are stale, and today it is simply this driver’s turn to feel it firsthand.",
        } },
        { key: "trailer_q02_c", pattern: "blame", text: {
          uz: "Avval treylerni yozuvni yangilamasdan tashlab ketgan haydovchini aniqlayman — bugungi vaziyat kimning xatosidan chiqqani birinchi navbatda rasman qayd etilishi kerak.",
          ru: "Сначала установлю, какой водитель бросил его, не обновив запись, — прежде всего должно быть зафиксировано, чья именно ошибка создала сегодняшнюю ситуацию.",
          en: "First establish which driver dropped it without updating the record — before anything else, it should be on file whose miss created today’s situation.",
        } },
        { key: "trailer_q02_d", pattern: "waiting", text: {
          uz: "Uni oxirgi olib yurgan haydovchi smenasidan keyin aloqaga chiqadi — taxmin bilan kutayotgan haydovchini u yoqdan-bu yoqqa yuborgandan koʻra, uning tasdigʻini kutgan toʻgʻriroq.",
          ru: "Водитель, который вёз его последним, выйдет на связь после смены — правильнее дождаться его подтверждения, чем гонять ожидающего водителя по догадкам.",
          en: "The driver who moved it last will be reachable after his shift — better to wait for his confirmation than to send the waiting driver across town on guesses.",
        } },
        { key: "trailer_q02_e", pattern: "builder", text: {
          uz: "Treylerni yozuvlar va qoʻngʻiroqlar orqali topaman, bu yuk uchun dispetcher bilan eng yaqin boʻsh treylerni kelishaman, soʻng yozuvlar eskirmasligi uchun har bir topshirish suratda tasdiqlanishini taklif qilaman.",
          ru: "Найду трейлер по записям и звонкам, согласую с диспетчером ближайший свободный трейлер под этот забор, а затем предложу подтверждать каждую отцепку фотографией, чтобы записи не устаревали.",
          en: "Locate the trailer through records and calls, agree with the dispatcher on the nearest free unit for this pickup, then propose confirming every drop with a photo so entries stop going stale.",
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
          uz: "Avval vaqt belgilarini koʻrib, qaysi dispetcher band qilingan treylerni olib qoʻyganini aniqlayman — bronni buzgan tomon oʻz yukini oʻzi qayta rejalashtirishi kerak.",
          ru: "Сначала посмотрю по времени, кто из диспетчеров забрал уже зарезервированный трейлер, — тот, кто нарушил бронь, и должен перепланировать свой груз.",
          en: "First check the timestamps to see which dispatcher took a trailer that was already reserved — the one who broke the reservation should be the one to re-plan his load.",
        } },
        { key: "trailer_q03_b", pattern: "waiting", text: {
          uz: "Ikkala yuk ham dispetcherlikniki, ustuvorlikni ular yaxshiroq biladi — ular oʻrniga qaror qilgandan koʻra, avval ikki dispetcher oʻzaro kelishib olishini kutaman.",
          ru: "Оба груза — зона диспетчерской, приоритеты лучше знают они — пусть сначала два диспетчера договорятся между собой, а не я буду решать за них.",
          en: "Both loads belong to dispatch, and they know the priorities better — I would let the two dispatchers settle it between themselves first rather than decide for them.",
        } },
        { key: "trailer_q03_c", pattern: "builder", text: {
          uz: "Roʻyxatdan ikkinchi mos treylerni topib, hoziroq dispetcherlar bilan ikki haydovchini ikki treylerga ajrataman, soʻng qayta biriktirish takrorlanmasligi uchun yagona bron belgisini taklif qilaman.",
          ru: "Найду в списке второй подходящий трейлер, прямо сейчас с диспетчерами разведу двух водителей по двум трейлерам, а затем предложу единую отметку брони, чтобы двойное закрепление не повторялось.",
          en: "Find a second suitable unit on the board, split the two drivers across two trailers with the dispatchers right now, then propose a single reservation mark so double assignment cannot recur.",
        } },
        { key: "trailer_q03_d", pattern: "victim", text: {
          uz: "Treyler boʻlimi yana ikki oʻt orasida qoldi-da: biriktirgan biz emasmiz, lekin qoʻngʻiroq ham, ikkala haydovchining jahli ham baribir bizga keladi.",
          ru: "Подумаю, что трейлерный отдел опять между двух огней — закрепляли не мы, но звонить будут нам, и злиться оба водителя будут тоже на нас.",
          en: "Think how the Trailer Department is caught in the middle again — we assigned nothing, yet the calls will come to us and both drivers will be angry at us too.",
        } },
        { key: "trailer_q03_e", pattern: "ownership", text: {
          uz: "Darhol ikkala dispetcherga qoʻngʻiroq qilaman, qaysi yukning vaqti tigʻizroq ekanini aniqlayman va ikkinchi haydovchiga aniq muqobil treyler taklif qilaman — ikkala yuk ham bugun joʻnashi uchun.",
          ru: "Сразу позвоню обоим диспетчерам, выясню, у какого груза время жёстче, и предложу второму водителю конкретный запасной трейлер, чтобы оба забора состоялись сегодня.",
          en: "Call both dispatchers right away, find out which load is tighter on time, and offer the other driver a concrete alternative trailer so both pickups still happen today.",
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
          uz: "Mobil taʼmir yoki almashtiriladigan treylerni darhol harakatga keltiraman, dispetcherlikka halol yangi muddat aytaman va holat tarixi toʻliq boʻlishi uchun suratlarni treyler fayliga qoʻshaman.",
          ru: "Сразу организую мобильный ремонт или подменный трейлер, честно назову диспетчерской новый срок и приложу фото к файлу трейлера, чтобы история его состояния оставалась полной.",
          en: "Get a mobile repair or a swap trailer moving, give dispatch an honest new timeline, and attach the photos to the unit’s file so its condition history stays complete.",
        } },
        { key: "trailer_q04_b", pattern: "victim", text: {
          uz: "Nosoz treylerlar negadir doim mening smenamda chiqadi — bu yuklash bilan nima boʻlmasin, kechikish yana treyler boʻlimining boʻyniga tushadi.",
          ru: "Мне досадно, что неисправные трейлеры всегда всплывают именно в мою смену — и чем бы ни закончилось с этой погрузкой, задержку снова повесят на трейлерный отдел.",
          en: "Feel annoyed that the defective trailers always seem to surface on my shift — and however this appointment ends, the delay will land on the Trailer Department again.",
        } },
        { key: "trailer_q04_c", pattern: "complaint", text: {
          uz: "Dispetcherlikka yana bir bor aytaman: treylerlar shikast bilan qaytadi-yu, hech kim qayd etmaydi — yuklashlar bizning sustligimizdan emas, aynan shundan kuyib ketyapti.",
          ru: "Ещё раз скажу диспетчерской, что трейлеры возвращаются с повреждениями и никто это не фиксирует, — погрузки срываются именно из-за этого, а не из-за нашей медлительности.",
          en: "Tell dispatch once more that trailers keep coming back damaged and nobody writes it up — that, not our slowness, is what really burns these appointments.",
        } },
        { key: "trailer_q04_d", pattern: "blame", text: {
          uz: "Avval bu treylerni nosozliklarni qayd etmasdan topshirgan kim ekanini aniqlayman — taʼmirga pul sarflashdan oldin bu kimning xatosi ekanini oʻsha haydovchining dispetcheri bilishi kerak.",
          ru: "Сначала найду, кто сдал этот трейлер, не отметив неисправности, — прежде чем тратить деньги на ремонт, диспетчер того водителя должен знать, чьё это упущение.",
          en: "First find who returned this trailer without noting the defects — before we spend money on repairs, that driver’s dispatcher should know whose miss this was.",
        } },
        { key: "trailer_q04_e", pattern: "ownership", text: {
          uz: "Nosozliklarni haydovchining suratlari bilan tasdiqlab, bu treylerni reysga chiqarmayman; darhol taʼmir yoki oʻrniga boshqa treyler tashkil qilaman va dispetcherlikka real yangi vaqtni aytaman.",
          ru: "Подтвержу неисправности по фото водителя, не выпущу этот трейлер в рейс, сразу организую ремонт или замену и назову диспетчерской реалистичное новое время.",
          en: "Confirm the defects with the driver’s photos, keep this unit out of service, arrange a repair or a replacement trailer right away, and give dispatch a realistic new time.",
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
          uz: "Rahbarimga bu ijarachilar har safar shunday qilishini aytaman — oldindan toʻlov va kechikish uchun haqiqiy jarima joriy etilmaguncha, bu manzara hech qachon oʻzgarmaydi.",
          ru: "Скажу руководителю, что эти арендаторы каждый раз ведут себя одинаково — пока мы не введём предоплату и реальные штрафы за просрочку, картина не изменится.",
          en: "Tell my manager that these renters behave the same way every time — until we take prepayment and real late fees, nothing about this picture is going to change.",
        } },
        { key: "trailer_q05_b", pattern: "ownership", text: {
          uz: "Bugunoq ularning masʼul xodimiga toʻgʻridan-toʻgʻri qoʻngʻiroq qilaman, aniq qaytarish sanasini kelishib yozma tasdiqlab olaman va suhbatim faktga tayanishi uchun shartnomadagi kechikish bandlarini qayta oʻqiyman.",
          ru: "Сегодня же позвоню напрямую их ответственному, договорюсь о конкретной дате возврата, закреплю её письменно и перечитаю пункты договора о просрочке, чтобы разговор опирался на факты.",
          en: "Call their contact person directly today, agree on a specific return date and confirm it in writing, and re-read the contract’s late clauses so my conversation stands on facts.",
        } },
        { key: "trailer_q05_c", pattern: "waiting", text: {
          uz: "Rasmiy xat yuborilgan, kompaniyalarda qogʻozbozlik koʻpincha shunchaki sekin yuradi — masalani yuqoriga koʻtarishdan oldin javob uchun yana bir necha ish kuni beraman.",
          ru: "Официальное письмо отправлено, а бумажные вопросы в компаниях часто просто идут медленно — дам им ещё несколько рабочих дней на ответ, прежде чем поднимать вопрос выше.",
          en: "The official letter has been sent, and companies are often just slow with paperwork — I would give them a few more business days to answer before escalating this further.",
        } },
        { key: "trailer_q05_d", pattern: "builder", text: {
          uz: "Bugun telefon orqali bogʻlanib qatʼiy qaytarish sanasini yozma kelishaman, soʻng bu holat takrorlanmasligi uchun har bir ijara tugashidan bir hafta oldin eslatma yuborish tartibini taklif qilaman.",
          ru: "Сегодня дозвонюсь до них и письменно зафиксирую твёрдую дату возврата, а затем предложу напоминания за неделю до окончания каждой аренды, чтобы это не повторялось.",
          en: "Reach them by phone today and fix a firm return date in writing, then propose reminders that start a week before every rental’s end date so this does not repeat.",
        } },
        { key: "trailer_q05_e", pattern: "victim", text: {
          uz: "Muddati oʻtgan ijarachilarni quvish qachondan beri mening ishim boʻlib qoldi ekan — shartnomani yuqorida imzolashgan, treyler kechiksa esa hamma treyler boʻlimidan soʻraydi.",
          ru: "Подумаю, как погоня за просрочившими арендаторами вообще стала моей работой — договор подписывали выше, но когда трейлер задерживается, спрашивают с трейлерного отдела.",
          en: "Wonder how chasing overdue renters somehow became my job — the agreement was signed above me, but when a trailer is late, everyone asks the Trailer Department.",
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
          uz: "Oʻz navbati va ehtiyot qismlar holatini ustaxonaning oʻzi yaxshi biladi — bosim qismlarni tezlashtirmaydi, shuning uchun aniq yangilik chiqquncha bir-ikki kundan keyin qayta soʻrayman.",
          ru: "Мастерская лучше всех знает свою очередь и ситуацию с запчастями — давление детали не ускорит, поэтому переспрошу через пару дней, когда появятся реальные новости.",
          en: "The shop knows its queue and parts situation best — pressure will not make parts arrive faster, so I would check back in a couple of days when they have real news.",
        } },
        { key: "trailer_q06_b", pattern: "ownership", text: {
          uz: "Bugunoq ustaxonaga qoʻngʻiroq qilib aniq holatni olaman — qaysi qism yetishmayapti, nima toʻsib turibdi, real sana qachon — va dispetcherlikka navbatdagi taxmin emas, shu faktni yetkazaman.",
          ru: "Сегодня же позвоню в мастерскую и получу конкретику — какой детали не хватает, что именно держит, какова реальная дата — и передам диспетчерской факт, а не очередную догадку.",
          en: "Call the shop today and get a concrete status — which part is missing, what the blocker is, the real date — and pass dispatch that fact instead of another guess.",
        } },
        { key: "trailer_q06_c", pattern: "complaint", text: {
          uz: "Dispetcherlikka bu ustaxona har bir ishni choʻzishini, biz esa baribir treylerlarni oʻsha yerga yuborayotganimizni aytaman — bunday hamkorlar bilan biror narsani rejalashtirish deyarli imkonsiz.",
          ru: "Скажу диспетчерской, что эта мастерская затягивает каждый заказ, а мы всё равно продолжаем возить трейлеры туда, — с такими партнёрами планировать что-либо почти невозможно.",
          en: "Tell dispatch this shop drags out every single job, yet we keep sending trailers there anyway — with partners like this, planning anything at all is close to impossible.",
        } },
        { key: "trailer_q06_d", pattern: "builder", text: {
          uz: "Ustaxonadan aniq sabab va sanani olaman, muddat yana surilsa zaxira variantni (boshqa ustaxona yoki mobil servis) tayyorlab qoʻyaman va dispetcherlik uchun ochiq taʼmirlarning haftalik roʻyxatini yoʻlga qoʻyaman.",
          ru: "Получу от мастерской точную причину и дату, подготовлю запасной вариант (другую мастерскую или мобильный сервис) на случай нового переноса и заведу для диспетчерской еженедельный список открытых ремонтов.",
          en: "Get the exact blocker and date from the shop, line up a fallback (another shop or mobile service) in case it slips again, and start a weekly open-repairs list for dispatch.",
        } },
        { key: "trailer_q06_e", pattern: "blame", text: {
          uz: "Avval bu ustaxonani kim tanlaganini va taʼmirni yozma muddatsiz kim tasdiqlaganini koʻraman — bugungi rejadagi boʻshliq aynan oʻsha qarordan boshlangan.",
          ru: "Сначала посмотрю, кто выбрал эту мастерскую и утвердил ремонт без письменного срока, — сегодняшняя дыра в планировании началась именно с того решения.",
          en: "First look up who chose this shop and approved the repair without a written deadline — that decision is where today’s hole in the planning actually started.",
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
          uz: "Mendan ancha oldin qolib ketgan hujjat kamchiliklari negadir aynan men tayyorlayotgan treylerda chiqadi — ertangi toʻxtalish esa baribir mening sustligim sifatida koʻriladi.",
          ru: "Неприятно, что пробелы в документах, оставшиеся задолго до меня, всплывают именно на трейлере, который готовлю я, — а завтрашнюю задержку всё равно прочтут как мою медлительность.",
          en: "It stings that paperwork gaps left long before me surface exactly on the unit I am preparing — and tomorrow’s hold-up will still be read as my slowness anyway.",
        } },
        { key: "trailer_q07_b", pattern: "blame", text: {
          uz: "Avval bu treylerning oxirgi koʻrigi va hujjatlarini kim yuritganini aniqlayman — yozuvni saqlash oʻsha odamning vazifasi boʻlsa, uni tiklash ham, kamchilikka javob berish ham unga tegishli.",
          ru: "Сначала определю, кто занимался последней инспекцией и документами этого трейлера, — если запись была на нём, то восстанавливать её и отвечать за пробел должен он.",
          en: "First determine who handled this unit’s last inspection and filing — if keeping the record was their job, restoring it and answering for the gap should be theirs too.",
        } },
        { key: "trailer_q07_c", pattern: "ownership", text: {
          uz: "Hozircha treylerni reysga qoʻymayman: bugunoq texnik tizimdan koʻrik yozuvini qidiraman va ustaxonaga qoʻngʻiroq qilaman — amaldagi koʻrik topilmasa, joʻnatishdan oldin yangisini belgilayman.",
          ru: "Пока придержу трейлер: сегодня же поищу запись об инспекции в системе обслуживания и позвоню в мастерскую — а если действующей инспекции не найдётся, назначу её до любой отправки.",
          en: "Hold the trailer for now, search the maintenance system and call the shop for the inspection record today — and if no valid inspection turns up, book one before any dispatch.",
        } },
        { key: "trailer_q07_d", pattern: "waiting", text: {
          uz: "Treyler hujjatlarini yurituvchi ofis xodimi ertaga ertalab ishga chiqadi — arxivni ostin-ustun qilib birovning qogʻozlarini aralashtirib yuborgandan koʻra, uni kutgan xavfsizroq.",
          ru: "Сотрудница офиса, которая ведёт папки трейлеров, выйдет завтра утром — надёжнее дождаться её, чем переворачивать архив и перепутать чужие бумаги.",
          en: "The office employee who keeps the trailer files is back tomorrow morning — safer to wait for her than to turn the archive upside down and misplace someone else’s papers.",
        } },
        { key: "trailer_q07_e", pattern: "builder", text: {
          uz: "Treylerni chiqarishdan oldin koʻrik hujjatini tiklayman yoki koʻrikni qaytadan oʻtkazaman, soʻngra muddati tugayotgan hujjatlar oxirgi daqiqada emas, oldindan koʻrinishi uchun oylik hujjat tekshiruvini joriy qilaman.",
          ru: "До выпуска трейлера восстановлю документ или заново проведу инспекцию, а затем заведу ежемесячную проверку документов, чтобы истекающие сроки всплывали заранее, а не в последний момент.",
          en: "Restore the record or redo the inspection before releasing the unit, and then set up a monthly document check so expirations surface well ahead of dispatch, not at the last moment.",
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
          uz: "Bugun mavjud boʻlgan hamma narsani yigʻaman — ikkala koʻrik hisoboti, suratlar, yardga kirish-chiqish yozuvlari — va faktlarni rahbarimga halol taqdim etaman, ular aniq javob bermasa ham.",
          ru: "Соберу всё, что уже существует, — оба осмотра, фотографии, записи въезда и выезда с ярда — и честно изложу факты руководителю, даже если они не дадут однозначного ответа.",
          en: "Collect what already exists today — both inspection reports, photos, yard gate records — and lay the facts out for my manager honestly, even if they point to no clear answer.",
        } },
        { key: "trailer_q08_b", pattern: "victim", text: {
          uz: "Bu ish qanday tugamasin, ikkala haydovchi ham mendan xafa boʻladi — treyler boʻlimi oʻzi yaratmagan tortishuvlarda doim hakam boʻlib qolaveradi.",
          ru: "Мне обидно, что, чем бы это ни закончилось, оба водителя останутся недовольны мной — трейлерный отдел вечно судья в спорах, которые создавал не он.",
          en: "Feel that however this ends, both drivers will be unhappy with me — the Trailer Department always ends up as the referee in disputes it did not create.",
        } },
        { key: "trailer_q08_c", pattern: "builder", text: {
          uz: "Dalillarni jamlab xulosani halol aytaman — hatto «aniqlab boʻlmadi» boʻlsa ham, soʻng kelgusi tortishuvlar faktga tayanishi uchun har bir olish va topshirishda majburiy suratga olishni taklif qilaman.",
          ru: "Соберу доказательства и дам честный вывод, даже если это «установить невозможно», а затем предложу обязательные фото при каждой сцепке и отцепке, чтобы будущие споры опирались на факты.",
          en: "Assemble the evidence and give an honest conclusion, even if it is “cannot be determined”, then propose mandatory photos at every hook and drop so future disputes rest on facts.",
        } },
        { key: "trailer_q08_d", pattern: "complaint", text: {
          uz: "Hamkasblarga bu holat haydovchilarning yarmi olish paytida tuzukroq surat qilmagani uchun takrorlanayotganini aytaman — bunday intizom bilan har bir chizilgan joy uzundan-uzoq tergovga aylanadi.",
          ru: "Скажу коллегам, что это повторяется, потому что половина водителей не делает нормальных фото при заборе, — с такой дисциплиной каждая царапина превращается в долгое расследование.",
          en: "Tell my coworkers this keeps happening because half the drivers skip proper pickup photos — with that kind of discipline, every scratch turns into a long investigation.",
        } },
        { key: "trailer_q08_e", pattern: "blame", text: {
          uz: "Treyler oxirgi marta oldingi haydovchida boʻlgan, demak javobgarlik birinchi navbatda undan boshlanadi — avvalo uning dispetcheri shuni tan olishiga erishaman, qolgani keyin.",
          ru: "Последним трейлер был у предыдущего водителя, значит, ответственность по умолчанию начинается с него — сначала добьюсь, чтобы его диспетчер это признал, остальное потом.",
          en: "The previous driver had the unit last, so by default the responsibility starts with him — first I would get his dispatcher to acknowledge that before anything else moves.",
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
          uz: "Bugun kechasiyoq eng yaqin servisda shina tekshiruvini tashkil qilaman, dispetcherlik bilan yetkazish vaqtini qayta kelishaman va keyin bu treylerning shina tarixi toʻliq koʻrib chiqilishi uchun texnik boʻlimga belgilab qoʻyaman.",
          ru: "Организую проверку шины в ближайшем сервисе сегодня же, пересогласую с диспетчерской время доставки, а после отмечу этот трейлер для техотдела, чтобы историю его шин разобрали как следует.",
          en: "Arrange a tire check at the nearest shop tonight, re-plan the delivery time with dispatch, and flag this unit for maintenance afterwards so its tire history gets a proper review.",
        } },
        { key: "trailer_q09_b", pattern: "complaint", text: {
          uz: "Javob yozaman: yana oʻsha eski hikoya — treylerlar ustaxonadan yeyilgan shinalar bilan chiqyapti, buni har oy koʻtaramiz, lekin negadir hech narsa oʻzgarmayapti.",
          ru: "Отвечу, что это опять та же история — трейлеры выходят из мастерской с изношенными шинами, мы поднимаем это каждый месяц, и почему-то ничего не меняется.",
          en: "Write back that this is the same story again — units leave the shop with worn tires, we raise it every month, and somehow nothing about it ever changes.",
        } },
        { key: "trailer_q09_c", pattern: "waiting", text: {
          uz: "Haydovchidan keyingi xavfsiz toʻxtash joyida tunab qolishni soʻrayman — shinalar boʻyicha qaror texnik boʻlim rahbariga tegishli, shuning uchun ertalab uning qarorini kutgan toʻgʻriroq.",
          ru: "Попрошу водителя встать на ближайшей безопасной стоянке до утра — решения по шинам за руководителем техотдела, поэтому правильнее дождаться утром его решения.",
          en: "Ask the driver to park at the next safe stop for the night — decisions about tires belong to the maintenance manager, so it is cleaner to wait for his call in the morning.",
        } },
        { key: "trailer_q09_d", pattern: "ownership", text: {
          uz: "Haydovchini eng yaqin xavfsiz toʻxtash joyiga chiqaraman, bugun kechasi oʻzim yoʻl servisi yoki ustaxona tekshiruvini tashkil qilaman va dispetcherlikka real yetkazish manzarasini darhol yetkazaman.",
          ru: "Направлю водителя на ближайшую безопасную стоянку, сам организую выездной сервис или проверку в мастерской сегодня ночью и сразу передам диспетчерской реальную картину по доставке.",
          en: "Have the driver pull into the nearest safe stop, arrange road service or a shop check myself tonight, and update dispatch with the realistic delivery picture right away.",
        } },
        { key: "trailer_q09_e", pattern: "victim", text: {
          uz: "Bu treyler bor-yoʻgʻi oʻtgan hafta ustaxonada edi-ku — bugun yetkazish surilsa ham, biz qoʻl tekkizmagan texnika uchun yana treyler boʻlimi javob beradi.",
          ru: "Про себя возмущусь: трейлер был в мастерской всего неделю назад, но если доставка сегодня сорвётся, отвечать за технику, которую мы не трогали, снова будет трейлерный отдел.",
          en: "Grumble to myself that this unit was in the shop only last week — and if the delivery slips tonight, it will still be the Trailer Department answering for equipment we never touched.",
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
          uz: "Avval kimlarning harakatlari qayd etilmaganini — qaysi haydovchi va dispetcherlar ekanini — roʻyxat qilib rahbarlariga topshiraman; yozuvlar uchun aniq odamlar javob bermaguncha raqamlar yaxshilanmaydi.",
          ru: "Сначала составлю список, чьи перемещения не были записаны — какие водители и диспетчеры, — и передам его их руководителям; пока за записи не отвечают конкретные люди, цифры не улучшатся.",
          en: "First compile whose moves went unlogged — which drivers and dispatchers — and hand that list to their leads; until specific people answer for the entries, the numbers will not improve.",
        } },
        { key: "trailer_q10_b", pattern: "builder", text: {
          uz: "Oʻn toʻrtta yozuvni qoʻngʻiroq va hujjatlar orqali toʻgʻrilayman, soʻng dispetcherlik bilan oddiy qoida kelishaman: joylashuv tasdiqlanmaguncha olish yoki topshirish yopilgan hisoblanmaydi.",
          ru: "Исправлю четырнадцать записей по звонкам и документам, а затем согласую с диспетчерской простое правило: сцепка или отцепка не считается закрытой, пока местоположение не подтверждено.",
          en: "Fix the fourteen entries through calls and records, then agree with dispatch on one simple rule: no drop or hook is closed until the location has been confirmed.",
        } },
        { key: "trailer_q10_c", pattern: "victim", text: {
          uz: "Roʻyxat boshqalar bergan maʼlumot darajasida boʻladi-da: har oy yozuvlarni qoʻlda toʻgʻrilayman, xatolar esa baribir bizning boʻlim hisobiga yoziladi.",
          ru: "Подумаю, что список хорош ровно настолько, насколько точно в него сообщают другие, — я каждый месяц правлю записи вручную, а ошибки всё равно засчитывают нашему отделу.",
          en: "Think that the board is only as good as what others report into it — I correct entries by hand every month, yet the errors are still counted as our department’s.",
        } },
        { key: "trailer_q10_d", pattern: "waiting", text: {
          uz: "Treylerlar uchun GPS-kuzatuv loyihasi allaqachon vaʼda qilingan — hozir katta qoʻl tozalash ikki barobar ish boʻladi, shuning uchun roʻyxatni tizim kelguncha saqlab turgan mantiqan toʻgʻri.",
          ru: "Проект GPS-отслеживания трейлеров уже обещан — большая ручная чистка сейчас будет двойной работой, поэтому логично придержать список до появления системы.",
          en: "A GPS tracking project for the trailers has already been promised — a big manual cleanup now would be double work, so it makes sense to hold the list until the system arrives.",
        } },
        { key: "trailer_q10_e", pattern: "ownership", text: {
          uz: "Shu haftaning oʻzida oʻn toʻrtta yozuvni qoʻngʻiroq va hujjatlar orqali oʻzim tekshirib toʻgʻrilayman va har bir xato qayerdan chiqqanini belgilab boraman — hozirgi roʻyxatga hech boʻlmasa yana ishonsa boʻlishi uchun.",
          ru: "На этой неделе сам проверю и исправлю все четырнадцать записей по звонкам и документам, отмечая, откуда взялась каждая ошибка, — чтобы текущему списку снова можно было доверять.",
          en: "Verify and correct all fourteen entries myself this week through calls and records, noting where each error came from, so the current board can at least be trusted again.",
        } },
      ],
    },
  ],
};
