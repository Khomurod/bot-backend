/**
 * SOS assessment content — HR / Recruiting department (10 questions).
 *
 * Scope: driver recruiting, candidate communication, onboarding, orientation,
 * missing driver documents, driver expectations/complaints/relationships,
 * candidate no-shows, recruiting handoffs, retention communication.
 *
 * Authoring rules (see tests/sosContent.test.js):
 *  - every question offers 5 plausible options mapped to 5 of the 6 patterns;
 *  - no option is obviously "correct", careless, or ridiculous;
 *  - the strongest QBQ option varies in position and length;
 *  - options never encourage skipping required documents or process controls.
 */

module.exports = {
  department: "hr",
  questions: [
    {
      key: "hr_q01",
      text: {
        uz: "Nomzod haydovchi kecha orientatsiyaga kelishini tasdiqlagan edi, lekin bugun kelmadi va telefonini koʻtarmayapti. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Кандидат-водитель вчера подтвердил, что придёт на ориентацию, но сегодня не пришёл и не берёт трубку. Что вы, скорее всего, сделаете в первую очередь?",
        en: "A driver candidate confirmed yesterday that he would come to orientation, but today he did not show up and is not answering his phone. What would you most likely do first?",
      },
      options: [
        { key: "hr_q01_a", pattern: "complaint", text: {
          uz: "Hamkasblarga bu haftada nechanchi nomzod soʻnggi daqiqada gʻoyib boʻlayotganini aytaman — bunday nomzodlar bilan reja qilish juda qiyin.",
          ru: "Скажу коллегам, что это уже который кандидат за неделю пропадает в последний момент — с такими кандидатами очень трудно что-то планировать.",
          en: "Tell my coworkers this is yet another candidate this week who vanished at the last minute — it is really hard to plan anything with candidates like these.",
        } },
        { key: "hr_q01_b", pattern: "ownership", text: {
          uz: "Boshqa raqamlar va messenjer orqali yozib koʻraman, soʻng zaxira nomzodlar roʻyxatini ochib, boʻsh qolgan oʻrin uchun keyingi qadamni bugunoq belgilayman.",
          ru: "Попробую написать через мессенджер и другие номера, затем открою резервный список кандидатов и уже сегодня определю следующий шаг по освободившемуся месту.",
          en: "Try reaching him by text and any other numbers, then open my backup candidate list and decide today what the next step is for the open spot.",
        } },
        { key: "hr_q01_c", pattern: "waiting", text: {
          uz: "Balki yoʻlda muammo boʻlgandir — kun oxirigacha kutaman: oʻzi bogʻlanmasa, ertaga qayta urinib koʻraman.",
          ru: "Возможно, что-то случилось в дороге — подожду до конца дня: если сам не выйдет на связь, попробую снова завтра.",
          en: "Maybe something happened on the road — I will wait until the end of the day, and if he does not reach out himself, I will try again tomorrow.",
        } },
        { key: "hr_q01_d", pattern: "victim", text: {
          uz: "Nega aynan mening nomzodlarim shunday qiladi, deb oʻylayman — qancha vaqt sarflaymanu, oxirida hammasi bekor ketadi.",
          ru: "Подумаю: почему именно с моими кандидатами так происходит — столько времени вкладываю, а в итоге всё впустую.",
          en: "Wonder why this keeps happening with my candidates in particular — I put in so much time and it all ends up wasted.",
        } },
        { key: "hr_q01_e", pattern: "builder", text: {
          uz: "Nomzodga xabar qoldiraman, oʻrniga zaxiradagi nomzodni chaqiraman, soʻng kelgusida no-show kamayishi uchun orientatsiyadan bir kun oldin qoʻshimcha eslatma qoʻngʻirogʻini jarayonga kiritaman.",
          ru: "Оставлю кандидату сообщение, приглашу резервного кандидата, а затем добавлю в процесс дополнительный напоминающий звонок за день до ориентации, чтобы таких неявок стало меньше.",
          en: "Leave the candidate a message, call in a backup candidate, and then add an extra reminder call one day before orientation to our process so no-shows become less frequent.",
        } },
      ],
    },
    {
      key: "hr_q02",
      text: {
        uz: "Birinchi haftasini ishlayotgan haydovchi sizga qoʻngʻiroq qilib, unga vaʼda qilingan shartlar (masalan, mil narxi) haqiqatga toʻgʻri kelmayotganini aytmoqda va jahli chiqqan. Birinchi navbatda nima qilasiz?",
        ru: "Водитель, работающий первую неделю, звонит вам и возмущается: условия, которые ему обещали (например, ставка за милю), не совпадают с реальностью. Что вы сделаете в первую очередь?",
        en: "A driver in his first week calls you upset: the terms he was promised (for example, the per-mile rate) do not match reality. What would you do first?",
      },
      options: [
        { key: "hr_q02_a", pattern: "blame", text: {
          uz: "Avval uni kim ishga olganini va unga aynan nima deyilganini aniqlayman — bu chalkashlikka yoʻl qoʻygan odam masalani oʻzi hal qilishi kerak.",
          ru: "Сначала выясню, кто его нанимал и что именно ему говорили — тот, кто допустил эту путаницу, и должен разбираться.",
          en: "First find out who hired him and what exactly he was told — the person who created this confusion should be the one to sort it out.",
        } },
        { key: "hr_q02_b", pattern: "builder", text: {
          uz: "Haydovchini tinglayman, hujjatdagi shartlarni birga koʻrib chiqaman va masalani yopgach, kelgusida shartlar yozma ravishda, bir xil shablonda yuborilishini taklif qilaman.",
          ru: "Выслушаю водителя, вместе сверим условия по документам, а после решения вопроса предложу, чтобы условия всегда отправлялись письменно по единому шаблону.",
          en: "Listen to the driver, go over the documented terms together, and once it is resolved, propose that terms always be sent in writing using one standard template going forward.",
        } },
        { key: "hr_q02_c", pattern: "waiting", text: {
          uz: "Bu masala boʻyicha oʻzim bir narsa deyishdan oldin rahbarim yoki buxgalteriya aniq javob berguncha kutishni maʼqul koʻraman — notoʻgʻri gap aytib qoʻymaslik uchun.",
          ru: "Предпочту подождать, пока руководитель или бухгалтерия дадут точный ответ, прежде чем что-то говорить самому — чтобы не сказать лишнего.",
          en: "Prefer to wait until my manager or accounting gives an exact answer before saying anything myself — so I do not tell him something wrong.",
        } },
        { key: "hr_q02_d", pattern: "ownership", text: {
          uz: "Hoziroq uning offerini va shartnomasini ochib, haydovchi bilan band-band solishtiraman: qayerda tafovut borligini oʻzim aniqlab, bugun unga aniq javob beraman.",
          ru: "Сразу открою его оффер и договор и вместе с водителем сверю пункт за пунктом: сам найду, где расхождение, и сегодня же дам ему конкретный ответ.",
          en: "Pull up his offer and contract right away and compare them point by point with the driver: find where the gap is myself and give him a concrete answer today.",
        } },
        { key: "hr_q02_e", pattern: "victim", text: {
          uz: "Yana rekruterlar aybdor boʻlib qoldik, deb oʻylayman — shartlarni biz belgilamaymiz, lekin nima uchundir haydovchining gʻazabi doim bizga tushadi.",
          ru: "Подумаю: опять крайними оказались рекрутеры — условия ведь определяем не мы, но злость водителя почему-то всегда достаётся нам.",
          en: "Think that recruiters ended up being the fall guys again — we do not set the terms, yet somehow the driver’s anger always lands on us.",
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
          uz: "Hujjatlarni yiggʻan hamkasb ertalab ishga kelganda oʻzi toʻldirsin — uning vazifasini men qilib qoʻysam, keyin doim menga qolib ketadi.",
          ru: "Пусть коллега, который собирал документы, сам дособерёт утром — если я сделаю его работу, потом это всегда будет на мне.",
          en: "Let the coworker who collected the documents complete them in the morning — if I do his work now, it will always end up on my plate.",
        } },
        { key: "hr_q03_b", pattern: "ownership", text: {
          uz: "Hoziroq nomzodga qoʻngʻiroq qilib, kartani bugun kechqurun rasm qilib yuborishini soʻrayman — ertaga orientatsiya toʻxtab qolmasligi uchun oʻzim hal qilaman.",
          ru: "Прямо сейчас позвоню кандидату и попрошу сфотографировать и прислать карту сегодня вечером — сам решу вопрос, чтобы завтра ориентация не сорвалась.",
          en: "Call the candidate right now and ask him to photograph and send the card tonight — handle it myself so orientation does not stall tomorrow.",
        } },
        { key: "hr_q03_c", pattern: "blame", text: {
          uz: "Avval rahbarga hujjatlarni kim yigʻganini va cheklist nima uchun bajarilmaganini yozib qoʻyaman — har kim oʻz kamchiligiga javob berishi kerak.",
          ru: "Сначала напишу руководителю, кто собирал документы и почему не был выполнен чек-лист — каждый должен отвечать за свои упущения.",
          en: "First write to the manager about who collected the documents and why the checklist was not followed — everyone should answer for their own misses.",
        } },
        { key: "hr_q03_d", pattern: "builder", text: {
          uz: "Nomzoddan kartani soʻrayman, hamkasbni xolis ogohlantiraman va orientatsiyadan bir kun oldin hujjatlarni ikki kishi tekshiradigan qisqa nazorat bosqichini taklif qilaman.",
          ru: "Запрошу карту у кандидата, спокойно предупрежу коллегу и предложу ввести короткую проверку документов вторым человеком за день до ориентации.",
          en: "Request the card from the candidate, give the coworker a calm heads-up, and suggest a short second-person document check one day before each orientation.",
        } },
        { key: "hr_q03_e", pattern: "complaint", text: {
          uz: "Ichimda «yana oxirgi kunda hammasi mening boʻynimga tushdi» deb norozi boʻlaman — hujjatlar bilan har safar shu ahvol takrorlanadi.",
          ru: "Про себя возмущусь: «опять всё всплыло в последний день и легло на меня» — с документами каждый раз одна и та же история.",
          en: "Grumble to myself that “once again everything surfaced on the last day and landed on me” — it is the same story with documents every time.",
        } },
      ],
    },
    {
      key: "hr_q04",
      text: {
        uz: "Dispetcher sizga yangi haydovchi yuk boʻyicha yangilanish (update) tartibini umuman bilmasligini aytdi va onbording sifatidan norozi. Birinchi navbatda nima qilasiz?",
        ru: "Диспетчер говорит вам, что новый водитель совсем не знает порядок обновлений по грузу (updates), и недоволен качеством онбординга. Что вы сделаете в первую очередь?",
        en: "A dispatcher tells you that a new driver does not know the load-update procedure at all and is unhappy with the quality of onboarding. What would you do first?",
      },
      options: [
        { key: "hr_q04_a", pattern: "victim", text: {
          uz: "Onbordingda oʻttiz mavzuni oʻtamiz, hammasini eslab qolish haydovchining ishi — nima boʻlsa, baribir HR aybdor boʻlib chiqaveradi, deb oʻylayman.",
          ru: "Подумаю: на онбординге мы разбираем десятки тем, запомнить их — задача водителя, но что бы ни случилось, виноватым всё равно делают HR.",
          en: "Think that we cover dozens of topics in onboarding and remembering them is the driver’s job — yet whatever happens, HR always ends up being blamed.",
        } },
        { key: "hr_q04_b", pattern: "waiting", text: {
          uz: "Bu bitta holatmi yoki tizimli muammomi — bilish uchun yana bir-ikki shunday signal kelguncha kuzataman, keyin xulosa chiqaraman.",
          ru: "Понаблюдаю: единичный это случай или системная проблема — дождусь ещё одного-двух таких сигналов и тогда сделаю выводы.",
          en: "Watch to see whether this is a one-off or a systemic problem — wait for one or two more signals like this and then draw conclusions.",
        } },
        { key: "hr_q04_c", pattern: "builder", text: {
          uz: "Haydovchiga update tartibini qisqa qilib qayta tushuntiraman, soʻng onbording materialiga bir sahifalik yodnoma qoʻshib, dispetcher bilan birga uni kelgusi guruhlar uchun ham tasdiqlab olaman.",
          ru: "Коротко заново объясню водителю порядок обновлений, затем добавлю в материалы онбординга одностраничную памятку и согласую её с диспетчером для следующих групп.",
          en: "Briefly re-explain the update procedure to the driver, then add a one-page cheat sheet to the onboarding materials and confirm it with dispatch for future groups as well.",
        } },
        { key: "hr_q04_d", pattern: "complaint", text: {
          uz: "Dispetcherga onbording kunlari juda tigʻiz ekanini, bitta xodim hamma narsani ulgurtira olmasligini tushuntiraman — sharoitga qarab ish qilamiz-da.",
          ru: "Объясню диспетчеру, что дни онбординга перегружены и один сотрудник физически не успевает всё, — работаем как позволяют условия.",
          en: "Explain to the dispatcher that onboarding days are overloaded and one employee physically cannot cover everything — we work with the conditions we have.",
        } },
        { key: "hr_q04_e", pattern: "ownership", text: {
          uz: "Bugunoq haydovchi bilan bogʻlanib, update tartibini oʻzim qayta tushuntiraman va tushunganini qisqa savollar bilan tekshirib olaman.",
          ru: "Сегодня же свяжусь с водителем, сам заново объясню порядок обновлений и парой коротких вопросов проверю, что он понял.",
          en: "Contact the driver today, re-explain the update procedure myself, and check with a couple of quick questions that he understood.",
        } },
      ],
    },
    {
      key: "hr_q05",
      text: {
        uz: "Kuchli nomzod hamma bosqichdan oʻtdi, hujjatlar tayyor edi — lekin u toʻsatdan javob bermay qoʻydi. Reja boʻyicha u keyingi haftadan ishga chiqishi kerak edi. Birinchi navbatda nima qilasiz?",
        ru: "Сильный кандидат прошёл все этапы, документы были готовы — но он внезапно перестал отвечать. По плану он должен был выйти со следующей недели. Что вы сделаете в первую очередь?",
        en: "A strong candidate passed every step and his documents were ready — but he suddenly stopped responding. He was supposed to start next week. What would you do first?",
      },
      options: [
        { key: "hr_q05_a", pattern: "ownership", text: {
          uz: "Bugun boshqa vaqtda va boshqa kanal orqali yana urinib koʻraman, qisqa va samimiy xabar qoldiraman, shu bilan birga oʻrin boʻsh qolmasligi uchun zaxira variantni harakatga keltiraman.",
          ru: "Сегодня попробую ещё раз в другое время и по другому каналу, оставлю короткое доброжелательное сообщение и параллельно запущу резервный вариант, чтобы место не простаивало.",
          en: "Try again today at a different time through a different channel, leave a short friendly message, and at the same time activate a backup option so the spot does not sit empty.",
        } },
        { key: "hr_q05_b", pattern: "victim", text: {
          uz: "Shuncha mehnatdan keyin nomzodlar shunchaki gʻoyib boʻlishi menga juda alam qiladi — bizning mehnatimiz ularga hech narsa emasdek.",
          ru: "Мне обидно, что после стольких усилий кандидаты просто исчезают — как будто наш труд для них ничего не значит.",
          en: "It stings that after so much effort candidates simply vanish — as if our work means nothing to them.",
        } },
        { key: "hr_q05_c", pattern: "waiting", text: {
          uz: "Balki oilaviy ishlari chiqib qolgandir — bosim qilmay, ishga chiqish sanasigacha oʻzi bogʻlanishini kutaman.",
          ru: "Возможно, у него семейные обстоятельства — не буду давить и подожду до даты выхода: вдруг сам объявится.",
          en: "Maybe he has family circumstances — I will not push and will wait until his start date in case he reaches out himself.",
        } },
        { key: "hr_q05_d", pattern: "builder", text: {
          uz: "Yana bir-ikki kanaldan urinaman, zaxira nomzodni tayyorlayman va shu bilan birga «hujjat tayyor — ishga chiqquncha» oraliqda nomzod bilan muntazam aloqa rejasini joriy qilishni taklif qilaman.",
          ru: "Попробую ещё пару каналов, подготовлю резервного кандидата и заодно предложу ввести план регулярных контактов с кандидатом на отрезке «документы готовы — выход на работу».",
          en: "Try a couple more channels, prepare a backup candidate, and also propose a regular check-in plan for candidates during the “documents ready to start date” window.",
        } },
        { key: "hr_q05_e", pattern: "blame", text: {
          uz: "Avval uning fayli boʻyicha kim bilan ishlaganini koʻrib chiqaman — balki keyingi bosqichda kimdir qoʻpol muomala qilgan yoki hujjatlarini kechiktirgandir; sabab oʻsha yerdan chiqadi.",
          ru: "Сначала посмотрю, кто ещё работал с его файлом — возможно, на следующем этапе кто-то был резок или затянул с документами; причина наверняка там.",
          en: "First review who else handled his file — maybe someone at the next step was rough with him or delayed his paperwork; the cause is probably there.",
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
          uz: "Treyler masalasi treyler boʻlimida hal boʻladi — ular javob berguncha haydovchidan biroz sabr soʻrayman, aniq maʼlumotsiz vaʼda bermayman.",
          ru: "Вопрос трейлеров решается в трейлерном отделе — попрошу водителя немного подождать их ответа и не буду ничего обещать без точной информации.",
          en: "Trailer questions are decided by the Trailer Department — I will ask the driver for a little patience until they answer and will not promise anything without exact information.",
        } },
        { key: "hr_q06_b", pattern: "blame", text: {
          uz: "Kim unga «yangi treyler» deb vaʼda berganini aniqlayman — asossiz vaʼda bergan odam endi haydovchining oldida oʻzi javob bersin.",
          ru: "Выясню, кто пообещал ему «новый трейлер» — пусть тот, кто дал необоснованное обещание, сам и объясняется с водителем.",
          en: "Find out who promised him a “new trailer” — the person who made an unfounded promise should be the one to face the driver.",
        } },
        { key: "hr_q06_c", pattern: "ownership", text: {
          uz: "Haydovchini tinchlantirib, bugunoq treyler boʻlimi bilan oʻzim gaplashaman va unga aniq holatni — nima mumkinu nima mumkin emasligini — ochiq aytaman.",
          ru: "Успокою водителя, сегодня же сам поговорю с трейлерным отделом и честно скажу ему реальную картину — что возможно, а что нет.",
          en: "Reassure the driver, talk to the Trailer Department myself today, and give him the honest picture — what is possible and what is not.",
        } },
        { key: "hr_q06_d", pattern: "complaint", text: {
          uz: "Rahbariyatga rekruting vaʼdalari bilan real imkoniyatlar orasidagi farq haydovchilarni ketkazayotganini yana bir bor aytaman — bu haqda necha marta gapirganmiz.",
          ru: "Ещё раз скажу руководству, что разрыв между обещаниями рекрутинга и реальными возможностями теряет нам водителей — сколько раз об этом говорили.",
          en: "Point out to management once again that the gap between recruiting promises and real capacity is costing us drivers — we have raised this so many times.",
        } },
        { key: "hr_q06_e", pattern: "builder", text: {
          uz: "Haydovchi bilan variantlarni kelishaman (muddat yoki almashtirish), treyler boʻlimi bilan reja tuzaman va kelgusida uskuna boʻyicha vaʼdalar faqat yozma tasdiq bilan berilishini yoʻlga qoʻyishni taklif qilaman.",
          ru: "Согласую с водителем варианты (срок или замену), составлю план с трейлерным отделом и предложу правило: обещания по технике даются только с письменным подтверждением.",
          en: "Agree on options with the driver (a timeline or a swap), make a plan with the Trailer Department, and propose a rule that equipment promises are only made with written confirmation.",
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
          uz: "Eskirgan joylar roʻyxatini tuzaman, tegishli boʻlimlardan aniq matnni soʻrab yangilayman va materiallarni har chorakda bir marta koʻrib chiqish tartibini taklif qilaman.",
          ru: "Составлю список устаревших мест, запрошу у профильных отделов точные формулировки, обновлю материалы и предложу пересматривать их раз в квартал.",
          en: "List the outdated sections, request exact wording from the relevant departments, update the materials, and propose reviewing them once a quarter.",
        } },
        { key: "hr_q07_b", pattern: "victim", text: {
          uz: "Bunday kamchiliklarni doim men payqayman, lekin materiallarni yangilash hech qachon mening vazifamga kiritilmagan — ortiqcha yuk yana menga tushayotganidan charchayman.",
          ru: "Такие недочёты всегда замечаю я, хотя обновление материалов никогда не входило в мои обязанности — устаёшь от того, что лишняя нагрузка снова ложится на меня.",
          en: "I am always the one who notices these gaps, even though updating the materials was never part of my job — it is tiring that the extra load lands on me again.",
        } },
        { key: "hr_q07_c", pattern: "complaint", text: {
          uz: "Materiallar necha yildan beri yangilanmaganini hamkasblarga aytaman — hujjatlarni tartibda saqlash faqat bitta odamning ishi boʻlmasligi kerak-ku.",
          ru: "Скажу коллегам, что материалы не обновлялись годами — поддержание документов в порядке не должно быть заботой одного человека.",
          en: "Tell coworkers the materials have not been updated in years — keeping documents in order should not be one person’s burden.",
        } },
        { key: "hr_q07_d", pattern: "ownership", text: {
          uz: "Eng koʻp chalkashlik keltirayotgan ikki-uch boʻlimni bugunoq oʻzim toʻgʻrilab, keyingi orientatsiyadan boshlab yangilangan variantdan foydalanaman.",
          ru: "Сегодня же сам исправлю два-три раздела, которые путают больше всего, и со следующей ориентации буду использовать обновлённую версию.",
          en: "Fix the two or three sections causing the most confusion myself today and use the updated version starting with the next orientation.",
        } },
        { key: "hr_q07_e", pattern: "blame", text: {
          uz: "Avval bu materiallar uchun kim masʼul etib tayinlanganini aniqlayman — vazifa unga biriktirilgan boʻlsa, nima uchun bajarilmaganini soʻrash kerak.",
          ru: "Сначала выясню, кто был назначен ответственным за эти материалы — если задача закреплена за ним, надо спросить, почему она не выполнялась.",
          en: "First establish who was assigned as owner of these materials — if the task was theirs, they should be asked why it was not done.",
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
          uz: "Nomzodga bizda boʻlimlar orasida yagona tizim yoʻqligini, shuning uchun shunday boʻlishini tushuntiraman — afsuski, bu bizning eski muammomiz.",
          ru: "Объясню кандидату, что у нас нет единой системы между отделами, поэтому так и выходит — увы, это наша давняя проблема.",
          en: "Explain to the candidate that we lack a single system between departments, which is why this happens — sadly, it is a long-standing problem of ours.",
        } },
        { key: "hr_q08_b", pattern: "victim", text: {
          uz: "Boshqa boʻlimlarning ishi tufayli nomzod oldida noqulay ahvolga tushganimdan ranjiyman — jarayonning bu qismi umuman menga bogʻliq emas-ku.",
          ru: "Мне неприятно, что из-за работы других отделов я оказываюсь в неловком положении перед кандидатом — эта часть процесса от меня вообще не зависит.",
          en: "Feel hurt that other departments’ work puts me in an awkward spot with the candidate — that part of the process does not depend on me at all.",
        } },
        { key: "hr_q08_c", pattern: "ownership", text: {
          uz: "Nomzoddan uzr soʻrab, uning maʼlumotlarini oʻzim bitta hujjatga jamlayman va keyingi bosqich xodimiga toʻliq holda oʻzim uzataman — nomzod endi qayta soʻralmasligi uchun.",
          ru: "Извинюсь перед кандидатом, сам соберу его данные в один документ и лично передам следующему сотруднику в полном виде — чтобы кандидата больше не переспрашивали.",
          en: "Apologize to the candidate, gather his information into one document myself, and hand it personally to the next person in full — so the candidate is not asked again.",
        } },
        { key: "hr_q08_d", pattern: "builder", text: {
          uz: "Uzr soʻrab maʼlumotni oʻzim yetkazaman, soʻng xavfsizlik boʻlimi bilan birga nomzodni uzatishda toʻldiriladigan qisqa yagona anketa formasini kelishib olaman.",
          ru: "Извинюсь и сам передам данные, а затем согласую с отделом безопасности короткую единую форму передачи кандидата между этапами.",
          en: "Apologize and pass the data along myself, then agree with Safety on a short shared handoff form used whenever a candidate moves between steps.",
        } },
        { key: "hr_q08_e", pattern: "blame", text: {
          uz: "Avval qaysi bosqichda savollar takrorlanganini aniqlayman — biz yiggʻan maʼlumotni keyingi boʻlim qayta soʻrayotgan boʻlsa, ular oʻz jarayonini toʻgʻrilashi kerak.",
          ru: "Сначала определю, на каком этапе продублировали вопросы — если следующий отдел заново спрашивает то, что мы уже собрали, пусть исправляют свой процесс.",
          en: "First pinpoint at which step the questions were duplicated — if the next department re-asks what we already collected, they need to fix their process.",
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
          uz: "Bu dispetcherlik ichki masalasi — aralashsam noqulay boʻladi. Haydovchiga rasmiy tartibda murojaat qilishni aytib, oʻsha yerdan javob kutishni maslahat beraman.",
          ru: "Это внутренний вопрос диспетчерской — вмешиваться неудобно. Посоветую водителю обратиться по официальной линии и ждать ответа оттуда.",
          en: "This is an internal dispatch matter — stepping in would be awkward. I will advise the driver to raise it through the official channel and wait for their answer.",
        } },
        { key: "hr_q09_b", pattern: "builder", text: {
          uz: "Haydovchini diqqat bilan tinglayman, roziligini olib, mohiyatni dispetcherlik rahbariga bezarar shaklda yetkazaman va bir haftadan soʻng haydovchidan ahvolni oʻzim soʻrab qoʻyaman — masala unutilib ketmasligi uchun.",
          ru: "Внимательно выслушаю, с согласия водителя корректно передам суть руководителю диспетчерской и сам перезвоню водителю через неделю узнать, как дела, — чтобы вопрос не потерялся.",
          en: "Listen carefully, and with the driver’s consent pass the substance tactfully to the dispatch lead, then check back with the driver myself in a week — so the issue does not get lost.",
        } },
        { key: "hr_q09_c", pattern: "blame", text: {
          uz: "Bu dispetcherning ishlash uslubi haqida shikoyatlar oldin ham boʻlgan — rahbariyat nihoyat oʻsha xodim bilan jiddiy shugʻullanishi kerakligini aytaman.",
          ru: "Про стиль работы этого диспетчера жаловались и раньше — скажу, что руководству пора наконец всерьёз заняться этим сотрудником.",
          en: "There have been complaints about this dispatcher’s style before — I will say management finally needs to deal seriously with that employee.",
        } },
        { key: "hr_q09_d", pattern: "ownership", text: {
          uz: "Haydovchini toʻliq tinglayman va roziligini olib, uning fikrini dispetcherlik rahbariga bugunoq yetkazaman — men qila oladigan foydali qadam shu.",
          ru: "Полностью выслушаю водителя и с его согласия сегодня же донесу его точку зрения до руководителя диспетчерской — это полезный шаг, который в моих силах.",
          en: "Hear the driver out fully and, with his consent, bring his perspective to the dispatch lead today — that is the useful step within my power.",
        } },
        { key: "hr_q09_e", pattern: "complaint", text: {
          uz: "Haydovchiga hamdardlik bildirib, dispetcherlar yukni koʻp olishga oʻrgangani uchun haydovchilar bilan muloqotga vaqt qolmayotganini aytaman — bu koʻpchilikning ogʻriqli joyi.",
          ru: "Посочувствую водителю и скажу, что диспетчеры привыкли гнать объёмы и на общение с водителями времени не остаётся — это больная тема у многих.",
          en: "Sympathize with the driver and say dispatchers are used to chasing volume, so there is no time left for communicating with drivers — a sore spot for many.",
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
          uz: "Reja tuzilganda bozor ahvoli soʻralmagan edi — endi esa natija mendan talab qilinmoqda; sharoitni hisobga olmasdan baholanish adolatsiz tuyuladi.",
          ru: "Когда составляли план, состояние рынка никто не спрашивал — а результат теперь требуют с меня; оценивать без учёта условий кажется несправедливым.",
          en: "No one asked about market conditions when the plan was set — yet the results are now demanded of me; being judged without regard to circumstances feels unfair.",
        } },
        { key: "hr_q10_b", pattern: "complaint", text: {
          uz: "Rahbariyatga eʼlon byudjeti va platformalar eskirganini, raqobatchilar koʻproq toʻlayotganini aytaman — bu sharoitda sifatli oqim kutish qiyin.",
          ru: "Скажу руководству, что бюджет и площадки объявлений устарели, а конкуренты платят больше — в таких условиях трудно ждать качественного потока.",
          en: "Tell management the ad budget and platforms are outdated and competitors pay more — it is hard to expect quality flow under these conditions.",
        } },
        { key: "hr_q10_c", pattern: "ownership", text: {
          uz: "Soʻnggi ellikta lidni oʻzim tahlil qilib, qaysi manba va matn sifatli nomzod berayotganini aniqlayman va kuchimni oʻsha kanallarga qarataman.",
          ru: "Сам разберу последние пятьдесят лидов, определю, какие источники и тексты дают качественных кандидатов, и сосредоточу усилия на этих каналах.",
          en: "Analyze the last fifty leads myself, identify which sources and ad copy bring qualified candidates, and focus my effort on those channels.",
        } },
        { key: "hr_q10_d", pattern: "waiting", text: {
          uz: "Bozor mavsumiy oʻzgaradi — keskin xulosa qilmay, keyingi ikki haftadagi oqimni kuzatib, soʻng yondashuvni oʻzgartirish kerakmi-yoʻqmi hal qilaman.",
          ru: "Рынок меняется по сезону — не буду делать резких выводов, посмотрю на поток ближайшие две недели и потом решу, менять ли подход.",
          en: "The market shifts with the season — rather than jumping to conclusions, I will watch the flow for the next two weeks and then decide whether to change the approach.",
        } },
        { key: "hr_q10_e", pattern: "builder", text: {
          uz: "Manbalar tahlilini qilib eng samaralisiga oʻtaman, eʼlon matnida talablarni aniqroq yozaman va rahbariyatga haftalik qisqa hisobot yuborib borishni yoʻlga qoʻyaman — jarayon shaffof boʻlishi uchun.",
          ru: "Проанализирую источники и переключусь на самые результативные, пропишу требования в объявлениях чётче и налажу короткий еженедельный отчёт руководству — чтобы процесс был прозрачным.",
          en: "Analyze the sources and shift to the best performers, state the requirements more clearly in the ads, and set up a short weekly report to management so the process stays transparent.",
        } },
      ],
    },
  ],
};
