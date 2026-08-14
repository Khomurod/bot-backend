/**
 * SOS assessment content — Samsara Monitoring department (10 questions).
 *
 * Scope: event alerts and video, AI camera detections, camera health, feed
 * latency, repeat-offender patterns, false positives and sensitivity, shift
 * queues and handoffs, platform outages, escalations to Safety, queue filters
 * that hide events.
 *
 * Authoring rules: see the header of ./hr.js — all five options must read as
 * competent and choosable, the six tendencies are loci of first action rather
 * than keyword formulas. Hard constraints for this department: no option may
 * hide, delete or downgrade a real event, classify an event dishonestly, or
 * leave a serious event unreported to Safety. A less accountable instinct shows
 * up as a different FIRST MOVE, never as suppressed monitoring data.
 */

module.exports = {
  department: "samsara",
  questions: [
    {
      key: "samsara_q01",
      text: {
        uz: "Yuk mashinasidan qattiq tormozlash boʻyicha ogohlantirish keldi, lekin hodisani ochsangiz, video yuklanmagan — faqat tezlik va joylashuv maʼlumotlari bor. Birinchi navbatda, katta ehtimol bilan nima qilasiz?",
        ru: "Пришёл алерт о резком торможении, но, открыв событие, вы видите, что видео не загрузилось — есть только данные о скорости и местоположении. Что вы, скорее всего, сделаете в первую очередь?",
        en: "A harsh-braking alert comes in, but when you open the event, the video did not upload — only speed and location data are there. What would you most likely do first?",
      },
      options: [
        { key: "samsara_q01_a", pattern: "victim", text: {
          uz: "Rahbarga aytib qoʻyaman: video platformada yuklanmagan — hodisa chala baholansa, buni mening ishimning kamchiligi deb koʻrish toʻgʻri boʻlmaydi.",
          ru: "Скажу руководителю: видео не загрузилось на стороне платформы — если событие оценено неполно, считать это недоработкой моей работы неверно.",
          en: "I would tell my lead the video failed to upload on the platform’s side — if the event ends up half-assessed, that is not a gap in my work.",
        } },
        { key: "samsara_q01_b", pattern: "builder", text: {
          uz: "Kameradan videoni qayta soʻrayman, mavjud maʼlumotni yozaman va klip kelmasa, shu trakda yuklashlar tez-tez uzilyaptimi — tarixni tekshiraman.",
          ru: "Запрошу видео с камеры повторно, зафиксирую имеющиеся данные, а если клип так и не придёт — проверю историю, часто ли срываются загрузки на этом траке.",
          en: "I would re-request the video from the camera, log the data we have, and if no clip arrives, check the history for whether uploads keep failing on this truck.",
        } },
        { key: "samsara_q01_c", pattern: "complaint", text: {
          uz: "Hodisani oʻzim maʼlumot boʻyicha yopaman, lekin rahbarga aytaman: video har ikkinchi holatda yuklanmaydi va baho chala boʻlaveradi.",
          ru: "Событие закрою сам по данным, но скажу руководителю: видео не загружается через раз, и оценка так и остаётся неполной.",
          en: "I would close the event on the data myself, but tell my lead video fails to upload every other time and assessments stay half-blind.",
        } },
        { key: "samsara_q01_d", pattern: "ownership", text: {
          uz: "Hozir mavjud maʼlumotni — tezlik grafigi, joylashuv, vaqt — oʻzim tahlil qilaman va hodisani «video yoʻq» izohi bilan faktga asoslab yozaman.",
          ru: "Сам разберу то, что есть сейчас — график скорости, местоположение, время — и запишу событие по фактам с пометкой «видео недоступно».",
          en: "I would analyze what is available right now — the speed graph, location, time — and record the event on the facts with a “video unavailable” note.",
        } },
        { key: "samsara_q01_e", pattern: "waiting", text: {
          uz: "Trak aloqa zonasiga qaytgach video keyin yuklanishi mumkin — hodisani ochiq qoldirib klipni kutaman, chunki toʻliq manzara adolatliroq baho beradi.",
          ru: "Видео может загрузиться позже, когда трак вернётся в зону покрытия — оставлю событие открытым и дождусь клипа: полная картина даёт более справедливую оценку.",
          en: "The video may upload later once the truck is back in coverage — I would leave the event open for the clip, since a full picture gives a fairer assessment.",
        } },
      ],
    },
    {
      key: "samsara_q02",
      text: {
        uz: "AI kamera haydovchi harakat paytida telefonga qarab ketganini aniqladi, video buni aniq koʻrsatib turibdi. Tartib boʻyicha bu haqda haydovchiga xabar berish kerak. Birinchi navbatda nima qilasiz?",
        ru: "AI-камера зафиксировала, что водитель во время движения смотрел в телефон, и видео это ясно показывает. По регламенту об этом нужно сообщить водителю. Что вы сделаете в первую очередь?",
        en: "The AI camera caught the driver looking at his phone while driving, and the video shows it clearly. Per procedure, the driver must be notified. What would you do first?",
      },
      options: [
        { key: "samsara_q02_a", pattern: "ownership", text: {
          uz: "Haydovchi toʻxtagach qoʻngʻiroq qilib, video nimani koʻrsatayotganini xotirjam aytaman, uning izohini eshitaman va suhbat natijasini hodisa yoniga yozib qoʻyaman.",
          ru: "Позвоню, когда водитель остановится, спокойно расскажу, что показывает видео, выслушаю его объяснение и запишу итог разговора рядом с событием.",
          en: "I would call once the driver is stopped, calmly describe what the video shows, hear his account, and log the outcome of the conversation next to the event.",
        } },
        { key: "samsara_q02_b", pattern: "waiting", text: {
          uz: "Hozir haydovchi yoʻlda — bunday suhbat uni yana chalgʻitadi; reys tugagach oʻzi bogʻlanganda aytaman, hodisa esa yozuvda turadi.",
          ru: "Сейчас водитель в пути — такой разговор отвлечёт его ещё больше; скажу, когда он выйдет на связь после рейса, а событие останется в записи.",
          en: "The driver is rolling right now — a talk like this distracts him further; I would raise it when he checks in after the trip, with the event on record.",
        } },
        { key: "samsara_q02_c", pattern: "blame", text: {
          uz: "Xavfsizlik boʻlimi u bilan bu mavzuda ishlaganmi tekshiraman — oldin ishlangan va takrorlangan boʻlsa, tuzatish oʻsha bosqichda kuchga kiradi.",
          ru: "Проверю, работал ли с ним отдел безопасности по этой теме: если работали и повторилось, исправление действует именно на том шаге.",
          en: "I would check whether Safety has already coached him on this — if they had and it repeated, the correction takes effect at that step.",
        } },
        { key: "samsara_q02_d", pattern: "builder", text: {
          uz: "Haydovchi toʻxtagach hurmat bilan gaplashaman, hodisani tartib boʻyicha xavfsizlik boʻlimiga uzataman va bir hafta uning hodisalarini alohida kuzataman.",
          ru: "Когда водитель остановится, поговорю уважительно, передам событие в отдел безопасности по регламенту и неделю буду отдельно следить за его событиями.",
          en: "I would talk with him respectfully once he stops, pass the event to Safety per procedure, and watch his events separately for a week.",
        } },
        { key: "samsara_q02_e", pattern: "complaint", text: {
          uz: "Haydovchiga aytaman va masalani yigʻilishga olib chiqaman: telefon hodisalari har oy oʻsadi, ogohlantirish formati esa oʻzgarmayapti.",
          ru: "Водителю скажу и вынесу вопрос на совещание: события с телефоном растут каждый месяц, а формат предупреждений не меняется.",
          en: "I would notify the driver and take the issue to the meeting: phone events grow every month while the notification format stays the same.",
        } },
      ],
    },
    {
      key: "samsara_q03",
      text: {
        uz: "Ertalabki tekshiruvda bitta yuk mashinasining yoʻlga qaragan kamerasi uch kundan beri «linza toʻsilgan» holatida turganini payqadingiz — bu vaqt ichida hech kim buni belgilamagan. Birinchi navbatda nima qilasiz?",
        ru: "Во время утренней проверки вы заметили, что дорожная камера одного грузовика уже три дня висит в статусе «объектив перекрыт» — и за это время никто это не отметил. Что вы сделаете в первую очередь?",
        en: "During the morning check you notice one truck’s road-facing camera has shown “lens obstructed” for three days — and no one flagged it in all that time. What would you do first?",
      },
      options: [
        { key: "samsara_q03_a", pattern: "blame", text: {
          uz: "Oʻsha kunlar kim smenada boʻlganini oʻzim aniqlayman — uzilishni belgilamasak, uch kunlik koʻrlik keyingi oyda ham qaytadi.",
          ru: "Сам выясню, кто был в смене в те дни: если не обозначить разрыв, три дня слепоты повторятся и в следующем месяце.",
          en: "I would establish myself who was on shift those days — unless the break is marked, three blind days come back next month.",
        } },
        { key: "samsara_q03_b", pattern: "ownership", text: {
          uz: "Haydovchi bilan darhol bogʻlanib linzani tozalashini soʻrayman, tasvir qaytganini oʻzim tekshiraman va uch kunlik boʻshliqni sanalari bilan rost yozib qoʻyaman.",
          ru: "Сразу свяжусь с водителем и попрошу очистить объектив, сам проверю, что картинка вернулась, и честно зафиксирую трёхдневный пробел с датами.",
          en: "I would contact the driver at once to clear the lens, verify myself that the picture is back, and log the three-day gap honestly with its dates.",
        } },
        { key: "samsara_q03_c", pattern: "victim", text: {
          uz: "Buni men topdim, lekin oʻsha kunlar mening smenam emas edi — uch kunlik boʻshliq kimga tegishli ekanini sanalar bilan yozib qoʻyaman.",
          ru: "Нашёл это я, хотя те дни были не моей смены — зафиксирую с датами, к чьей смене относится каждый день трёхдневного пробела.",
          en: "I found it, but those days were not my shifts — I would record with dates whose shifts the three-day gap belongs to.",
        } },
        { key: "samsara_q03_d", pattern: "complaint", text: {
          uz: "Kamerani ishga solaman, ammo asosiy gap boshqada: kamera parki qarigan va bunday koʻr traklar paydo boʻlaveradi.",
          ru: "Камеру верну в работу, но суть в другом: парк камер старый, и такие слепые траки будут появляться и дальше.",
          en: "I would get the camera working, but the real point is elsewhere: the camera fleet is aging and blind trucks keep appearing.",
        } },
        { key: "samsara_q03_e", pattern: "builder", text: {
          uz: "Bugun haydovchi bilan kamerani ishga solaman, keyin har smena boshida bir daqiqalik kamera holati tekshiruvini yoʻlga qoʻyaman — koʻr kamera kunlab turmasligi kerak.",
          ru: "Сегодня с водителем верну камеру в работу, а затем налажу минутную проверку состояния камер в начале каждой смены: слепая камера не должна висеть днями.",
          en: "I would get the camera working with the driver today, then set up a one-minute camera-health check at every shift start — no camera should sit blind for days.",
        } },
      ],
    },
    {
      key: "samsara_q04",
      text: {
        uz: "Ertalab boʻlgan jiddiy hodisa — oldindagi mashinaga xavfli yaqinlashish — platforma lentasida oradan olti soat oʻtib paydo boʻldi; haydovchi bu orada yukni yetkazib ham boʻlgan. Birinchi navbatda nima qilasiz?",
        ru: "Серьёзное событие, произошедшее утром, — опасное сближение с впереди идущей машиной — появилось в ленте платформы только через шесть часов; водитель за это время уже доставил груз. Что вы сделаете в первую очередь?",
        en: "A serious event from this morning — a dangerous following-distance incident — showed up in the platform feed only six hours later; by then the driver had already delivered the load. What would you do first?",
      },
      options: [
        { key: "samsara_q04_a", pattern: "builder", text: {
          uz: "Hodisani hozir koʻrib, real vaqti bilan xavfsizlik boʻlimiga yuboraman, kechikishni yozaman va hodisa tarixini davriy qoʻlda koʻrib chiqishni kiritaman.",
          ru: "Просмотрю событие сейчас, отправлю в отдел безопасности с реальным временем, зафиксирую задержку и введу периодический ручной просмотр истории событий.",
          en: "I would review the event now, send it to Safety with the real time of occurrence, log the delay, and set up a periodic manual sweep of event history.",
        } },
        { key: "samsara_q04_b", pattern: "waiting", text: {
          uz: "Kechikish platforma tomonida — Samsara bunday uzilishlarni oʻzi tuzatadi; hodisalarni kelgan tartibda ishlab, tizim barqarorlashguncha tartibni oʻzgartirmayman.",
          ru: "Задержка на стороне платформы — Samsara такие сбои устраняет сама; буду обрабатывать события по мере поступления и не менять порядок, пока система не стабилизируется.",
          en: "The delay is the platform’s — Samsara resolves glitches like this itself; I would work events as they arrive and change nothing until the system settles.",
        } },
        { key: "samsara_q04_c", pattern: "ownership", text: {
          uz: "Kechikkan boʻlsa ham hodisani hozir toʻliq koʻrib chiqaman, sodir boʻlgan real vaqtini yozaman va xavfsizlik boʻlimiga kech kelganini ochiq aytaman.",
          ru: "Несмотря на задержку, полностью разберу событие сейчас, зафиксирую реальное время происшествия и открыто скажу отделу безопасности, что оно пришло поздно.",
          en: "Despite the delay I would review the event fully now, log the actual time it happened, and tell Safety openly that it arrived late.",
        } },
        { key: "samsara_q04_d", pattern: "blame", text: {
          uz: "Olti soat platforma tomonida yoʻqolganini hujjat qilib qoʻyaman — kelish vaqtini skrinshot qilaman, savol chiqsa, kechikish qayerda boʻlgani aniq koʻrinadi.",
          ru: "Задокументирую, что шесть часов потерялись на стороне платформы: сделаю скриншот времени поступления, чтобы при вопросах было ясно, чья это задержка.",
          en: "I would document that the six hours were lost on the platform’s side — a screenshot of the arrival time makes clear whose delay it was if questions come.",
        } },
        { key: "samsara_q04_e", pattern: "victim", text: {
          uz: "Rahbarga aniq aytaman: platforma kechiksa ham savol bizga keladi — olti soatlik kechikish monitoring ishining sifati deb baholanmasligi kerak.",
          ru: "Прямо скажу руководителю: даже когда опаздывает платформа, спрашивают нас — шестичасовую задержку не стоит считать качеством работы мониторинга.",
          en: "I would tell my lead plainly that even when the platform is late the questions come to us — a six-hour delay is not the quality of monitoring’s work.",
        } },
      ],
    },
    {
      key: "samsara_q05",
      text: {
        uz: "Bitta haydovchida shu hafta ichida uchinchi marta qattiq tormozlash hodisasi qayd etildi. Har safar unga standart ogohlantirish yuborilgan, lekin holat takrorlanmoqda. Birinchi navbatda nima qilasiz?",
        ru: "У одного водителя за эту неделю уже третье событие резкого торможения. Каждый раз ему отправлялось стандартное уведомление, но ситуация повторяется. Что вы сделаете в первую очередь?",
        en: "The same driver has logged his third harsh-braking event this week. A standard notification went out each time, yet the pattern continues. What would you do first?",
      },
      options: [
        { key: "samsara_q05_a", pattern: "complaint", text: {
          uz: "Standart xabarni yuboraman va ogohlantirish tizimi haqida savol qoʻyaman: bu xabarlar ishlamayapti, uchinchi hodisa toʻrtinchisiga aylanadi.",
          ru: "Стандартное уведомление отправлю и поставлю вопрос о самой системе оповещений: они не работают, а третье событие станет четвёртым.",
          en: "I would send the standard notice and put a question about the alert system itself: these notices do not work, and the third event becomes the fourth.",
        } },
        { key: "samsara_q05_b", pattern: "waiting", text: {
          uz: "Takroriy hodisalarni xavfsizlik boʻlimi oylik tahlilda koʻradi — bu holat oʻsha yerda chiqadi; shu vaqtgacha tartib boʻyicha standart xabarlarni yuborib turaman.",
          ru: "Повторные события отдел безопасности видит в месячном анализе — этот случай там и всплывёт; до тех пор буду по регламенту отправлять стандартные уведомления.",
          en: "Safety sees repeat events in its monthly analysis — this case surfaces there; until then I would keep sending the standard notices per procedure.",
        } },
        { key: "samsara_q05_c", pattern: "builder", text: {
          uz: "Uch hodisani kliplar bilan bitta xulosaga jamlab bugun xavfsizlik boʻlimiga uzataman va haftada uchta oʻxshash hodisa avtomatik belgilanishini taklif qilaman.",
          ru: "Сведу три события с клипами в одну сводку, передам сегодня в отдел безопасности и предложу автоматически помечать три схожих события за неделю.",
          en: "I would combine the three events with clips into one summary for Safety today and propose auto-flagging any three similar events in a week.",
        } },
        { key: "samsara_q05_d", pattern: "victim", text: {
          uz: "Hammasini tartib boʻyicha yuboraman, xulq esa haydovchida — shu chegarani rahbar bilan oldin aniq qilib olaman, keyin ishni davom ettiraman.",
          ru: "Всё отправляю по регламенту, а поведение — за водителем; сначала проясню эту границу с руководителем, а потом продолжу работу.",
          en: "I send everything per procedure while the behavior is the driver’s — I would settle that boundary with my lead first, then carry on.",
        } },
        { key: "samsara_q05_e", pattern: "ownership", text: {
          uz: "Uch hodisani oʻzim solishtirib nimasi umumiy ekanini koʻraman, haydovchi bilan xotirjam gaplashaman va holatni bugun xavfsizlik boʻlimiga chiqaraman.",
          ru: "Сам сравню три события и посмотрю, что у них общего, спокойно поговорю с водителем и сегодня же выведу ситуацию в отдел безопасности.",
          en: "I would compare the three events myself to see what they share, talk calmly with the driver, and raise the situation with Safety today.",
        } },
      ],
    },
    {
      key: "samsara_q06",
      text: {
        uz: "Qattiq tormozlash boʻyicha ogohlantirish tushdi, lekin videoda mashina oʻnqir-choʻnqir yoʻl uchastkasidan bir maromda oʻtayotgani koʻrinyapti — hodisa yolgʻon koʻrinadi, haydovchi esa yozuvdan norozi. Birinchi navbatda nima qilasiz?",
        ru: "Сработал алерт о резком торможении, но на видео грузовик ровно проходит разбитый участок дороги — событие выглядит ложным, а водитель недоволен, что оно записано. Что вы сделаете в первую очередь?",
        en: "A harsh-braking alert fired, but the video shows the truck rolling steadily over a rough stretch of road — the event looks false, and the driver is unhappy it was recorded. What would you do first?",
      },
      options: [
        { key: "samsara_q06_a", pattern: "builder", text: {
          uz: "Videoni telemetriya bilan solishtiraman, tasdiqlansa hodisani sabab bilan yolgʻon deb belgilayman va joyni yozib qoʻyaman — takrorlansa Samsaraga xabar qilamiz.",
          ru: "Сверю видео с телеметрией, при подтверждении помечу событие ложным с указанием причины и зафиксирую участок: при повторах сообщим в Samsara.",
          en: "I would check the video against the telemetry, file the event as false with the reason if that holds, and note the spot — repeats there get reported to Samsara.",
        } },
        { key: "samsara_q06_b", pattern: "complaint", text: {
          uz: "Hodisani koʻrib chiqaman, lekin smenada aytaman: sezgirlik sozlamalari har kuni shunday shovqin beradi — sozlama koʻrilmasa, real hodisalarni ajratish qiyinlashadi.",
          ru: "Событие разберу, но в смене скажу: настройки чувствительности каждый день дают такой шум — пока их не пересмотрят, отличать реальные события всё труднее.",
          en: "I would review the event, but say in the shift that the sensitivity settings produce this noise daily — unrevised, picking out real events keeps getting harder.",
        } },
        { key: "samsara_q06_c", pattern: "blame", text: {
          uz: "Ogohlantirish chegaralarini oxirgi kim sozlaganini aniqlayman — monitoring bilan kelishmasdan oʻzgartirilgan boʻlsa, tuzatish ham oʻsha yerda boʻlishi kerak.",
          ru: "Выясню, кто последним настраивал пороги алертов: если их меняли без согласования с мониторингом, исправлять надо там.",
          en: "I would find out who last tuned the alert thresholds — if they were changed without checking with monitoring, that is where it gets corrected.",
        } },
        { key: "samsara_q06_d", pattern: "ownership", text: {
          uz: "Klipni tezlik va g-force maʼlumotlari bilan oʻzim solishtiraman; hodisa haqiqatan yolgʻon boʻlsa, izoh bilan belgilayman va haydovchiga koʻrib chiqilganini aytaman.",
          ru: "Сам сверю клип с данными скорости и g-force; если событие действительно ложное, помечу с пояснением и скажу водителю, что оно разобрано.",
          en: "I would compare the clip with the speed and g-force data myself; if the event really is false, I would file it with an explanation and tell the driver it was reviewed.",
        } },
        { key: "samsara_q06_e", pattern: "waiting", text: {
          uz: "Hozircha belgilamayman — bunday holatlarni qanday tasniflashni xavfsizlik boʻlimi aytgach yopaman; notoʻgʻri tasnif keyin qimmatga tushadi.",
          ru: "Пока помечать не буду — закрою, когда отдел безопасности скажет, как классифицировать такие случаи: неверная классификация потом обходится дорого.",
          en: "I would not classify it yet — I would close it once Safety advises how such cases are classified; a wrong classification is costly later.",
        } },
      ],
    },
    {
      key: "samsara_q07",
      text: {
        uz: "Smenani qabul qilib olganingizda oldingi smenaning soʻnggi soatlaridan yigirmaga yaqin hodisa umuman koʻrilmay qolganini koʻrdingiz — orasida jiddiylari ham bor. Birinchi navbatda nima qilasiz?",
        ru: "Принимая смену, вы обнаружили около двадцати событий за последние часы предыдущей смены, которые вообще никто не просмотрел — среди них есть и серьёзные. Что вы сделаете в первую очередь?",
        en: "Taking over the shift, you find about twenty events from the previous shift’s final hours that no one reviewed at all — some of them serious. What would you do first?",
      },
      options: [
        { key: "samsara_q07_a", pattern: "ownership", text: {
          uz: "Navbatni hoziroq eng jiddiylaridan boshlab oʻzim tozalayman va rahbarga boʻshliq borligini ochiq aytaman — kunning manzarasi aniq boʻlishi kerak.",
          ru: "Прямо сейчас начну сам разбирать очередь с самых серьёзных и открыто скажу руководителю, что был пробел: картина дня должна быть точной.",
          en: "I would start clearing the queue myself right now, most serious first, and tell my lead openly there was a gap — the day’s picture has to be accurate.",
        } },
        { key: "samsara_q07_b", pattern: "victim", text: {
          uz: "Smenam boshqaning navbatidan boshlanadi — ularning soatlarini tozalaganim koʻrinib turishi uchun buni topshiruv izohiga yozaman.",
          ru: "Моя смена начинается с чужой очереди — чтобы было видно, что я разбирал именно их часы, отмечу это в заметке передачи смены.",
          en: "My shift starts on someone else’s queue — I would note in the handoff that I cleared their hours, so it stays visible.",
        } },
        { key: "samsara_q07_c", pattern: "builder", text: {
          uz: "Jiddiylarini avval yopaman, keyin har smena almashuvida navbat holati yozilgan qisqa topshiruv izohini kelishib olaman — boʻshliq topshirishda koʻrinishi kerak.",
          ru: "Сначала закрою серьёзные, затем согласую короткую заметку передачи с состоянием очереди при каждой смене: пробел должен быть виден при передаче.",
          en: "I would close the serious ones first, then set up a short handoff note with queue status at every shift change — a gap should surface at handover.",
        } },
        { key: "samsara_q07_d", pattern: "blame", text: {
          uz: "Loglardan oʻsha soatlarda kim boʻlgani va navbat nega toʻxtaganini aniqlayman — uzilish qayerda boʻlganini belgilamasak, xuddi shu takrorlanadi.",
          ru: "По логам выясню, кто был в те часы и почему очередь встала: если не обозначить разрыв, то же самое повторится.",
          en: "I would use the logs to establish who was on in those hours and why the queue stalled — unless the break is marked, the same thing repeats.",
        } },
        { key: "samsara_q07_e", pattern: "complaint", text: {
          uz: "Navbatni tozalayman, lekin rahbarga aytaman: tungi smenada odam yetmaydi va bunday navbatlar shundan chiqadi — jadval koʻrilmasa, bu qaytadi.",
          ru: "Очередь разберу, но скажу руководителю: в ночной смене не хватает людей, и такие очереди идут отсюда — без пересмотра графика это вернётся.",
          en: "I would clear the queue, but tell my lead the night shift is short-staffed and queues like this come from that — with the schedule unchanged, it returns.",
        } },
      ],
    },
    {
      key: "samsara_q08",
      text: {
        uz: "Smenangiz oʻrtasida Samsara portali ochilmay qoldi — jonli hodisalar qirq daqiqadan beri kelmayapti. Holat sahifasi uzilish ularning tomonida ekanini tasdiqlayapti. Birinchi navbatda nima qilasiz?",
        ru: "В середине вашей смены портал Samsara перестал открываться — живые события не приходят уже сорок минут. Страница статуса подтверждает: сбой на их стороне. Что вы сделаете в первую очередь?",
        en: "In the middle of your shift the Samsara portal stops loading — no live events for forty minutes now. The status page confirms the outage is on their side. What would you do first?",
      },
      options: [
        { key: "samsara_q08_a", pattern: "waiting", text: {
          uz: "Muammo provayder tomonida — holat sahifasi tiklanishni koʻrsatgach navbatni toʻliq koʻrib chiqaman; uzilish davomida ortiqcha xabar tarqatib chalkashlik qilmayman.",
          ru: "Проблема на стороне поставщика — разберу очередь полностью, когда страница статуса покажет восстановление; во время сбоя не буду разносить лишние сообщения.",
          en: "The problem is the vendor’s — I would review the whole queue once the status page shows it restored, without spreading extra messages during the outage.",
        } },
        { key: "samsara_q08_b", pattern: "builder", text: {
          uz: "Rahbar va xavfsizlik boʻlimini darhol ogohlantiraman, uzilish davomida shoshilinch holatlarni dispetcherlik telefon orqali yetkazishini soʻrayman, keyin qisqa yozma tartib tayyorlaymiz.",
          ru: "Сразу предупрежу руководителя и отдел безопасности, попрошу диспетчерскую передавать срочное по телефону, пока идёт сбой, а затем подготовим короткий письменный порядок.",
          en: "I would alert my lead and Safety at once, ask dispatch to phone in anything urgent while the outage lasts, then draft a short written procedure for these cases.",
        } },
        { key: "samsara_q08_c", pattern: "blame", text: {
          uz: "Uzilish platformada ekanini hujjat qilib qoʻyaman — holat sahifasi skrinshotini rahbariyatga yuboraman, boʻshliq keyin monitoringga yozilmasligi kerak.",
          ru: "Задокументирую, что сбой на платформе: отправлю руководству скриншот страницы статуса, чтобы пробел потом не записали на мониторинг.",
          en: "I would document that the outage is the platform’s — a screenshot of the status page to management, so the gap is not later pinned on monitoring.",
        } },
        { key: "samsara_q08_d", pattern: "victim", text: {
          uz: "Uzilish mening smenamga tushdi, lekin platforma bizda emas — oyna qachon boshlangani va kimga tegishli ekanini hozirdan yozaman.",
          ru: "Сбой пришёлся на мою смену, но платформа не наша — уже сейчас запишу, когда началось окно и к кому оно относится.",
          en: "The outage landed on my shift but the platform is not ours — I would record now when the window began and whose it is.",
        } },
        { key: "samsara_q08_e", pattern: "ownership", text: {
          uz: "Rahbar va xavfsizlik boʻlimiga jonli monitoring toʻxtaganini hoziroq aytaman, uzilish boshlangan vaqtni yozaman va tiklangach koʻr oyna hodisalarini oʻzim koʻrib chiqaman.",
          ru: "Прямо сейчас сообщу руководителю и отделу безопасности, что живой мониторинг остановлен, зафиксирую время начала сбоя и после восстановления сам разберу события слепого окна.",
          en: "I would tell my lead and Safety right now that live monitoring is down, note when the outage began, and review every event from the blind window myself afterwards.",
        } },
      ],
    },
    {
      key: "samsara_q09",
      text: {
        uz: "Ikki kun oldin jiddiy hodisani — toʻqnashuvga yaqin holat videosini — xavfsizlik boʻlimiga koʻrib chiqish uchun uzatgansiz. Javob yoʻq, bugun esa oʻsha haydovchida masofa saqlash boʻyicha yangi ogohlantirish paydo boʻldi. Birinchi navbatda nima qilasiz?",
        ru: "Два дня назад вы передали в отдел безопасности серьёзное событие — видео ситуации, близкой к столкновению. Ответа нет, а сегодня у того же водителя появился новый алерт по дистанции. Что вы сделаете в первую очередь?",
        en: "Two days ago you escalated a serious event to Safety — video of a near-collision. There has been no response, and today the same driver has a new following-distance alert. What would you do first?",
      },
      options: [
        { key: "samsara_q09_a", pattern: "complaint", text: {
          uz: "Ikkinchi hodisani ham yuboraman, keyin javob muddati masalasini rahbarlar oldida qoʻyaman: uzatishlarimiz javobsiz qolmasligi kerak.",
          ru: "Второе событие тоже отправлю, а затем поставлю перед руководителями вопрос о сроке ответа: наши передачи не должны оставаться без ответа.",
          en: "I would send the second event too, then put the response-time question to the leads: our escalations should not go unanswered.",
        } },
        { key: "samsara_q09_b", pattern: "victim", text: {
          uz: "Hammasini oʻz vaqtida uzatdim, natija esa boshqa boʻlimda — uzatish vaqtini va javob yoʻqligini bugun qayd etaman.",
          ru: "Всё передал вовремя, а результат в другом отделе — сегодня зафиксирую время передачи и отсутствие ответа.",
          en: "I escalated on time while the outcome sits with another department — today I would record the send time and the missing reply.",
        } },
        { key: "samsara_q09_c", pattern: "ownership", text: {
          uz: "Bugun xavfsizlik boʻlimiga oʻzim murojaat qilaman: holatni qayta yuboraman, yangi ogohlantirishni qoʻshaman va suhbat boʻlgan-boʻlmaganini toʻgʻridan-toʻgʻri soʻrayman.",
          ru: "Сегодня сам обращусь в отдел безопасности: повторно отправлю случай, приложу новый алерт и напрямую спрошу, была ли беседа с водителем.",
          en: "I would reach out to Safety myself today: resend the case, attach the new alert, and ask directly whether the coaching conversation happened.",
        } },
        { key: "samsara_q09_d", pattern: "builder", text: {
          uz: "Xavfsizlik rahbariga ikki hodisani bogʻlab yozaman, bugun kim harakat qilishini kelishaman va har uzatishga tasdiq va muddat belgilanishini taklif qilaman.",
          ru: "Напишу руководителю по безопасности, связав два события, договорюсь, кто действует сегодня, и предложу закрепить подтверждение и срок для каждой передачи.",
          en: "I would write to the Safety lead linking both events, agree who acts today, and propose an acknowledgment and a deadline for every escalation.",
        } },
        { key: "samsara_q09_e", pattern: "blame", text: {
          uz: "Uzatish oʻz vaqtida ketganini koʻrsatadigan yozishmani yigʻaman — bu haydovchi bilan biror narsa boʻlsa, kechikish qayerda boʻlgani hujjatda turishi kerak.",
          ru: "Соберу переписку, показывающую, что передача ушла вовремя: если с этим водителем что-то случится, в документах должно быть видно, где произошла задержка.",
          en: "I would collect the correspondence showing the escalation went out on time — if something happens, the record must show where the delay sat.",
        } },
      ],
    },
    {
      key: "samsara_q10",
      text: {
        uz: "Tarixni koʻrib chiqayotib, bir hafta oldingi jiddiy hodisa — video bilan qayd etilgan xavfli manevr — umuman koʻrilmaganini tasodifan aniqladingiz: u navbat filtri sababli odatiy roʻyxatga tushmagan. Birinchi navbatda nima qilasiz?",
        ru: "Просматривая историю, вы случайно обнаружили серьёзное событие недельной давности — опасный маневр, записанный на видео, — которое никто так и не просмотрел: из-за фильтра очереди оно не попало в обычный список. Что вы сделаете в первую очередь?",
        en: "Going through the history, you stumble on a serious week-old event — a dangerous maneuver caught on video — that no one ever reviewed: a queue filter kept it out of the usual list. What would you do first?",
      },
      options: [
        { key: "samsara_q10_a", pattern: "waiting", text: {
          uz: "Hodisani xavfsizlik boʻlimiga bugun yuboraman, lekin bir hafta oldingi yozuvni qanday rasmiylashtirishni rahbarimdan soʻrab, ertaga toʻgʻri kiritaman.",
          ru: "Событие отправлю в отдел безопасности сегодня, но как оформить запись недельной давности, спрошу у руководителя и внесу правильно завтра.",
          en: "I would send the event to Safety today, but ask my supervisor how a week-old entry is filed and enter it correctly tomorrow.",
        } },
        { key: "samsara_q10_b", pattern: "ownership", text: {
          uz: "Hodisani hozir toʻliq koʻrib chiqaman, filtr sababli kech chiqqanini yashirmasdan xavfsizlik boʻlimiga yuboraman va shu filtr ortida yana koʻrilmagani bormi tekshiraman.",
          ru: "Полностью разберу событие сейчас, отправлю в отдел безопасности, не скрывая, что из-за фильтра оно всплыло поздно, и проверю, нет ли за тем же фильтром других непросмотренных.",
          en: "I would review the event fully now, send it to Safety without hiding that the filter surfaced it late, and check whether more sit behind that same filter.",
        } },
        { key: "samsara_q10_c", pattern: "victim", text: {
          uz: "Filtrni men sozlamaganman, lekin hodisani men topdim — shuning uchun topilgan vaqtni va filtr sozlamasini oʻzim yozib qoʻyaman.",
          ru: "Фильтр настраивал не я, но событие нашёл я — поэтому сам зафиксирую время находки и настройку фильтра.",
          en: "I did not configure the filter though I found the event — so I would record the time of the find and the filter setting myself.",
        } },
        { key: "samsara_q10_d", pattern: "complaint", text: {
          uz: "Hodisani chiqaraman, lekin jamoada aytaman: navbat filtrlari chalkash sozlangan va hodisalar shunday yashirinadi — interfeys shu holatda qolsa, oʻtkazib yuborish muqarrar.",
          ru: "Событие выведу, но в команде скажу: фильтры очереди настроены путано, и события так и прячутся — пока интерфейс такой, пропуски неизбежны.",
          en: "I would raise the event, but say in the team the queue filters are set up confusingly and events hide this way — with this interface, misses are guaranteed.",
        } },
        { key: "samsara_q10_e", pattern: "builder", text: {
          uz: "Hodisani bugun real vaqti bilan chiqaraman, filtrni tuzattiraman va haftalik toʻliq tarix solishtiruvini yoʻlga qoʻyaman — hech narsa koʻrilmay qolmasligi kerak.",
          ru: "Выведу событие сегодня с его реальным временем, добьюсь исправления фильтра и налажу еженедельную сверку полной истории: ничто не должно оставаться непросмотренным.",
          en: "I would raise the event today with its real timing, get the filter fixed, and set up a weekly full-history cross-check so nothing sits unseen.",
        } },
      ],
    },
  ],
};
