/**
 * ============================================================
 * sheets-storage.js — Tier 2b: window.storage over Google Sheets
 * Fundigo
 *
 * REPLACES org-storage.js. Same window.storage.get/set contract
 * that config.js/tracker.js already expect, but the actual data
 * never touches Netlify:
 *
 *   Browser ──(profile/tracker JSON)──> Google Sheets API directly
 *   Browser ──(spreadsheetId only)────> Netlify org-pointer.js
 *
 * FIRST-TIME SETUP PER ORG (one person does this once):
 *   1. They sign in, get prompted for a second consent screen
 *      (Sheets access — see auth.js requestSheetsAccessToken).
 *   2. This file creates a new spreadsheet named
 *      "Fundigo — {domain} — Data" in THAT person's Drive.
 *   3. The spreadsheet ID is saved to org-pointer.js (just the ID).
 *   4. That person needs to manually share the spreadsheet with
 *      teammates (Drive's native Share dialog — "Anyone at
 *      ere.org with the link" is the easiest option for a
 *      Workspace domain). This app cannot do that step for you —
 *      Sheets sharing is a Drive permission, not something the
 *      'spreadsheets' scope can grant on its own.
 *   5. After sharing, teammates who sign in on that domain will
 *      find the existing spreadsheet via the pointer automatically
 *      — no setup needed on their end.
 *
 * SHEET LAYOUT:
 *   Tab "Profile": two columns, Field | Value (one row per profile key)
 *   Tab "Tracker": header row = union of keys across all tracker
 *     rows, one row per opportunity. Non-primitive values (arrays,
 *     nested objects) are stored as JSON text in that cell.
 * ============================================================
 */

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
// Cloud Run function URL — was a relative Netlify path
// ("/.netlify/functions/org-pointer") when site + function shared a
// domain. Now cross-origin (GitHub Pages calling *.run.app), so this
// must be the full URL. See gcp-functions/org-pointer/ for the source.
const ORG_POINTER_ENDPOINT = "https://org-pointer-604500199210.us-central1.run.app";

let _spreadsheetIdCache = null;
let _pointerCache = null; // { sharedDriveId, spreadsheetId } — org domains only

function keyToSheetTab(key) {
  // NOTE: config.js declares `const CONFIG = {...}` at top level.
  // In a classic (non-module) script, top-level const/let create a
  // global-scope binding accessible by bare name everywhere — but
  // do NOT attach to `window`. So `window.CONFIG` is always
  // undefined even though bare `CONFIG` works fine. Checking
  // `typeof CONFIG` (not `window.CONFIG`) is the correct test here.
  if (typeof CONFIG === "undefined") return null;
  if (key === CONFIG.tracker.profileKey) return "Profile";
  if (key === CONFIG.tracker.storageKey) return "Tracker";
  return null;
}

async function driveFetch(pathSuffix, options = {}) {
  const token = await requestSheetsAccessToken();
  const res = await fetch(`${DRIVE_API}${pathSuffix}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Drive API error (${res.status})`);
  }
  return res.json();
}

async function sheetsFetch(path, options = {}) {
  const token = await requestSheetsAccessToken();
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Sheets API error (${res.status})`);
  }
  return res.json();
}

async function fetchPointer(idToken) {
  const res = await fetch(ORG_POINTER_ENDPOINT, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) return { sharedDriveId: null, spreadsheetId: null };
  return res.json();
}

async function savePointer(idToken, partial) {
  const res = await fetch(ORG_POINTER_ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(partial),
  });
  if (res.status === 403) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.error || "Only the org's admin can change this.");
    err.code = "NOT_AUTHORIZED";
    err.configuredBy = detail.configuredBy;
    throw err;
  }
  if (!res.ok) throw new Error("Could not save org pointer");
  return res.json();
}

/**
 * Called from Settings when the founder pastes their Shared
 * Drive ID for the first time. Just saves the pointer field —
 * spreadsheet creation happens lazily on next data access.
 * @param {string} sharedDriveId
 */
async function setOrgSharedDrive(sharedDriveId) {
  const idToken = getIdToken();
  if (!idToken) throw new Error("Not signed in");
  const saved = await savePointer(idToken, { sharedDriveId: sharedDriveId.trim() });
  _pointerCache = saved;
  _spreadsheetIdCache = null; // force re-resolution against the new drive
  return saved;
}

/**
 * @returns {Promise<{sharedDriveId:string|null, spreadsheetId:string|null}>}
 */
async function getOrgPointerStatus() {
  const idToken = getIdToken();
  if (!idToken) return { sharedDriveId: null, spreadsheetId: null };
  _pointerCache = await fetchPointer(idToken);
  return _pointerCache;
}

/**
 * Create a new spreadsheet INSIDE the org's Shared Drive via the
 * Drive API (Sheets API's own .create endpoint can't target a
 * Shared Drive — this is why drive.file scope is needed alongside
 * the spreadsheets scope). The Shared Drive owns the resulting
 * file, not whichever person happened to trigger this call.
 * @param {string} sharedDriveId
 * @param {string} title
 * @returns {Promise<string>} the new spreadsheetId
 */
async function createSpreadsheetInSharedDrive(sharedDriveId, title) {
  const created = await driveFetch("?supportsAllDrives=true", {
    method: "POST",
    body: JSON.stringify({
      name: title,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [sharedDriveId],
    }),
  });
  // Add the Profile/Tracker tabs via the Sheets API now that the
  // file exists (Drive API creates a blank single-sheet file).
  await sheetsFetch(`/${created.id}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, title: "Profile" }, fields: "title" } },
        { addSheet: { properties: { title: "Tracker" } } },
      ],
    }),
  });
  return created.id;
}

