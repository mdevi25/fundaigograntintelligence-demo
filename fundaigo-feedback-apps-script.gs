/**
 * ============================================================
 * Fundaigo Feedback Collector — Google Apps Script
 * ============================================================
 *
 * WHAT THIS DOES
 * Receives feedback submitted from Fundaigo (by anyone, guest or
 * signed in), appends it as a new row in this Sheet, and sends
 * you an email alert. Runs under YOUR Google account, so it works
 * for every visitor without them needing any Google permissions
 * of their own, that's the whole point.
 *
 * ---- ONE-TIME SETUP (about 10 minutes, no coding required) ----
 *
 * 1. Create a new Google Sheet (or open an existing one you want
 *    feedback to land in). Name it something like "Fundaigo
 *    Feedback."
 *
 * 2. In that Sheet: Extensions -> Apps Script. A code editor opens
 *    in a new tab.
 *
 * 3. Delete whatever's in the editor and paste this entire file
 *    in its place.
 *
 * 4. Change the email address on the line below (search for
 *    ALERT_EMAIL) to your own inbox.
 *
 * 5. Click Deploy (top right) -> New deployment.
 *      - Click the gear icon next to "Select type" -> Web app
 *      - Description: anything, e.g. "Fundaigo feedback"
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Click Deploy. Google will ask you to authorize it once,
 *    that's normal, click through (Advanced -> Go to project
 *    (unsafe) if it warns you, this warning shows for any script
 *    you deploy yourself, it's expected).
 *
 * 6. Copy the "Web app URL" it gives you at the end. That's the
 *    one thing to hand back, it goes into Fundaigo's config.js as
 *    CONFIG.feedback.webhookUrl.
 *
 * 7. If you ever edit this script again, you must create a NEW
 *    deployment (or "Manage deployments" -> edit -> new version)
 *    for the changes to actually go live, saving alone isn't
 *    enough.
 * ============================================================
 */

var ALERT_EMAIL = "YOUR_EMAIL@example.com"; // <-- change this to your inbox
var SHEET_NAME = "Feedback";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = getOrCreateFeedbackSheet_();

    sheet.appendRow([
      new Date(),
      data.category || "General",
      data.message || "",
      data.email || "(not provided)",
      data.orgName || "(unknown)",
      data.page || "(unknown)",
    ]);

    sendAlert_(data);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateFeedbackSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["Timestamp", "Category", "Message", "Email", "Org", "Page"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function sendAlert_(data) {
  var subject = "New Fundaigo feedback: " + (data.category || "General");
  var body =
    "Org: " + (data.orgName || "unknown") + "\n" +
    "Category: " + (data.category || "General") + "\n" +
    "From: " + (data.email || "not provided") + "\n" +
    "Page: " + (data.page || "unknown") + "\n\n" +
    "Message:\n" + (data.message || "");

  MailApp.sendEmail({ to: ALERT_EMAIL, subject: subject, body: body });
}
