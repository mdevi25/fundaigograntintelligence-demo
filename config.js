/**
 * ============================================================
 * AI-Powered Grant Discovery System — config.js
 * Version: 2.0 | July 2026
 *
 * Organization: Educate. Radiate. Elevate. (ERE)
 * Repo:         github.com/mdevi25/fundigo-gip
 * Cost:         $0.00 — one Groq API key covers all layers
 *
 * ── ARCHITECTURE (5 layers, 1 key) ──────────────────────────
 *
 *  LAYER 1   — Discovery
 *              Model: groq/compound
 *              Live web search, returns grant candidates + URLs
 *
 *  LAYER 1.5 — Link Verification
 *              Model: groq/compound (visit_website tool)
 *              Visits every discovered URL server-side
 *              VERIFIED + resolved REDIRECTS → proceed
 *              DEAD + LOGIN WALL + NEEDS CHECK → silently dropped
 *              Only clean, working, grant-relevant URLs continue
 *
 *  LAYER 2   — Qualification & Scoring
 *              Model: openai/gpt-oss-120b
 *              Fit score 1–5, mission alignment, risks,
 *              recommended action — runs on verified URLs only
 *
 *  LAYER 2.5 — Guard (Language, Bias, Accuracy)
 *              Model: openai/gpt-oss-safeguard-20b
 *              Checks language quality, bias, accuracy flags,
 *              nonprofit appropriateness
 *              PASS → renders normally in UI
 *              FLAG → renders with warning badge, staff reviews
 *
 *  LAYER 3   — Grant Tracker
 *              Persistent in-app pipeline table
 *              Only verified, qualified, guard-passed results
 *              Columns include link status + date verified
 *
 *  LAYER 4   — Proposal Draft (manual)
 *              NotebookLM bridge — staff pastes RFP + org docs
 *              No invented stats, budgets, or testimonials
 *
 *  LAYER 5   — Human Review
 *              Staff edits, approves, and submits every application
 *              AI is decision support — never decision maker
 *
 * ── HOW TO SWAP A PROVIDER ──────────────────────────────────
 *  Change ONE model string in the relevant layer block below.
 *  Nothing else in the codebase needs to change.
 *
 * ── API KEY RULE ────────────────────────────────────────────
 *  Keys are NEVER hardcoded here or anywhere in source code.
 *  User enters the Groq key in the Settings tab at runtime.
 *  Key lives in sessionStorage only — cleared on tab close.
 * ============================================================
 */

