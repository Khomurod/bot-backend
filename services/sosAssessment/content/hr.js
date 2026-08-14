/**
 * SOS assessment content — HR / Recruiting department (10 questions).
 *
 * Scope: driver recruiting, candidate communication, onboarding, orientation,
 * missing driver documents, driver expectations/complaints/relationships,
 * candidate no-shows, recruiting handoffs, retention communication.
 *
 * Authoring rules (enforced by tests/sosContent.test.js and
 * tests/sosAnswerKeyLeakage.test.js):
 *  - every question offers 5 options mapped to 5 of the 6 patterns;
 *  - ALL FIVE must read as competent, defensible and choosable. No option may
 *    sound lazy, self-pitying, careless or embarrassing — the difference is
 *    WHERE the person's first instinct points, not who is the better employee;
 *  - the six tendencies are loci of first action, never keyword formulas:
 *      victim     → my own position/exposure first (is my work being judged on
 *                   inputs I did not control?)
 *      complaint  → the recurring condition is the real subject; the change is
 *                   asked of whoever has the authority for it
 *      waiting    → confirmed information, the proper owner, the defined
 *                   sequence — action is triggered from outside
 *      blame      → locate the break so the correction lands where it belongs
 *      ownership  → this case is mine to close now, with honest information
 *      builder    → change the mechanism, sometimes at the cost of this case
 *  - no reusable tell: "today/right now", "so it does not repeat", a named
 *    rule, warmth toward the driver and process language must all appear across
 *    SEVERAL patterns, never in one only;
 *  - no option may encourage skipping required documents, misinforming a
 *    candidate or driver, or bypassing a process control.
 */