/**
 * Create a personal (non-shared) spreadsheet for public-domain
 * users (gmail.com etc.) who have no org and no Shared Drive.
 * Unchanged behavior from the Tier 2b design.
 */
async function createPersonalSpreadsheet(title) {
  const data = await sheetsFetch("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: "Profile" } }, { properties: { title: "Tracker" } }],
    }),
  });
  return data.spreadsheetId;
}

/**
 * Resolve this org's spreadsheet ID.
 * - Public email domains: personal spreadsheet, ID kept in the
 *   user's own browser only (never touches Netlify at all).
 * - Org domains: REQUIRES a founder-configured Shared Drive.
 *   Throws SHARED_DRIVE_NOT_CONFIGURED if none is set yet — the
 *   UI catches this and points the person to Settings, rather
 *   than silently falling back to someone's personal Drive (that
 *   fallback is exactly the ownership risk this version exists
 *   to avoid).
 * @returns {Promise<string>} spreadsheetId
 */
async function getOrCreateOrgSpreadsheet() {
  if (_spreadsheetIdCache) return _spreadsheetIdCache;

  const user = getSignedInUser();
  const domain = (user?.email || "").split("@")[1] || "";
  const isPublicDomain = ["gmail.com","googlemail.com","yahoo.com","outlook.com",
    "hotmail.com","live.com","icloud.com","aol.com","protonmail.com"].includes(domain);

  if (isPublicDomain) {
    const localKey = `fundigo_sheet_id_${user.email}`;
    const cached = localStorage.getItem(localKey);
    if (cached) { _spreadsheetIdCache = cached; return cached; }
    const created = await createPersonalSpreadsheet(`Fundigo — ${user.email} — Data`);
    localStorage.setItem(localKey, created);
    _spreadsheetIdCache = created;
    return created;
  }

  const idToken = getIdToken();
  const pointer = await fetchPointer(idToken);
  _pointerCache = pointer;

  if (!pointer.sharedDriveId) {
    const err = new Error(
      "No Shared Drive configured for your org yet. Ask your founder/admin to " +
      "set one up in Settings — this keeps grant data owned by the org, not " +
      "any one person's account."
    );
    err.code = "SHARED_DRIVE_NOT_CONFIGURED";
    throw err;
  }

  if (pointer.spreadsheetId) {
    _spreadsheetIdCache = pointer.spreadsheetId;
    return pointer.spreadsheetId;
  }

  // Shared Drive exists but no spreadsheet yet — first data access
  // for this org creates it, inside the drive, and registers it.
  const created = await createSpreadsheetInSharedDrive(pointer.sharedDriveId, `Fundigo — ${domain} — Data`);
  await savePointer(idToken, { spreadsheetId: created });
  _spreadsheetIdCache = created;

  showToast && showToast("Created your team's spreadsheet in your org's Shared Drive.");

  return created;
}

/**
 * @returns {string} a direct link to the org's spreadsheet, for
 *   display in Settings so someone can share it with teammates.
 */