const CONFIG = {

  // ============================================================
  // LAYER 1 — DISCOVERY
  // ============================================================
  // Model:    groq/compound
  // Function: Searches the live web for currently OPEN grant
  //           opportunities matching the org profile.
  //           Returns up to maxResults candidates with:
  //             - funder name
  //             - grant program name
  //             - funding amount or range
  //             - application deadline
  //             - eligibility summary
  //             - source URL (unverified at this stage)
  //
  // SWAP OPTIONS (change model string only):
  //   "groq/compound"       → current — up to 10 web searches per call
  //   "groq/compound-mini"  → faster, single search, lower latency
  //                           use if discovery is timing out
  // ============================================================
  // ============================================================
  // FEEDBACK
  // Where in-app feedback submissions get sent. This is a single
  // app-wide destination (the developer's own inbox), not an
  // org-specific setting like the Shared Drive ID, so it lives
  // here in config.js rather than in each org's own profile.
  //
  // Paste the Web App URL from your deployed Apps Script (see
  // fundaigo-feedback-apps-script.gs for the one-time setup).
  // Leave blank to hide the Feedback link entirely.
  // ============================================================
  feedback: {
    webhookUrl: "https://script.google.com/macros/s/AKfycbySp2FQcdKogW0xJOg1_8w3QMlagOanJb9Kh771HMW-wdMVB7Xfd58daRoVmzM2rIzauw/exec", // <-- paste your Apps Script Web App URL here
  },

  discovery: {
    endpoint:    "https://api.groq.com/openai/v1/chat/completions",
    model:       "compound-beta-mini",
    maxTokens:   2000,
    temperature: 0.2,
    maxResults:  1,
                        // hard cap, enforced in discovery.js by slicing
                        // the model's response — "one result per run" is
                        // a real guarantee, not just a prompt request.
  },

  // ============================================================
  // LAYER 1.5 — LINK VERIFICATION
  // ============================================================
  // Model:    groq/compound (same key, visit_website built-in tool)
  // Function: Visits every URL returned by Layer 1 server-side.
  //           No CORS issues — Groq handles the fetch.
  //           Assigns one of five statuses to each URL:
  //
  //   ✅ VERIFIED   — page loads + grant content confirmed
  //                   keywords: apply, deadline, eligibility,
  //                   grant, funding, rfp, proposal, submit
  //   ⚠️ REDIRECTS  — URL redirects; final destination checked;
  //                   if destination is valid → treated as VERIFIED
  //                   both original URL and final URL are logged
  //   ❌ DEAD        → FILTERED OUT — 404, timeout, no content
  //   🔒 LOGIN WALL  → FILTERED OUT — requires login to access
  //   📋 NEEDS CHECK → FILTERED OUT — could not verify at all
  //
  // FILTER RULE (locked — do not change):
  //   Only VERIFIED and resolved REDIRECTS proceed to Layer 2.
  //   DEAD, LOGIN WALL, NEEDS CHECK are silently dropped.
  //   Dropped URLs are never logged to the tracker.
  //   Reason: keeps the pipeline clean, results grounded,
  //           storage lean — no dead weight in the database.
  //
  // WHAT GETS DOCUMENTED per verified URL:
  //   - url              original URL from discovery
  //   - finalUrl         resolved URL if redirected, else same
  //   - linkStatus       VERIFIED or REDIRECTS
  //   - pageTitle        title tag of the destination page
  //   - keywordsFound    which grant keywords were detected
  //   - dateVerified     ISO date string of verification run
  //
  // SWAP OPTIONS:
  //   Uses groq/compound — no separate model needed.
  //   visit_website is a built-in tool, no extra config.
  // ============================================================
  linkVerification: {
    endpoint:    "https://api.groq.com/openai/v1/chat/completions",
    model:       "groq/compound",   // same model as Layer 1
    maxTokens:   2000,
    temperature: 0.1,               // very low — deterministic status output

    // Keywords that confirm a page contains grant/funding content.
    // If none of these appear on the visited page, URL is NEEDS CHECK.
    grantKeywords: [
      "apply", "application", "deadline", "eligibility",
      "grant", "funding", "rfp", "request for proposal",
      "proposal", "submit", "award", "nonprofit", "501(c)(3)",
      "letter of intent", "loi", "guidelines", "open",
    ],

    // Statuses that PASS the filter and proceed to Layer 2
    passingStatuses: ["VERIFIED", "REDIRECTS", "NEEDS_CHECK", "NEEDS CHECK"],

    // Statuses that are DROPPED silently — never reach tracker
    droppedStatuses: ["DEAD", "LOGIN WALL"],
  },

  // ============================================================
  // LAYER 2 — QUALIFICATION & SCORING
  // ============================================================
  // Model:    openai/gpt-oss-120b (open-weight, free on Groq)
  // Function: Receives verified grant candidates from Layer 1.5.
  //           Evaluates each against the org profile and returns
  //           structured JSON with:
  //             - fitScore         1–5 (see fitLabels below)
  //             - missionAlignment one sentence explanation
  //             - geoEligibility   does funder cover IL or TX?
  //             - orgEligibility   does ERE meet requirements?
  //             - appStatus        OPEN / OPEN–Rolling / OPENS SOON
  //             - deadline         YYYY-MM-DD or Rolling
  //             - amount           funding range as string
  //             - risks            flags: LOI / matching funds /
  //                                invitation-only / complex compliance
  //             - recommendedAction see actionOptions below
  //             - confidence       High / Medium / Low
  //             - whyQualifies     one sentence summary for staff
  //
  // FILTER: opportunities with fitScore below minFitScore
  //         are dropped before reaching the guard layer.
  //
  // SWAP OPTIONS (change model string only):
  //   "openai/gpt-oss-120b"  → current — best quality, free on Groq
  //   "qwen/qwen3.6-27b"     → strong reasoning, free on Groq
  //   "openai/gpt-oss-20b"   → faster, lighter, free on Groq
  //                            use if qualification is slow
  // ============================================================
  qualification: {
    endpoint:    "https://api.groq.com/openai/v1/chat/completions",
    model:       "openai/gpt-oss-120b",
    maxTokens:   1500,
    temperature: 0.1,   // very low = consistent, structured scoring
    minFitScore: 2,     // drop opportunities scoring below this
                        // 1 = poor fit, never worth pursuing
                        // 2 = weak but possible edge case
                        // raise to 3 to tighten the pipeline
  },

  // ============================================================
  // LAYER 2.5 — GUARD (Language, Bias, Accuracy)
  // ============================================================
  // Model:    openai/gpt-oss-safeguard-20b (free on Groq)
  //           Replaced meta-llama/llama-guard-4-12b (deprecated
  //           February 10, 2026 per Groq deprecation docs)
  //
  // Function: Runs AFTER qualification, BEFORE results reach UI.
  //           Checks every qualification output for:
  //
  //   CHECK 1 — LANGUAGE QUALITY
  //     Is the language professional and grant-appropriate?
  //     No jargon, no overpromising, no inflammatory terms?
  //     Suitable for a nonprofit staff member to act on?
  //
  //   CHECK 2 — BIAS DETECTION
  //     Geographic bias in funder descriptions?
  //     Racial or demographic bias in eligibility framing?
  //     Socioeconomic bias in how populations are described?
  //     ERE serves diverse communities — language must reflect that.
  //
  //   CHECK 3 — ACCURACY FLAGS
  //     Are claims stated as facts that should be "Needs Verification"?
  //     Absolute statements about deadlines or amounts unconfirmed?
  //     Any fabricated statistics or invented partnerships?
  //
  //   CHECK 4 — NONPROFIT APPROPRIATENESS
  //     Is tone appropriate for ERE's mission and reputation?
  //     Nothing that could harm ERE's relationships with funders?
  //
  // OUTPUT (per opportunity):
  //   guardStatus:  "PASS" or "FLAG"
  //   guardIssues:  [] array of specific issues found (if FLAG)
  //   guardNote:    one sentence summary for staff
  //
  // GUARD MODE (locked — soft flag):
  //   PASS → result renders normally in UI
  //   FLAG → result renders with ⚠️ warning badge
  //           staff sees exactly what was flagged
  //           staff decides whether to act on it
  //   Reason: hard blocking risks dropping valid grants
  //           due to false positives. Human decides. Always.
  //
  // SWAP OPTIONS (change model string only):
  //   "openai/gpt-oss-safeguard-20b" → current (Groq recommended)
  //   Note: llama-guard-4-12b deprecated Feb 10 2026 — do not use
  // ============================================================
  guard: {
    endpoint:    "https://api.groq.com/openai/v1/chat/completions",
    model:       "openai/gpt-oss-safeguard-20b",
    maxTokens:   1000,
    temperature: 0.0,   // zero = fully deterministic safety checks

    // Guard runs in SOFT FLAG mode (not hard block)
    // true  = FLAG results shown with warning badge (recommended)
    // false = FLAG results hidden entirely (not recommended)
    softFlag:    true,

    // Checks to run — set false to disable individual checks
    checks: {
      languageQuality:          true,
      biasDetection:            true,
      accuracyFlags:            true,
      nonprofitAppropriateness: true,
    },
  },

  // ============================================================
  // LAYER 3 — GRANT TRACKER
  // ============================================================
  // Storage: window.storage (persistent, personal scope)
  //          Falls back to localStorage if unavailable.
  //
  // Only opportunities that pass ALL of the following enter:
  //   ✅ Link status is VERIFIED or resolved REDIRECTS
  //   ✅ Fit score meets or exceeds minFitScore
  //   ✅ Guard status is PASS (or FLAGGED with staff awareness)
  //
  // Tracker columns (in order):
  //   Funder | Program | Amount | Deadline | Fit Score |
  //   Status | URL | Link Status | Page Title | Date Verified |
  //   Assigned To | Notes | Date Found | Guard Status
  // ============================================================
  tracker: {
    storageKey:  "ere-grant-tracker-rows",
    profileKey:  "ere-org-profile",
    maxRows:     500,

    // Deadline urgency thresholds (days from today)
    urgentDays:  14,    // red badge  — act immediately
    soonDays:    30,    // amber badge — act this week
                        // > 30 days  — green badge — on track
  },

  // ============================================================
  // LAYER 4 — PROPOSAL DRAFT (manual step)
  // ============================================================
  // Tool:     Google NotebookLM (free, no API needed)
  // Function: Staff pastes winning opportunity RFP +
  //           org documents into NotebookLM.
  //           NotebookLM drafts proposal grounded in real ERE data.
  //
  // RULES (enforced by UI instructions, not code):
  //   - Use ONLY information supplied by the organization
  //   - Never invent statistics, budgets, or testimonials
  //   - Missing information → clearly marked placeholder
  //   - Staff reviews, edits, and approves before submitting
  //
  // This tab in the UI provides:
  //   - Step-by-step NotebookLM instructions
  //   - Document checklist (what to upload)
  //   - Placeholder list (what to fill in before submitting)
  // ============================================================
  proposal: {
    notebookLMUrl: "https://notebooklm.google.com",

    // Core documents ERE should upload to NotebookLM once
    requiredDocs: [
      "Mission, vision, and values statement",
      "Program descriptions (tutoring, test prep, soft skills)",
      "Student outcome data and impact statistics",
      "IRS 501(c)(3) determination letter",
      "Past funders list",
      "Annual budget overview (high level)",
      "Student testimonials and parent quotes",
      "Geographic service areas (cities, zip codes)",
    ],
  },

  // ============================================================
  // LAYER 5 — HUMAN REVIEW
  // ============================================================
  // No model. No API. Staff only.
  // Every application is reviewed, edited, and submitted
  // by a staff member. AI assists — humans decide. Always.
  // ============================================================

  // ============================================================
  // DEFAULT ORGANIZATION PROFILE
  // ============================================================
  // Loaded when no saved profile exists in storage.
  // User overrides this in the Profile tab — saved persistently.
  // This deployment is shared with the ERE team only.
  // ============================================================
  defaultProfile: {
    name:           "Educate. Radiate. Elevate.",
    type:           "501(c)(3) nonprofit",
    mission:        "Provide free, high-quality tutoring, academic support, and educational enrichment for underserved K-12 students, helping them achieve academic success and long-term educational equity.",
    locations:      "Illinois, Texas",
    serviceAreas:   "Chicago-area communities, Texas communities",
    focus: [
      "Education equity",
      "Academic achievement",
      "Tutoring and test preparation",
      "Soft skills development",
      "Trauma-informed education",
      "Culturally responsive teaching",
      "Achievement gap reduction",
    ],
    population:       "Low-income and underserved K-12 students from underrepresented communities",
    budget:           "Under $500,000 annual operating budget",
    grantRange:       "$5,000 – $100,000",
    deadlineWindow:   "Open opportunities closing within 90 days",
    excludeFunders:   "", // comma-separated known funders to skip
                          // user fills this in before each search run
  },

  // ============================================================
  // FIT SCORE LABELS
  // Used in UI display and qualification prompt
  // ============================================================
  fitLabels: {
    5: "Excellent fit — pursue immediately",
    4: "Strong fit — high priority",
    3: "Moderate fit — worth reviewing",
    2: "Weak fit — edge case only",
    1: "Poor fit — do not pursue",
  },

  // ============================================================
  // GRANT TRACKER STATUS OPTIONS
  // Dropdown values for the Status column in Layer 3
  // ============================================================
  statusOptions: [
    "New",          // just entered tracker, not yet reviewed
    "Pursue",       // staff has decided to apply
    "Submitted",    // application sent
    "Funded",       // grant awarded
    "Declined",     // application rejected
    "Not Eligible", // reviewed — ERE does not qualify
    "Defer",        // revisit next funding cycle
  ],

  // ============================================================
  // APPLICATION STATUS OPTIONS
  // Returned by Layer 2 qualification for each opportunity
  // ============================================================
  appStatusOptions: [
    "OPEN",             // currently accepting applications
    "OPEN – Rolling",   // accepts applications year-round
    "OPENS SOON",       // cycle not yet open but confirmed upcoming
    "NEEDS VERIFICATION", // status could not be confirmed
  ],

  // ============================================================
  // RECOMMENDED ACTION OPTIONS
  // Returned by Layer 2 qualification for each opportunity
  // ============================================================
  actionOptions: [
    "Apply Immediately",    // deadline within 14 days or excellent fit
    "High Priority",        // strong fit, pursue this week
    "Review This Week",     // moderate fit, needs staff review
    "Needs Verification",   // data unconfirmed, check before acting
    "Monitor Future Cycle", // good fit but cycle currently closed
    "Do Not Pursue",        // poor fit or ineligible
  ],

  // ============================================================
  // LINK STATUS OPTIONS
  // Assigned by Layer 1.5 link verification
  // ============================================================
  linkStatusOptions: {
    VERIFIED:     "✅ VERIFIED",     // passes — enters pipeline
    REDIRECTS:    "⚠️ REDIRECTS",    // passes if destination valid
    DEAD:         "❌ DEAD",          // dropped — never documented
    LOGIN_WALL:   "🔒 LOGIN WALL",   // dropped — never documented
    NEEDS_CHECK:  "📋 NEEDS CHECK",  // dropped — never documented
  },

  // ============================================================
  // GUARD STATUS OPTIONS
  // Assigned by Layer 2.5 guard check
  // ============================================================
  guardStatusOptions: {
    PASS: "✅ PASS",   // renders normally
    FLAG: "⚠️ FLAG",   // renders with warning badge
  },

  // ============================================================
  // BUILD META
  // ============================================================
  meta: {
    version:             "2.0.0",
    buildDate:           "2026-07-08",
    repo:                "https://github.com/mdevi25/fundigo-gip",
    totalCost:           "$0.00",
    apiKeysRequired:     1,
    apiProvider:         "Groq",
    modelsUsed: [
      "groq/compound",                  // Layer 1 discovery
      "groq/compound (visit_website)",  // Layer 1.5 link verification
      "openai/gpt-oss-120b",            // Layer 2 qualification
      "openai/gpt-oss-safeguard-20b",   // Layer 2.5 guard
    ],
  },
};


