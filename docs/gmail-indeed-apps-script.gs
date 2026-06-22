/**
 * Wenze — Indeed → Bitrix24 forwarder (Google Apps Script)
 *
 * One-time setup per recruiter Gmail inbox. See the admin panel "Leads" tab
 * for the step-by-step guide. Summary:
 *   1. In Indeed, turn on "email me the candidate's résumé as an attachment".
 *   2. script.google.com → New project → paste this file.
 *   3. Fill ENDPOINT (your Render URL) and SECRET (LEADS_INTERNAL_SHARED_SECRET).
 *   4. Run pollIndeed once and click Allow.
 *   5. Triggers (⏰) → Add Trigger → pollIndeed → Time-driven → every 5 minutes.
 */
var ENDPOINT = 'https://bot-backend-x9lc.onrender.com/api/internal/indeed/lead';
var SECRET   = 'PASTE_YOUR_LEADS_INTERNAL_SHARED_SECRET_HERE';

function pollIndeed() {
  var threads = GmailApp.search('from:(indeed.com) is:unread newer_than:2d');
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (!m.isUnread()) continue;

      var resume = '';
      var atts = m.getAttachments();
      for (var k = 0; k < atts.length; k++) {
        var name = (atts[k].getName() || '').toLowerCase();
        if (name.indexOf('.pdf') !== -1 && atts[k].getSize() < 8000000) {
          resume = Utilities.base64Encode(atts[k].getBytes());
          break;
        }
      }

      UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-internal-shared-secret': SECRET },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          messageId: m.getId(),
          from: m.getFrom(),
          subject: m.getSubject(),
          body: m.getPlainBody(),
          resumePdfBase64: resume
        })
      });
      m.markRead();
    }
  }
}
