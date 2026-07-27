# Fundigo — Founder / Admin Setup Guide

This covers every step that a human has to do by hand — nothing here can be
automated by the app itself, either because Google requires a real person to
grant consent, or because it's a decision only your org can make (who's on
the team, what the org's domain is, etc.).

Do these once, in order. Total time: roughly 20–30 minutes, no cost, no
credit card at any point.

---

## Who should do this

Whoever sets this up ends up as the de facto admin for these steps — ideally
the founder/CEO, or someone who won't be leaving the org soon. This isn't
enforced by the app (see "Known gap" at the bottom), just a strong
recommendation.

---

## Part 1 — Google Cloud Console (one-time, ~10 min)

This gives the app permission to let people sign in with Google and read/write
Google Sheets. None of this costs money at this scale.

1. Go to **console.cloud.google.com** → create a new project (name it
   "Fundigo" or similar).
2. **APIs & Services → OAuth consent screen** → configure:
   - User type: External
   - App name: Fundigo
   - Support email: your own
   - Scopes: add `.../auth/spreadsheets` and `.../auth/drive.file`
3. **APIs & Services → Library** → search and **enable**:
   - Google Sheets API
   - Google Drive API
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: Web application
   - Authorized JavaScript origins: your live site URL
     (e.g. `https://fundigograntdiscovery.netlify.app`)
5. Copy the generated **Client ID** (ends in `.apps.googleusercontent.com`).
   You'll need it twice, in Part 2.

---

## Part 2 — Netlify (one-time, ~5 min)

1. In your Netlify site → **Site settings → Environment variables**, add:
   - `GOOGLE_CLIENT_ID` = the Client ID from Part 1, step 5
2. Confirm **Netlify Blobs** is enabled for the site (used only to store one
   tiny pointer per org — see "What actually lives where" below).
3. In the codebase, open `auth.js` and paste the same Client ID into
   `AUTH_CONFIG.clientId` at the top of the file, then deploy.

---

## Part 3 — Google Drive: create your org's Shared Drive (one-time, ~2 min)

This is the step that makes grant data **owned by the organization**, not by
whichever staff member or volunteer happens to be signed in.

1. Go to **drive.google.com** → **New → Shared Drive**.
2. Name it something clear, e.g. "Fundigo Grant Data."
3. Click into it → **Manage members** → add your grant team by email
   (whoever will be searching for and tracking grants).
4. Open the Shared Drive and copy the ID from the URL:
   `drive.google.com/drive/folders/`**`<this part is the ID>`**

---

## Part 4 — Connect it in Fundigo (one-time, ~1 min)

1. Sign in to Fundigo with your `@yourorg.org` account.
2. Go to **Settings → Team data**.
3. Paste the Shared Drive ID from Part 3 → **Save**.
4. The status line should turn green ("Shared Drive connected"). The team
   spreadsheet is created automatically the first time anyone loads data —
   you don't need to create it by hand.

That's it. From here, every team member who signs in with an `@yourorg.org`
address automatically sees the same grant profile and tracker.

---

## Ongoing: when someone joins or leaves the team

- **Joining:** add them to the Shared Drive's membership in Google Drive
  (Part 3, step 3). No Fundigo-side setup needed — signing in with their org
  email is enough.
- **Leaving:** remove them from the Shared Drive's membership. The
  spreadsheet, and everything in it, stays exactly where it is — this is the
  whole point of using a Shared Drive instead of someone's personal My Drive.

---

## What actually lives where (for your own peace of mind)

| Data | Where it lives | Who can see it |
|---|---|---|
| Grant profile, tracker rows (funder names, amounts, deadlines, notes) | Google Sheet inside your org's Shared Drive | Anyone you've added to the Shared Drive |
| Groq API key | The browser's session memory of whoever entered it | Nobody else — never sent to Netlify or stored anywhere |
| Shared Drive ID, spreadsheet ID | Netlify Blobs (a tiny pointer, two short ID strings, nothing else) | Only readable by someone who can prove they're signed in on your domain |

Nothing about the actual grants — funder names, amounts, deadlines, notes —
ever passes through or is stored on Netlify. If you ever switch hosting
providers, that data doesn't need to be migrated — it's already sitting in
your own Google Drive.

---

## Admin lock — who can change the Shared Drive

Once someone has configured the Shared Drive ID, **only that same person**
(matched by their verified Google email) can change it afterward. Anyone
else who's signed in will see the field grayed out in Settings, and the
server rejects the change even if someone tries to force it directly — this
isn't just a UI restriction, it's enforced on the backend.

**If the admin leaves the org and someone else needs to change it:** there's
no in-app "transfer admin" button yet. The reset path is manual: in your
Netlify dashboard, go to the site's **Blobs** panel, find the
`fundigo-pointers` store, and delete the entry for your org's domain
(`org:yourorg.org`). The next person to open Settings and enter a Shared
Drive ID becomes the new admin. This clears the *pointer* only — nothing
about the actual spreadsheet or its data is touched.