// ============================================================
// RUNTIME KEY MANAGEMENT
// ============================================================
// Keys live in sessionStorage ONLY.
// They are never written to localStorage, never in source code,
// never committed to the repo.
// sessionStorage clears automatically when the tab is closed.
// ============================================================

/**
 * Store an API key for a provider at runtime.
 * Called from the Settings tab when user enters their key.
 * @param {string} provider  e.g. "groq"
 * @param {string} key       the API key string
 */
function setApiKey(provider, key) {
  sessionStorage.setItem(`ere_key_${provider}`, key.trim());
}

/**
 * Retrieve a stored API key for a provider.
 * Returns null if not set.
 * @param {string} provider  e.g. "groq"
 * @returns {string|null}
 */
function getApiKey(provider) {
  return sessionStorage.getItem(`ere_key_${provider}`);
}

/**
 * Check whether an API key has been entered for a provider.
 * Used to gate discovery/qualification buttons in the UI.
 * @param {string} provider  e.g. "groq"
 * @returns {boolean}
 */
function hasApiKey(provider) {
  const key = getApiKey(provider);
  return Boolean(key && key.trim().length > 10);
}

/**
 * Remove a stored API key (e.g. on logout or key rotation).
 * @param {string} provider  e.g. "groq"
 */
function clearApiKey(provider) {
  sessionStorage.removeItem(`ere_key_${provider}`);
}