async function getOrgSpreadsheetLink() {
  const id = await getOrCreateOrgSpreadsheet();
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

// ── Profile: Field | Value rows ────────────────────────────────
async function readProfileFromSheet(spreadsheetId) {
  const data = await sheetsFetch(`/${spreadsheetId}/values/Profile!A:B`);
  const rows = data.values || [];
  const obj = {};
  for (const [field, value] of rows) {
    if (field) obj[field] = value;
  }
  return obj;
}

async function writeProfileToSheet(spreadsheetId, profileObj) {
  const rows = Object.entries(profileObj).map(([k, v]) => [k, String(v ?? "")]);
  // The range in the URL and the range in the body MUST match exactly —
  // Google's Sheets API rejects a mismatch with a 400 (this was a real
  // bug: URL said "Profile!A1:B{n}", body said just "Profile!A1").
  const range = `Profile!A1:B${rows.length}`;
  await sheetsFetch(`/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range, values: rows }),
  });
}

// ── Tracker: header row = union of keys, one row per opportunity ──
function cellToValue(cell, fieldName) {
  if (cell === undefined || cell === "") return "";
  if (fieldName === "id") return cell; // never reinterpret IDs — must stay a stable string
  try {
    return JSON.parse(cell); // recovers numbers, booleans, arrays, objects
  } catch (e) {
    return cell; // not valid JSON → it's a genuine string, return as-is
  }
}

function valueToCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v; // strings stored literally, not JSON-quoted
  return JSON.stringify(v); // numbers/booleans/arrays/objects → JSON so type survives the round trip
}

async function readTrackerFromSheet(spreadsheetId) {
  const data = await sheetsFetch(`/${spreadsheetId}/values/Tracker!A:Z`);
  const rows = data.values || [];
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => {
      const obj = {};
      header.forEach((field, i) => { obj[field] = cellToValue(r[i], field); });
      return obj;
    });
}

async function writeTrackerToSheet(spreadsheetId, rows) {
  // Union of keys across all rows, "id" pinned first for readability.
  const keySet = new Set(["id"]);
  rows.forEach((r) => Object.keys(r).forEach((k) => keySet.add(k)));
  const header = Array.from(keySet);

  const values = [header, ...rows.map((r) => header.map((k) => valueToCell(r[k])))];

  // Same fix as writeProfileToSheet above — URL range and body range
  // must be identical or Google's API returns 400.
  const range = `Tracker!A1:${colLetter(header.length)}${values.length}`;
  await sheetsFetch(`/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range, values }),
  });
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── window.storage contract (same shape config.js/tracker.js expect) ──
window.storage = {
  async get(key) {
    const tab = keyToSheetTab(key);
    if (!tab) return null;
    if (window._isGuest) return null; // guest mode — caller falls back to localStorage, no Sheets/OAuth attempt at all
    try {
      const spreadsheetId = await getOrCreateOrgSpreadsheet();
      const value = tab === "Profile"
        ? await readProfileFromSheet(spreadsheetId)
        : await readTrackerFromSheet(spreadsheetId);
      return { value: JSON.stringify(value) };
    } catch (err) {
      if (err.code === "SHARED_DRIVE_NOT_CONFIGURED") {
        showSharedDriveWarning && showSharedDriveWarning();
        // Deliberately still return null so the caller's localStorage
        // fallback applies — but the warning banner makes clear that
        // fallback is NOT shared with the team, unlike silent failure.
      } else {
        console.warn("sheets-storage get failed, caller will fall back to localStorage:", err.message);
      }
      return null;
    }
  },

  async set(key, jsonString) {
    const tab = keyToSheetTab(key);
    if (!tab) throw new Error("Not a Sheets-backed key");
    if (window._isGuest) throw new Error("Guest mode — saved to this browser only"); // caller falls back to localStorage
    let value;
    try { value = JSON.parse(jsonString); } catch (e) { value = jsonString; }

    let spreadsheetId;
    try {
      spreadsheetId = await getOrCreateOrgSpreadsheet();
    } catch (err) {
      if (err.code === "SHARED_DRIVE_NOT_CONFIGURED") showSharedDriveWarning && showSharedDriveWarning();
      throw err; // still re-throw — caller falls back to localStorage
    }

    if (tab === "Profile") {
      await writeProfileToSheet(spreadsheetId, value);
    } else {
      await writeTrackerToSheet(spreadsheetId, value);
    }
    return { ok: true };
  },
};

let _sharedDriveWarningShown = false;
/**
 * Shown when an org-domain user tries to read/write data but no
 * Shared Drive has been configured yet. Deliberately visible (not
 * just a console warning) — silently falling back to a private
 * localStorage copy would look like it's working while actually
 * being invisible to the rest of the team.
 */
function showSharedDriveWarning() {
  if (_sharedDriveWarningShown) return;
  _sharedDriveWarningShown = true;
  showToast && showToast(
    "⚠️ No shared Google Drive set up for your org yet — your changes " +
    "are only saved on this device. Ask your founder/admin to configure " +
    "it in Settings → Team data."
  );
}