module.exports = {
  department: "hr",
  questions: [
    {
      key: "hr_q01",
      text: {
        uz: "Haydovchi nomzod kecha orientatsiyaga kelishini tasdiqlagan edi, lekin bugun kelmadi va telefonini koʻtarmayapti. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Кандидат-водитель вчера подтвердил, что придёт на ориентацию, но сегодня не пришёл и не берёт трубку. Что вы, скорее всего, сделаете в первую очередь?",
        en: "A driver candidate confirmed yesterday that he would come to orientation, but today he did not show up and is not answering his phone. What would you most likely do first?",
      },
      options: [
        { key: "hr_q01_a", pattern: "complaint", text: {
          uz: "Bugungi oʻrinni oʻzim toʻldiraman, lekin rahbarga bu haftadagi uchinchi no-show ekanini aytaman — har birini alohida yopib yurish asl sababni koʻrsatmaydi.",
          ru: "Закрою сегодняшнее место сам, но скажу руководителю, что это третий no-show за неделю: закрывая случаи по одному, настоящую причину мы не увидим.",
          en: "I would cover today’s slot myself, but tell my lead this is the third no-show this week — closing them one at a time hides the real cause.",
        } },
        { key: "hr_q01_b", pattern: "ownership", text: {
          uz: "Boshqa raqam va messenjerdan yozib koʻraman; javob boʻlmasa, zaxira roʻyxatdan kimni chaqirishni oʻzim tanlab, boʻsh oʻrinni bugun yopaman.",
          ru: "Напишу через мессенджер и другие номера; если ответа нет, сам выберу из резервного списка, кого позвать, и закрою свободное место сегодня.",
          en: "I would try another number and messenger; if there is no answer I would pick the backup myself and close the empty seat today.",
        } },
        { key: "hr_q01_c", pattern: "waiting", text: {
          uz: "Nomzodni yoʻqotilgan deb hisoblashdan oldin aniq sabab bilinishi kerak — kun oxirigacha xabar kutaman va faqat shundan keyin oʻrniga odam chaqiraman.",
          ru: "Прежде чем считать кандидата потерянным, нужна ясная причина — до конца дня жду от него весточки и только потом зову кого-то на его место.",
          en: "Before writing a candidate off I want a real reason — I would hold the seat until the end of the day and only then call someone else in.",
        } },
        { key: "hr_q01_d", pattern: "victim", text: {
          uz: "Rahbarimga bugunoq aytib qoʻyaman: guruh toʻlmagani nomzod kelmagani sababli — bu mening qanday ishlaganimga bogʻliq emasligi koʻrinib turishi kerak.",
          ru: "Сразу скажу руководителю: группа недобрана из-за неявки кандидата — должно быть видно, что дело не в том, как я вёл этого кандидата.",
          en: "I would tell my lead today that the group is short because the candidate did not come — it should be visible that this is not about how I worked the file.",
        } },
        { key: "hr_q01_e", pattern: "builder", text: {
          uz: "Oʻrnini odatdagi tartibda toʻldiraman, kuchimni esa tasdiqlash tartibiga sarflayman: bir kun oldin qoʻngʻiroq doimiy qadam boʻlsa, bunday holat kamayadi.",
          ru: "Место закрою обычным порядком, а силы вложу в сам порядок подтверждения: если звонок за день до ориентации станет постоянным шагом, таких случаев будет меньше.",
          en: "I would fill the seat the usual way and put my effort into the confirmation step: with a call one day before orientation as a fixed step, this gets rarer.",
        } },
      ],
    },
    {
      key: "hr_q02",
      text: {
        uz: "Birinchi haftasini ishlayotgan haydovchi qoʻngʻiroq qilib, unga vaʼda qilingan shartlar (masalan, mil narxi) haqiqatga toʻgʻri kelmayotganini aytmoqda va jahli chiqqan. Birinchi navbatda nima qilasiz?",
        ru: "Водитель, работающий первую неделю, звонит и возмущается: условия, которые ему обещали (например, ставка за милю), не совпадают с реальностью. Что вы сделаете в первую очередь?",
        en: "A driver in his first week calls you upset: the terms he was promised (for example, the per-mile rate) do not match reality. What would you do first?",
      },
      options: [
        { key: "hr_q02_a", pattern: "blame", text: {
          uz: "Avval offerni kim tuzganini va unga aynan nima deyilganini aniqlayman — tafovut qayerda paydo boʻlganini bilmasak, tuzatish ham toʻgʻri joyga tushmaydi.",
          ru: "Сначала выясню, кто готовил оффер и что именно ему говорили: не зная, где возникло расхождение, исправление уйдёт не туда.",
          en: "First I would establish who built the offer and what exactly he was told — without knowing where the gap appeared, the correction lands in the wrong place.",
        } },
        { key: "hr_q02_b", pattern: "builder", text: {
          uz: "Bugungi savolga hujjat asosida javob beraman, eʼtiborimni esa shartlarni yozma yuborish tartibiga qarataman: bitta shablon boʻlsa, bunday suhbatlar kamayadi.",
          ru: "На сегодняшний вопрос отвечу по документам, а внимание направлю на сам порядок отправки условий: с единым шаблоном таких разговоров станет меньше.",
          en: "I would answer today’s question from the documents and turn my attention to how terms get sent: one written template makes these calls rarer.",
        } },
        { key: "hr_q02_c", pattern: "waiting", text: {
          uz: "Raqamlar boʻyicha buxgalteriya bilan aniqlashtirmasdan javob bermayman — notoʻgʻri son aytib keyin tuzatgandan koʻra, bir necha soatdan keyin aniq javob berish toʻgʻri.",
          ru: "Не буду отвечать по цифрам, пока не сверюсь с бухгалтерией: лучше дать точный ответ через несколько часов, чем назвать неверную сумму и потом её исправлять.",
          en: "I would not answer on the numbers before checking with accounting — one exact answer a few hours later beats a wrong figure I have to walk back.",
        } },
        { key: "hr_q02_d", pattern: "ownership", text: {
          uz: "Offeri va shartnomasini ochib, haydovchi bilan band-band solishtiraman va bugun aniq javob beraman: vaʼda bilan hujjat qayerda ajralganini koʻrsataman.",
          ru: "Открою его оффер и договор, сверю с водителем пункт за пунктом и сегодня же дам конкретный ответ — покажу, где обещание расходится с документом.",
          en: "I would open his offer and contract, go through them with him point by point, and give him a firm answer today — showing where the promise and the paperwork part.",
        } },
        { key: "hr_q02_e", pattern: "victim", text: {
          uz: "Shartlarni rekruting belgilamaydi — buni haydovchiga ham, rahbarga ham aniq aytaman, chunki bunday suhbatlar oxirida mening ishim deb yozilib qoladi.",
          ru: "Условия задаёт не рекрутинг — скажу это и водителю, и руководителю: иначе такие разговоры в итоге записывают на мою работу, а не на порядок оформления.",
          en: "Recruiting does not set the terms — I would make that clear to the driver and to my lead, because these calls end up recorded as my work.",
        } },
      ],
    },
    {
      key: "hr_q03",
      text: {
        uz: "Ertaga orientatsiya boshlanadi, lekin nomzodning hujjatlar toʻplamida meditsina kartasi yoʻqligini payqadingiz. Hujjatlarni boshqa xodim yigʻgan edi. Birinchi navbatda nima qilasiz?",
        ru: "Завтра начинается ориентация, но вы заметили, что в пакете документов кандидата нет медицинской карты. Документы собирал другой сотрудник. Что вы сделаете в первую очередь?",
        en: "Orientation starts tomorrow, but you notice the candidate’s file is missing his medical card. A different employee collected the documents. What would you do first?",
      },
      options: [
        { key: "hr_q03_a", pattern: "waiting", text: {
          uz: "Hujjatni yigʻgan hamkasb ertalab keladi — bitta jildni ikki kishi aralashtirib yubormaslik uchun kartani u soʻraydi, men jadvalni shunga moslayman.",
          ru: "Коллега, собиравший документы, будет с утра — чтобы двое не путались в одной папке, карту запросит он, а я подстрою расписание под это.",
          en: "The coworker who built the file is in first thing — so two people are not digging in one folder, he requests the card and I fit the schedule around it.",
        } },
        { key: "hr_q03_b", pattern: "ownership", text: {
          uz: "Nomzodga oʻzim qoʻngʻiroq qilib, kartani bugun kechqurun suratga olib yuborishini soʻrayman — ertaga orientatsiya toʻxtab qolmasligi mening qoʻlimda.",
          ru: "Сам позвоню кандидату и попрошу вечером сфотографировать и прислать карту — чтобы ориентация завтра не встала, и это в моих руках.",
          en: "I would call the candidate myself and ask him to photograph and send the card tonight — keeping orientation on its feet tomorrow is within my reach.",
        } },
        { key: "hr_q03_c", pattern: "blame", text: {
          uz: "Cheklist qaysi qadamda uzilganini oʻzim aniqlab, kartani hujjatlarni yigʻgan hamkasb soʻraydi — oʻsha qadam nomlanmasa, keyingi guruhda ham shu takrorlanadi.",
          ru: "Сам определю, на каком шаге порвался чек-лист, а карту запросит тот, кто собирал документы: если этот шаг не назвать, повторится и в следующей группе.",
          en: "I would pin down myself which checklist step broke and have the coworker who built the file request the card — unnamed, that step repeats with the next group.",
        } },
        { key: "hr_q03_d", pattern: "builder", text: {
          uz: "Kartani soʻrayman va orientatsiyadan bir kun oldin hujjatlarni ikkinchi odam tekshiradigan nazoratni kiritaman: bu jildni tuzatish bitta ish, tartibdagi teshik doimiy.",
          ru: "Запрошу карту и введу короткую проверку документов вторым человеком за день до ориентации: в этой папке один пробел, а в порядке — постоянная дыра.",
          en: "I would request the card and add a short second-person check the day before orientation: this file has one gap, the procedure has a standing hole.",
        } },
        { key: "hr_q03_e", pattern: "complaint", text: {
          uz: "Kartani soʻrayman va shu bilan birga masalani rahbariyat oldiga qoʻyaman: hujjatlar oxirgi kunda toʻliqmas chiqishi birinchi marta emas.",
          ru: "Карту запрошу и одновременно поставлю вопрос перед руководством: неполная папка в последний день — уже не новость.",
          en: "I would request the card and at the same time put the issue to management: our document routine lets a file turn up incomplete on the last day.",
        } },
      ],
    },
    {
      key: "hr_q04",
      text: {
        uz: "Dispetcher sizga yangi haydovchi yuk boʻyicha update berish tartibini umuman bilmasligini aytdi va onbording sifatidan norozi. Birinchi navbatda nima qilasiz?",
        ru: "Диспетчер говорит вам, что новый водитель совсем не знает порядок обновлений по грузу (updates), и недоволен качеством онбординга. Что вы сделаете в первую очередь?",
        en: "A dispatcher tells you that a new driver does not know the load-update procedure at all and is unhappy with the quality of onboarding. What would you do first?",
      },
      options: [
        { key: "hr_q04_a", pattern: "victim", text: {
          uz: "Bitta holat butun onbordingga baho boʻlib qolmasligi uchun dispetcherga bu mavzu oʻtilganini koʻrsataman — aks holda oʻsha baho mening ishimga yoziladi.",
          ru: "Чтобы один случай не стал оценкой всего онбординга, покажу диспетчеру, что тема разбирается — иначе эта оценка запишется на мою работу.",
          en: "So one case does not become a verdict on all of onboarding, I would show the dispatcher the topic is covered — that verdict is recorded against my work.",
        } },
        { key: "hr_q04_b", pattern: "waiting", text: {
          uz: "Bitta holat boʻyicha materialni oʻzgartirmayman — keyingi guruhdan ham shu signal kelsa, demak muammo tizimli va shundan keyin qayta koʻraman.",
          ru: "Из-за одного случая материалы менять не буду — если тот же сигнал придёт и от следующей группы, значит проблема системная, и тогда пересмотрю.",
          en: "I would not rework the materials over one case — if the next group sends the same signal it is systemic, and that is when I would redo it.",
        } },
        { key: "hr_q04_c", pattern: "builder", text: {
          uz: "Update tartibini bir sahifalik yodnoma qilib, dispetcherlik bilan kelishib onbording materialiga kiritaman — keyingi guruhlar buni bir xil eshitadi.",
          ru: "Сделаю из порядка обновлений одностраничную памятку, согласую с диспетчерской и вложу в материалы онбординга — следующие группы услышат одно и то же.",
          en: "I would turn the procedure into a one-page sheet, agree it with dispatch and put it in the onboarding pack — then every new group hears the same thing.",
        } },
        { key: "hr_q04_d", pattern: "complaint", text: {
          uz: "Haydovchiga tushuntiraman, ammo asosiy gap boshqada: onbording kuni juda tigʻiz va kamchilik shundan chiqadi — buni yigʻilishda ochiq qoʻyaman.",
          ru: "Водителю объясню, но суть в другом: день онбординга перегружен, и пробелы идут отсюда — вынесу это на совещание.",
          en: "I would explain it to the driver, but the real point is elsewhere: the onboarding day is packed and that is where gaps come from — I would raise it at the meeting.",
        } },
        { key: "hr_q04_e", pattern: "ownership", text: {
          uz: "Bugun haydovchi bilan bogʻlanib, update tartibini oʻzim qayta tushuntiraman, bir-ikki savol bilan tushunganini tekshiraman va dispetcherga yopilganini aytaman.",
          ru: "Сегодня же свяжусь с водителем, сам заново объясню порядок обновлений, парой вопросов проверю, что он понял, и скажу диспетчеру, что вопрос закрыт.",
          en: "I would reach the driver today, walk him through the procedure again myself, check with a question or two that it landed, and tell the dispatcher it is closed.",
        } },
      ],
    },
    {
      key: "hr_q05",
      text: {
        uz: "Kuchli nomzod hamma bosqichdan oʻtdi, hujjatlari tayyor edi — lekin u toʻsatdan javob bermay qoʻydi. Reja boʻyicha u keyingi haftadan ishga chiqishi kerak edi. Birinchi navbatda nima qilasiz?",
        ru: "Сильный кандидат прошёл все этапы, документы были готовы — но он внезапно перестал отвечать. По плану он должен был выйти со следующей недели. Что вы сделаете в первую очередь?",
        en: "A strong candidate passed every step and his documents were ready — but he suddenly stopped responding. He was supposed to start next week. What would you do first?",
      },
      options: [
        { key: "hr_q05_a", pattern: "ownership", text: {
          uz: "Bugun boshqa vaqtda va boshqa kanaldan yana urinaman, qisqa xabar qoldiraman va oʻrin boʻsh qolmasligi uchun zaxira variantni oʻzim harakatga keltiraman.",
          ru: "Сегодня попробую ещё раз в другое время и по другому каналу, оставлю короткое сообщение и сам запущу резервный вариант, чтобы место не простаивало.",
          en: "I would try again today at another hour through another channel, leave a short message, and start the backup option myself so the seat does not sit empty.",
        } },
        { key: "hr_q05_b", pattern: "victim", text: {
          uz: "Nomzod hamma bosqichdan oʻtgan, hujjatlari tayyor edi — buni hozirdan yozib qoʻyaman, chunki reja bajarilmasa, savol birinchi menga keladi.",
          ru: "Кандидат прошёл все этапы, документы были готовы — зафиксирую это сейчас: если план не выполнится, вопрос придёт сначала ко мне.",
          en: "The candidate cleared every step with his papers ready — I would put that on record now, because if the plan comes short the question reaches me first.",
        } },
        { key: "hr_q05_c", pattern: "waiting", text: {
          uz: "Bosim qilmayman — bunday paytda ketma-ket qoʻngʻiroq nomzodni butunlay yoʻqotadi; ishga chiqish sanasigacha bitta xabar qoldirib, javobini kutaman.",
          ru: "Давить не стану — звонки один за другим в такой момент теряют кандидата совсем; оставлю одно сообщение и до даты выхода дам ему ответить самому.",
          en: "I would not push — back-to-back calls at this point lose a candidate for good; I would leave one message and let his answer come before his start date.",
        } },
        { key: "hr_q05_d", pattern: "builder", text: {
          uz: "Zaxira nomzodni tayyorlayman va «hujjat tayyor — ishga chiqish» oraligʻida muntazam aloqa rejasini joriy qilaman: nomzodlar aynan shu oraliqda yoʻqoladi.",
          ru: "Подготовлю резервного кандидата и налажу план регулярных контактов на отрезке «документы готовы — выход»: кандидаты теряются именно здесь.",
          en: "I would prepare a backup and set up a regular contact plan for the “papers ready to start date” stretch — that is exactly where candidates disappear.",
        } },
        { key: "hr_q05_e", pattern: "blame", text: {
          uz: "Uning fayli keyingi bosqichda kim bilan ishlaganini koʻraman — muomala yoki hujjat kechikishi sabab boʻlgan boʻlsa, gapni oʻsha bosqich bilan qilamiz.",
          ru: "Посмотрю, с кем его файл работал на следующем этапе — если причина в тоне разговора или в задержке документов, разговаривать надо с тем этапом.",
          en: "I would look at who handled his file at the next step — if the tone or a paperwork delay caused it, that step is where the conversation belongs.",
        } },
      ],
    },
    {
      key: "hr_q06",
      text: {
        uz: "Ishga kirganiga ikki hafta boʻlgan haydovchi qoʻngʻiroq qilib, unga vaʼda qilingan yangi treyler oʻrniga eski treyler berilganini aytdi va ketishga tayyorligini bildirdi. Birinchi navbatda nima qilasiz?",
        ru: "Водитель, работающий две недели, звонит и говорит, что вместо обещанного нового трейлера ему дали старый, и он готов уволиться. Что вы сделаете в первую очередь?",
        en: "A driver two weeks in calls and says he was given an old trailer instead of the new one he was promised, and he is ready to quit. What would you do first?",
      },
      options: [
        { key: "hr_q06_a", pattern: "waiting", text: {
          uz: "Treylerni almashtirish qarori treyler boʻlimida — ularning javobisiz variant aytmayman; haydovchiga aniq muddat aytish uchun aynan shu javob kerak.",
          ru: "Решение о замене трейлера — за трейлерным отделом; без их ответа вариантов называть не буду: именно он нужен, чтобы дать водителю точный срок.",
          en: "Swapping a trailer is the Trailer Department’s call — I would name no option before their answer, since a firm date for the driver depends on it.",
        } },
        { key: "hr_q06_b", pattern: "blame", text: {
          uz: "Unga «yangi treyler» degan gap qaysi bosqichda aytilganini aniqlaymiz — vaʼda qayerda berilgan boʻlsa, javob ham oʻsha yerdan kelishi kerak.",
          ru: "Выясним, на каком этапе ему сказали про «новый трейлер» — где было дано обещание, оттуда должен прийти и ответ.",
          en: "We would establish at which step the words “a new trailer” were said — the answer has to come from wherever the promise was made.",
        } },
        { key: "hr_q06_c", pattern: "ownership", text: {
          uz: "Haydovchini tinchlantirib, bugunoq treyler boʻlimi bilan oʻzim gaplashaman va real holatni — nima mumkin, nima yoʻqligini — unga ochiq aytaman.",
          ru: "Успокою водителя, сегодня же сам поговорю с трейлерным отделом и честно расскажу ему реальную картину: что возможно, а что нет.",
          en: "I would settle the driver down, talk to the Trailer Department myself today, and give him the real picture — what is possible and what is not.",
        } },
        { key: "hr_q06_d", pattern: "complaint", text: {
          uz: "Masalani yopishga harakat qilaman — va uskuna vaʼdalari bilan real imkoniyat orasidagi farqni rahbariyat oldida yana bir bor ochiq qoʻyaman.",
          ru: "Постараюсь закрыть вопрос — и снова открыто поставлю перед руководством разрыв между обещаниями по технике и реальными возможностями.",
          en: "I would try to close the case — and put the gap between equipment promises and real capacity to management once again, as a leading reason drivers leave.",
        } },
        { key: "hr_q06_e", pattern: "builder", text: {
          uz: "Uskuna boʻyicha vaʼdalar faqat treyler boʻlimining yozma tasdigʻi bilan berilishini yoʻlga qoʻyaman — bu suhbatni osonlashtirmaydi, lekin keyingi oʻntasini oldini oladi.",
          ru: "Введу правило: обещания по технике даются только с письменным подтверждением трейлерного отдела — этот разговор легче не станет, но следующие десять не случатся.",
          en: "I would make it the rule that equipment promises need the Trailer Department’s written confirmation — it will not ease this call, but it prevents the next ten.",
        } },
      ],
    },
    {
      key: "hr_q07",
      text: {
        uz: "Siz orientatsiya materiallaridagi bir nechta qoida allaqachon eskirganini payqadingiz — yangi haydovchilar keyin shu mavzularda qayta-qayta chalkashmoqda. Birinchi navbatda nima qilasiz?",
        ru: "Вы заметили, что несколько правил в материалах ориентации уже устарели — новые водители потом раз за разом путаются в этих темах. Что вы сделаете в первую очередь?",
        en: "You notice that several rules in the orientation materials are outdated — new drivers keep getting confused about those topics later. What would you do first?",
      },
      options: [
        { key: "hr_q07_a", pattern: "builder", text: {
          uz: "Eskirgan joylarni roʻyxatga olib, boʻlimlardan aniq matnni soʻrayman va materiallarni har chorakda koʻrib chiqishni yoʻlga qoʻyaman: bitta tahrir yetmaydi.",
          ru: "Составлю список устаревших мест, запрошу у отделов точные формулировки и налажу пересмотр материалов раз в квартал: от одной правки документ снова устареет.",
          en: "I would list the stale sections, get exact wording from the departments and set up a quarterly review — one edit and the document just goes stale again.",
        } },
        { key: "hr_q07_b", pattern: "victim", text: {
          uz: "Kamchiliklarni koʻryapman, lekin materiallarni yangilash mening vazifamda emas — shuni rahbar bilan oldin kelishib olaman, keyin orientatsiyani oʻtkazaman.",
          ru: "Пробелы я вижу, но обновление материалов не моя задача — сначала проясню это с руководителем, а потом проведу ориентацию.",
          en: "I can see the gaps, but updating the materials is not my remit — I would settle that with my lead first and then run the orientation.",
        } },
        { key: "hr_q07_c", pattern: "complaint", text: {
          uz: "Rahbariyat oldida ochiq qoʻyaman: materiallar necha yildan beri yangilanmagan va bu bitta odamning boʻsh vaqtiga tashlab qoʻyilgan ish emas — masʼul va vaqt ajratilishi kerak.",
          ru: "Открыто поставлю вопрос перед руководством: материалы годами не обновлялись, и это не работа на чьё-то свободное время — нужен ответственный и выделенное время.",
          en: "I would put it openly to management: the materials have gone years without an update, and this is not spare-time work — it needs an owner and real time.",
        } },
        { key: "hr_q07_d", pattern: "ownership", text: {
          uz: "Eng koʻp chalkashlik keltirayotgan ikki-uch boʻlimni bugunoq oʻzim toʻgʻrilab, keyingi orientatsiyadan yangilangan variantda ishlayman.",
          ru: "Сегодня же сам поправлю два-три раздела, которые путают больше всего, и со следующей ориентации буду работать по обновлённой версии.",
          en: "I would fix the two or three sections that confuse people most myself today and run the next orientation from the updated version.",
        } },
        { key: "hr_q07_e", pattern: "blame", text: {
          uz: "Bu materiallar kimga biriktirilganini aniqlab, yangilashni oʻsha odam bilan birga qilamiz — hujjatni yon tomondan tuzatsam, keyingi safar yana eskirib qoladi.",
          ru: "Выясню, за кем закреплены эти материалы, и обновлять будем вместе с ним: правя документ со стороны, я лишь оставлю его снова устаревать.",
          en: "I would find out who these materials are assigned to and do the update with that person — patched from the side, it is left to go stale again.",
        } },
      ],
    },
    {
      key: "hr_q08",
      text: {
        uz: "Nomzod sizga bir xil savollarga uch marta javob berganidan noroziligini aytdi: siz, keyin xavfsizlik boʻlimi, keyin yana boshqa xodim — har biri xuddi shu maʼlumotni qaytadan soʻragan. Birinchi navbatda nima qilasiz?",
        ru: "Кандидат жалуется, что трижды отвечал на одни и те же вопросы: вы, затем отдел безопасности, затем ещё один сотрудник — каждый заново спрашивал одно и то же. Что вы сделаете в первую очередь?",
        en: "A candidate complains he has answered the same questions three times: you, then Safety, then another employee — each asked for the same information all over again. What would you do first?",
      },
      options: [
        { key: "hr_q08_a", pattern: "complaint", text: {
          uz: "Nomzoddan uzr soʻrayman, keyin masalani boʻlim rahbarlari oldida qoʻyaman: yagona hujjat yoʻqligi har bir nomzodda shunday takrorlanadi.",
          ru: "Извинюсь перед кандидатом, а затем поставлю вопрос перед руководителями отделов: без единого документа это повторяется на каждом кандидате.",
          en: "I would apologize to the candidate, then put the issue to the department leads: with no shared document this repeats on every candidate.",
        } },
        { key: "hr_q08_b", pattern: "victim", text: {
          uz: "Nomzoddan uzr soʻrayman, lekin jarayonning bu qismi menda emas — nomzodning taassuroti mening ishim deb oʻqilmasligi uchun buni oydinlashtirib qoʻyaman.",
          ru: "Извинюсь перед кандидатом, но эта часть процесса не моя — проясню это с руководителем, чтобы впечатление кандидата не читали как качество моей работы.",
          en: "I would apologize to the candidate, but that part of the flow is not mine — I would get that clear so his impression is not read as my work.",
        } },
        { key: "hr_q08_c", pattern: "ownership", text: {
          uz: "Uzr soʻrab, uning maʼlumotlarini oʻzim bitta hujjatga jamlayman va keyingi bosqich xodimiga toʻliq holda uzataman — qayta soʻralmasligi shu bilan hal boʻladi.",
          ru: "Извинюсь, сам соберу его данные в один документ и передам следующему сотруднику в полном виде — переспрашивать больше не придётся.",
          en: "I would apologize, gather his details into one document myself and hand it to the next step in full — that ends the re-asking.",
        } },
        { key: "hr_q08_d", pattern: "builder", text: {
          uz: "Xavfsizlik boʻlimi bilan bosqichlar orasida toʻldiriladigan bitta qisqa forma kelishib olaman — bu nomzodga yordam bermaydi, lekin takrorlanish toʻxtaydi.",
          ru: "Согласую с отделом безопасности одну короткую форму передачи кандидата между этапами — этому кандидату это не поможет, но повторение прекратится.",
          en: "I would agree one short handoff form with Safety for moving a candidate between steps — it does not help this candidate, but the repetition stops.",
        } },
        { key: "hr_q08_e", pattern: "blame", text: {
          uz: "Savollar qaysi bosqichda takrorlanganini aniqlayman — biz yigʻgan maʼlumot keyingi boʻlimga yetib bormagan boʻlsa, oʻsha uzilishni ular yopishi kerak.",
          ru: "Определю, на каком этапе вопросы продублировались: если собранные нами данные не дошли до следующего отдела, закрывать этот разрыв им.",
          en: "I would pin down at which step the questions doubled — if what we collected never reached the next department, they are the ones to close that break.",
        } },
      ],
    },
    {
      key: "hr_q09",
      text: {
        uz: "Ikki oy ishlagan haydovchi siz bilan yaxshi munosabatda boʻlgani uchun aynan sizga qoʻngʻiroq qilib, dispetcheri bilan kelisha olmayotganini va shu sabab ketish haqida oʻylayotganini aytdi. Bu sizning boʻlimingizga tegishli masala emas. Birinchi navbatda nima qilasiz?",
        ru: "Водитель, отработавший два месяца, звонит именно вам, потому что у вас хорошие отношения, и говорит, что не может сработаться со своим диспетчером и подумывает уйти. Это не вопрос вашего отдела. Что вы сделаете в первую очередь?",
        en: "A driver two months in calls you specifically because you have a good relationship, and says he cannot get along with his dispatcher and is thinking about leaving. This is not your department’s issue. What would you do first?",
      },
      options: [
        { key: "hr_q09_a", pattern: "waiting", text: {
          uz: "Haydovchini tinglayman, lekin uning oʻrniga gapirmayman — rasmiy tartibda murojaat qilsa, masala hujjat bilan yuradi; oradan aralashsam, ikkita versiya paydo boʻladi.",
          ru: "Водителя выслушаю, но говорить за него не буду: если он обратится по официальной линии, вопрос пойдёт документально; вмешаюсь посередине — появятся две версии.",
          en: "I would hear him out but not speak for him — raised through the official channel the case moves on paper; stepping in between creates two versions of it.",
        } },
        { key: "hr_q09_b", pattern: "builder", text: {
          uz: "Roziligini olib mohiyatni dispetcherlik rahbariga yetkazaman, keyin yangi haydovchilar bilan ikkinchi oy suhbatini doimiy qadam qilaman.",
          ru: "С его согласия передам суть руководителю диспетчерской, а затем сделаю постоянным шагом беседу с новыми водителями на втором месяце.",
          en: "With his consent I would pass the substance to the dispatch lead, then make a second-month talk with new drivers a standing step.",
        } },
        { key: "hr_q09_c", pattern: "blame", text: {
          uz: "Bu dispetcher boʻyicha shunday gaplar oldin ham boʻlgan — holatni uning rahbariga aniq koʻrsataman, tuzatish oʻsha yerda boʻlmasa, keyingi haydovchi ham shu bilan keladi.",
          ru: "По этому диспетчеру такое говорили и раньше — покажу картину его руководителю: пока не исправят там, следующий водитель придёт с тем же.",
          en: "There have been remarks about this dispatcher before — I would lay the case out for his lead; uncorrected there, the next driver arrives with the same thing.",
        } },
        { key: "hr_q09_d", pattern: "ownership", text: {
          uz: "Haydovchini toʻliq tinglab, roziligini olib, fikrini dispetcherlik rahbariga bugunoq oʻzim yetkazaman va bir hafta oʻtib undan ahvolni soʻrab qoʻyaman.",
          ru: "Полностью выслушаю водителя, с его согласия сегодня же сам донесу его позицию руководителю диспетчерской и через неделю спрошу у него, как дела.",
          en: "I would hear the driver out fully, with his consent carry his view to the dispatch lead myself today, and check back with him in a week.",
        } },
        { key: "hr_q09_e", pattern: "complaint", text: {
          uz: "Haydovchiga hamdardlik bildiraman va rahbariyatga aytaman: dispetcher-haydovchi munosabati boʻyicha bunday qoʻngʻiroq tez-tez keladi — bu alohida holat emas.",
          ru: "Посочувствую водителю и скажу руководству: звонки про отношения диспетчера и водителя приходят регулярно — это не отдельный случай.",
          en: "I would sympathize with the driver and tell management calls about dispatcher–driver relations come in regularly — this is not an isolated case.",
        } },
      ],
    },
    {
      key: "hr_q10",
      text: {
        uz: "Bu oy ishga olish rejasi bajarilmayapti: eʼlonlardan kelayotgan nomzodlarning aksariyati talabga javob bermaydi. Rahbariyat natijani soʻramoqda. Birinchi navbatda nima qilasiz?",
        ru: "План найма в этом месяце не выполняется: большинство кандидатов с объявлений не подходят по требованиям. Руководство спрашивает о результатах. Что вы сделаете в первую очередь?",
        en: "This month’s hiring plan is falling short: most candidates coming from the ads do not meet requirements. Management is asking about results. What would you do first?",
      },
      options: [
        { key: "hr_q10_a", pattern: "victim", text: {
          uz: "Reja tuzilganda bozor holati ham, byudjet ham men bilan kelishilmagan edi — natija muhokama qilinganda men birinchi shuni oʻrtaga qoʻyaman.",
          ru: "Ни состояние рынка, ни бюджет со мной не согласовывали, когда ставили план — обсуждая результат, я начну именно с этого и покажу свои реальные возможности.",
          en: "Neither market conditions nor the budget were agreed with me when the plan was set — that is what I would put on the table first when results are discussed.",
        } },
        { key: "hr_q10_b", pattern: "complaint", text: {
          uz: "Rahbariyatga eʼlon byudjeti va platformalar eskirganini, raqobatchilar koʻproq toʻlayotganini ochiq aytaman — bu qaror menda emas, lekin oqim sifati shunga bogʻliq.",
          ru: "Открыто скажу руководству, что бюджет и площадки объявлений устарели, а конкуренты платят больше: это решение не на моём уровне, но качество потока зависит именно от него.",
          en: "I would tell management openly that the ad budget and platforms are outdated while competitors pay more — that decision is not mine, yet the flow depends on it.",
        } },
        { key: "hr_q10_c", pattern: "ownership", text: {
          uz: "Soʻnggi ellikta lidni oʻzim koʻrib chiqib, qaysi manba va qaysi eʼlon matni sifatli nomzod berayotganini aniqlayman va kuchimni shu kanallarga qarataman.",
          ru: "Сам разберу последние пятьдесят лидов, определю, какие источники и какие тексты объявлений дают качественных кандидатов, и сосредоточусь на этих каналах.",
          en: "I would go through the last fifty leads myself, work out which source and which ad copy bring qualified candidates, and put my effort into those channels.",
        } },
        { key: "hr_q10_d", pattern: "waiting", text: {
          uz: "Bozor mavsumiy oʻzgaradi — ikki haftalik oqimni bir xil sharoitda oʻlchab olaman va kanalni faqat shundan keyin oʻzgartiraman, aks holda nimasi ishlaganini bilmaymiz.",
          ru: "Рынок меняется по сезону — две недели измерю поток в одинаковых условиях и только потом сменю канал, иначе так и не поймём, что именно сработало.",
          en: "The market moves with the season — I would measure two weeks of flow under the same conditions and change channels only then, or we never learn what worked.",
        } },
        { key: "hr_q10_e", pattern: "builder", text: {
          uz: "Eʼlon matnida talablarni aniqroq yozib, manbalar boʻyicha haftalik oʻlchov jadvalini kiritaman: bu oy raqamini koʻtarmaydi, keyingi oylarda esa taxmin qolmaydi.",
          ru: "Пропишу требования в объявлениях чётче и налажу еженедельный замер по источникам: цифру этого месяца это не поднимет, зато дальше догадок не останется.",
          en: "I would state the requirements more precisely in the ads and set up a weekly measurement by source — it will not lift this month’s number, but guesswork ends.",
        } },
      ],
    },
  ],
};