// ============================================================
// PROFILE MANAGEMENT
// ============================================================
// Org profile is saved to window.storage (persistent, personal).
// Falls back to localStorage if window.storage is unavailable.
// Profile powers the discovery prompt — update it in Profile tab.
// ============================================================

/**
 * Save the org profile to persistent storage.
 * @param {Object} profileObj  profile fields object
 */
async function saveProfile(profileObj) {
  const json = JSON.stringify(profileObj);
  try {
    if (window.storage) {
      await window.storage.set(CONFIG.tracker.profileKey, json);
    } else {
      localStorage.setItem(CONFIG.tracker.profileKey, json);
    }
  } catch (e) {
    // fallback — always try localStorage
    localStorage.setItem(CONFIG.tracker.profileKey, json);
  }
}

/**
 * Load the org profile from persistent storage.
 * Returns defaultProfile if nothing has been saved yet.
 * @returns {Promise<Object>}
 */
async function loadProfile() {
  try {
    let parsed = null;
    if (window.storage) {
      const r = await window.storage.get(CONFIG.tracker.profileKey);
      if (r && r.value) parsed = JSON.parse(r.value);
    }
    if (!parsed) {
      const local = localStorage.getItem(CONFIG.tracker.profileKey);
      if (local) parsed = JSON.parse(local);
    }
    if (parsed) {
      // Normalize: excludeFunders and focus must always be strings
      // Old saves may have stored them as arrays — convert back to string
      if (Array.isArray(parsed.excludeFunders)) {
        parsed.excludeFunders = parsed.excludeFunders.join(', ');
      }
      if (Array.isArray(parsed.focus)) {
        parsed.focus = parsed.focus.join(', ');
      }
      return parsed;
    }
  } catch (e) {
    // fall through to default
  }
  // Return a fresh copy of the default — never mutate CONFIG directly
  return {
    ...CONFIG.defaultProfile,
    focus: Array.isArray(CONFIG.defaultProfile.focus)
      ? CONFIG.defaultProfile.focus.join(', ')
      : CONFIG.defaultProfile.focus,
    excludeFunders: '',
  };
}


// ============================================================
// TRACKER ROW STORAGE
// ============================================================
// Rows are saved to window.storage (persistent, personal).
// Falls back to localStorage if window.storage unavailable.
// Only VERIFIED, qualified, guard-passed rows are ever saved.
// ============================================================

/**
 * Save all tracker rows to persistent storage.
 * @param {Array} rows  array of tracker row objects
 */
async function saveTrackerRows(rows) {
  const json = JSON.stringify(rows);
  try {
    if (window.storage) {
      await window.storage.set(CONFIG.tracker.storageKey, json);
    } else {
      localStorage.setItem(CONFIG.tracker.storageKey, json);
    }
  } catch (e) {
    localStorage.setItem(CONFIG.tracker.storageKey, json);
  }
}

/**
 * Load tracker rows from persistent storage.
 * Returns empty array if nothing saved yet.
 * @returns {Promise<Array>}
 */
async function loadTrackerRows() {
  try {
    if (window.storage) {
      const r = await window.storage.get(CONFIG.tracker.storageKey);
      if (r && r.value) return JSON.parse(r.value);
    }
    const local = localStorage.getItem(CONFIG.tracker.storageKey);
    if (local) return JSON.parse(local);
  } catch (e) {
    // fall through
  }
  return [];
}


// ============================================================
// SHARED UTILITIES
// ============================================================
// Used across discovery.js, qualification.js, tracker.js,
// guard.js, and index.html. Defined once here.
// ============================================================

/**
 * Generate a unique row ID for tracker entries.
 * Format: r + 8 random alphanumeric characters
 * @returns {string}
 */
function generateId() {
  return "r" + Math.random().toString(36).slice(2, 10);
}

/**
 * Return today's date as YYYY-MM-DD string.
 * Used for dateFound and dateVerified fields.
 * @returns {string}
 */
/**
 * Normalise a tracker status value that may still hold old terminology
 * from before the Pursuing→Pursue / Deferred→Defer rename. Rows added
 * before that rename still literally hold the old words in storage —
 * this recognises them consistently everywhere status gets compared,
 * without ever rewriting what's actually saved.
 * @param {string} status
 * @returns {string}
 */
function normaliseLegacyStatus(status) {
  const LEGACY_STATUS_ALIASES = { "Pursuing": "Pursue", "Deferred": "Defer" };
  return LEGACY_STATUS_ALIASES[status] || status;
}

function today() {
  return new Date().toISOString().split("T")[0];
}

/**
 * Calculate days from today until a deadline date string.
 * Returns null for Rolling or unverifiable dates.
 * Returns negative number if deadline has passed.
 * @param {string} dateStr  YYYY-MM-DD
 * @returns {number|null}
 */
function daysUntil(dateStr) {
  if (
    !dateStr ||
    dateStr === "Rolling" ||
    dateStr === "Needs Verification" ||
    dateStr === "NEEDS VERIFICATION"
  ) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date(today())) / 86400000);
}

/**
 * Return the CSS class for deadline urgency coloring.
 * Classes are defined in styles.css:
 *   .dl-pastdue  red   — deadline has passed
 *   .dl-urgent   red   — within urgentDays (default 14)
 *   .dl-soon     amber — within soonDays (default 30)
 *   .dl-ok       green — more than soonDays away
 * @param {string} dateStr  YYYY-MM-DD
 * @returns {string}  CSS class name
 */
function deadlineClass(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return "dl-rolling";
  if (days < 0)  return "dl-pastdue";
  if (days <= CONFIG.tracker.urgentDays) return "dl-urgent";
  if (days <= CONFIG.tracker.soonDays)   return "dl-soon";
  return "dl-ok";
}

/**
 * Return human-readable days label for deadline column.
 * @param {string} dateStr  YYYY-MM-DD
 * @returns {string}
 */
function daysLabel(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return "Rolling";
  if (days < 0)  return "Past due";
  if (days === 0) return "Due today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

/**
 * Safely escape a string for HTML output.
 * Prevents XSS when rendering API responses in the DOM.
 * Always use this before inserting untrusted content into innerHTML.
 * @param {*} s  any value
 * @returns {string}  HTML-safe string
 */
function esc(s) {
  return (s == null ? "" : String(s)).replace(
    /[&<>"']/g,
    (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[m])
  );
}

/**
 * Show a toast notification at the bottom of the screen.
 * Toast element must exist in index.html with id="toast".
 * @param {string} msg       message to display
 * @param {number} duration  milliseconds before auto-hide (default 2800)
 */
function showToast(msg, duration = 2800) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(
    () => t.classList.remove("show"),
    duration
  );
}

/**
 * Build the standard Groq API request headers.
 * Pulls the key from sessionStorage at call time — never cached.
 * @returns {Object}  headers object for fetch()
 */
function groqHeaders() {
  const key = getApiKey("groq");
  if (!key) throw new Error("Groq API key not set. Enter it in Settings.");
  return {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${key}`,
  };
}

/**
 * Make a Groq API call with standard error handling.
 * @param {string} endpoint   full URL
 * @param {Object} body       request body object (will be JSON.stringify'd)
 * @returns {Promise<Object>} parsed response JSON
 * @throws {Error}            on network or API error
 */
async function groqCall(endpoint, body) {
  const resp = await fetch(endpoint, {
    method:  "POST",
    headers: groqHeaders(),
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    // Surface the Groq error message clearly for debugging
    throw new Error(
      `Groq API error ${resp.status}: ${errText.slice(0, 300)}`
    );
  }
  return resp.json();
}

/**
 * Extract text content from a Groq API response.
 * Handles both standard and compound (multi-block) responses.
 * @param {Object} data  parsed Groq API response
 * @returns {string}     concatenated text content
 */
function extractText(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return "";
  // Standard response — content is a string
  if (typeof msg.content === "string") return msg.content;
  // Compound response — content is an array of blocks
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Extract a tagged block from a text string.
 * Used to reliably parse structured JSON from model responses.
 * Example: extractTagged(text, "RESULTS_JSON") pulls content
 *          from between <RESULTS_JSON>...</RESULTS_JSON> tags.
 * @param {string} text  full response text
 * @param {string} tag   tag name to extract
 * @returns {string|null}
 */
function extractTagged(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Safely parse JSON, stripping markdown code fences if present.
 * Models sometimes wrap JSON in ```json ... ``` — this handles that.
 * @param {string} str  raw string from model
 * @returns {Object|null}  parsed object, or null on failure
 */
function safeParseJSON(str) {
  if (!str) return null;
  // Strip ```json and ``` fences
  const clean = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("JSON parse failed:", e.message, "\nInput:", clean.slice(0, 200));
    return null;
  }
}
