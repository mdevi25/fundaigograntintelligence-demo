/**
 * ============================================================
 * discovery.js — Layer 1: Grant Discovery
 * AI-Powered AI-Powered Grant Intelligence for Nonprofits
 * Version: 2.0 | July 2026
 *
 * WHAT THIS FILE DOES:
 * Runs the weekly grant discovery search using groq/compound.
 * Takes the org profile, builds a structured search prompt,
 * calls the Groq Compound API (which uses web_search built-in),
 * parses the raw results, and hands them to Layer 1.5
 * (link verification in linkVerification.js) before anything
 * reaches the qualification layer or the UI.
 *
 * WHAT THIS FILE DOES NOT DO:
 * - Does not verify URLs (that is Layer 1.5)
 * - Does not score or qualify results (that is Layer 2)
 * - Does not render anything to the UI directly
 * - Does not store anything to the tracker
 *
 * API FACTS (verified from Groq docs, July 2026):
 * - Endpoint: https://api.groq.com/openai/v1/chat/completions
 * - Model: groq/compound
 * - Tools: web_search enabled via compound_custom.tools.enabled_tools
 * - visit_website: requires "Groq-Model-Version: latest" header
 * - max_completion_tokens: 3000–4000 recommended for tool-heavy calls
 * - Response: choices[0].message.content (string)
 * - Executed tools: choices[0].message.executed_tools (array)
 * - No custom/local tools supported — built-in only
 *
 * DEPENDENCIES:
 * - config.js must be loaded first (CONFIG, groqCall, extractText,
 *   extractTagged, safeParseJSON, today, esc)
 * ============================================================
 */


// ============================================================
// DISCOVERY SYSTEM PROMPT
// Tells groq/compound exactly what to search for and how to
// structure its output so we can parse it reliably.
// ============================================================

/**
 * Build the system prompt for the discovery search.
 * Injected once per API call as the system message.
 * @returns {string}
 */
function buildDiscoverySystemPrompt() {
  return `You are a grant discovery specialist for small nonprofits.
Your job is to search the live web for currently OPEN funding opportunities
that match the organization profile you are given.

SEARCH STRATEGY:
Search across ALL of these funder categories in separate searches:
1. Community foundations (Illinois and Texas)
2. Corporate giving programs (unpublicized funders)
3. Government grants (federal, state, Title I)
4. Faith-based funders (churches, dioceses)
5. Family foundations (private, rarely publicized)
6. University foundations (Illinois and Texas)
7. Healthcare foundations (health equity, social determinants)

STRICT VALIDATION RULES — only include an opportunity if ALL are true:
- Application is currently OPEN or rolling (accepting submissions today)
- Deadline is on or after today's date (${today()})
- An official application page exists with a real URL
- The funder is NOT on the exclusion list provided

NEVER include:
- Expired opportunities or closed cycles
- Archived announcements or past award lists
- Blog posts or news articles about grants
- Opportunities requiring school district sponsorship
- Invitation-only programs
- Opportunities clearly outside the org's budget range

For each opportunity found, you MUST include a direct official URL.
If you cannot find an official URL, do NOT include the opportunity.

OUTPUT FORMAT — respond ONLY with valid JSON inside these exact tags,
with NO text before or after the tags, NO markdown fences:

<DISCOVERY_JSON>
{
  "searchDate": "YYYY-MM-DD",
  "totalSearched": 0,
  "opportunities": [
    {
      "id": "unique 8-char alphanumeric",
      "funder": "Full legal funder name",
      "program": "Specific grant program name",
      "amount": "$X,XXX – $XX,XXX or specific amount",
      "appStatus": "OPEN | OPEN – Rolling | OPENS SOON",
      "deadline": "YYYY-MM-DD or Rolling",
      "deadlineNote": "e.g. Letter of Intent due first",
      "geoEligibility": "States or regions eligible",
      "orgEligibility": "501(c)(3) required, size limits, etc.",
      "focusAreas": ["area1", "area2"],
      "url": "https://official-application-url.org/grants",
      "sourceNote": "Where this was found (funder site, IRS 990, etc.)",
      "flags": ["LOI required", "matching funds", "invitation-only", "complex compliance"],
      "confidence": "High | Medium | Low"
    }
  ],
  "futureMonitoring": [
    {
      "funder": "Funder name",
      "reason": "Why it is a strong future fit",
      "cycleNote": "When cycle may reopen if known",
      "url": "https://funder-homepage.org"
    }
  ]
}
</DISCOVERY_JSON>

Keep all string values concise — one short phrase or sentence maximum.
The flags array should be empty [] if no special requirements apply.
Confidence reflects how well you verified status and deadline from official sources.`;
}


// ============================================================
// DISCOVERY USER PROMPT
// The actual search request — built from the org profile.
// Changes every run as the exclude list grows.
// ============================================================

/**
 * Maps chip data-category values (index.html) to a human-readable
 * search directive. Used when the user picks a category chip instead
 * of typing a custom search.
 */
const CATEGORY_SEARCH_MAP = {
  community:  "community foundations",
  corporate:  "corporate giving programs (unpublicized company funders)",
  government: "government grants (federal, state, Title I)",
  faith:      "faith-based funders (churches, dioceses, missions)",
  family:     "family foundations (private, rarely publicized)",
  healthcare: "healthcare foundations (health equity, trauma-informed)",
  all:        "community foundations, corporate giving programs, government grants, faith-based funders, family foundations, university foundations, and healthcare foundations",
};

/**
 * Build the user prompt for discovery.
 * Incorporates the saved org profile so the search is
 * tailored to ERE / BLF specifically.
 * @param {Object} profile        org profile from loadProfile()
 * @param {Object} [searchOverride] optional { category, customQuery }
 *   - category:    one or more CATEGORY_SEARCH_MAP keys (from chip
 *                  selection) — a single string, or an array for
 *                  multiple selected chips
 *   When customQuery is present it takes priority over category.
 * @returns {string}
 */
function buildDiscoveryUserPrompt(profile, searchOverride) {
  const focusList = Array.isArray(profile.focus)
    ? profile.focus.join(", ")
    : profile.focus;

  const profileExcludes = (profile.excludeFunders || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  // Read from memory — funders found in previous runs
  let memoryExcludes = [];
  try {
    if (typeof loadKnownFunders === "function") {
      memoryExcludes = Object.keys(loadKnownFunders());
    }
  } catch(e) {}

  // Cap at 20 most recent to avoid prompt overflow
  const excludeList = [...new Set([...profileExcludes, ...memoryExcludes])].slice(-20);

  const excludeSection = excludeList.length > 0
    ? `Exclude these already-known funders (do not return them): ${excludeList.join(", ")}`
    : "No exclusions.";

  // ── Determine what to search for ──────────────────────────
  // Priority: typed custom search > selected category chip(s) > default "all"
  const customQuery = searchOverride && searchOverride.customQuery
    ? searchOverride.customQuery.trim()
    : "";
  const categoryInput = searchOverride && searchOverride.category
    ? searchOverride.category
    : "all";
  // Accept a single category string (legacy) or an array of them (multi-select chips)
  const categories = Array.isArray(categoryInput) ? categoryInput : [categoryInput];
  const categoryPhrase = categories.length
    ? [...new Set(categories)].map(c => CATEGORY_SEARCH_MAP[c] || CATEGORY_SEARCH_MAP.all).join(", ")
    : CATEGORY_SEARCH_MAP.all;

  const searchDirective = customQuery
    ? `Search specifically for: ${customQuery}`
    : `Search across ${categoryPhrase} in ${profile.locations}.`;

  return `Find 1 currently OPEN grant for this nonprofit:
Name: ${profile.name}
Mission: ${profile.mission}
Location: ${profile.locations}
Focus: ${focusList}
Grant range: ${profile.grantRange}
${excludeSection}

${searchDirective}
Return exactly 1 open grant with a real URL. Today: ${today()}.`;
}


// ============================================================
// MAIN DISCOVERY FUNCTION
// Called from the UI when the user clicks "Run Discovery Search"
// ============================================================

/**
 * Run a full grant discovery search.
 *
 * Flow:
 * 1. Load org profile
 * 2. Build prompts
 * 3. Call groq/compound with web_search enabled
 * 4. Parse the structured JSON response
 * 5. Return raw results to caller (link verification happens next)
 *
 * @param {Function} onStatus  callback(message) for UI status updates
 * @param {Object|string} [searchOverride] either:
 *   - a string: treated as a customQuery (backward compatible with
 *     callers that pass `customQ || null`)
 *   - an object: { category, customQuery } for full control
 * @returns {Promise<Object>}  { opportunities: [], futureMonitoring: [], meta: {} }
 * @throws {Error}             on API failure or parse failure
 */
async function runDiscovery(onStatus, searchOverride) {
  // ── Guard: check API key is set ──────────────────────────
  if (!hasApiKey("groq")) {
    throw new Error(
      "Groq API key not found. Enter your key in the Settings tab first."
    );
  }

  onStatus("Layer 1 — Searching the live web for open grant opportunities…");

  // ── Load profile ─────────────────────────────────────────
  const profile = await loadProfile();

  // ── Normalise searchOverride ──────────────────────────────
  // Accept either a plain string (legacy call: customQ || null) or
  // a structured { category, customQuery } object.
  let normalisedOverride = null;
  if (typeof searchOverride === "string" && searchOverride.trim()) {
    normalisedOverride = { customQuery: searchOverride.trim() };
  } else if (searchOverride && typeof searchOverride === "object") {
    normalisedOverride = searchOverride;
  }

  // ── Build prompts ─────────────────────────────────────────
  const systemPrompt = buildDiscoverySystemPrompt();
  const userPrompt   = buildDiscoveryUserPrompt(profile, normalisedOverride);

  // ── Build request body ────────────────────────────────────
  // Verified from Groq docs July 2026:
  // - compound_custom.tools.enabled_tools restricts to web_search only
  //   (visit_website is handled separately in Layer 1.5)
  // - max_completion_tokens 4000 recommended for multi-search calls
  // - Groq-Model-Version header is passed via groqCallCompound()
  const requestBody = {
    model:                CONFIG.discovery.model,
    max_completion_tokens: 1000,  // compound-beta-mini — single search, lower context
    temperature:          CONFIG.discovery.temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
  };

  // ── Call the API ──────────────────────────────────────────
  let rawData;
  try {
    rawData = await groqCallCompound(
      CONFIG.discovery.endpoint,
      requestBody
    );
  } catch (err) {
    // Rethrow with context so UI can surface a useful message
    throw new Error(`Discovery search failed: ${err.message}`);
  }

  onStatus("Layer 1 — Parsing search results…");

  // ── Extract text content ──────────────────────────────────
  const responseText = extractText(rawData);

  if (!responseText || responseText.trim().length === 0) {
    throw new Error(
      "Discovery returned an empty response. " +
      "This may be a rate limit. Wait 60 seconds and try again."
    );
  }

  // ── Parse structured JSON from tagged block ───────────────
  const jsonStr = extractTagged(responseText, "DISCOVERY_JSON");

  if (!jsonStr) {
    // Log raw text to console for debugging without exposing to UI
    console.warn("Discovery raw response (no JSON block found):", responseText.slice(0, 500));
    throw new Error(
      "Discovery results could not be parsed. " +
      "The model did not return the expected format. Try running again."
    );
  }

  const parsed = safeParseJSON(jsonStr);

  if (!parsed) {
    throw new Error(
      "Discovery results contained malformed JSON. Try running again."
    );
  }

  // ── Validate and normalise results ────────────────────────
  const opportunities = normaliseOpportunities(parsed.opportunities || []);
  const futureMonitoring = normaliseFutureMonitoring(parsed.futureMonitoring || []);

  // ── Attach executed tool metadata for transparency ─────────
  // groq/compound returns executed_tools — useful for the UI
  // to show "searched X sources" as a trust signal
  const executedTools = rawData?.choices?.[0]?.message?.executed_tools || [];

  onStatus(
    `Layer 1 — Found ${opportunities.length} candidate${opportunities.length !== 1 ? "s" : ""}` +
    ` from ${executedTools.length} web search${executedTools.length !== 1 ? "es" : ""}.` +
    ` Verifying links…`
  );

  return {
    opportunities,
    futureMonitoring,
    meta: {
      searchDate:     today(),
      totalSearched:  parsed.totalSearched || opportunities.length,
      executedTools:  executedTools.length,
      rawResultCount: opportunities.length,
    },
  };
}


// ============================================================
// NORMALISATION HELPERS
// Clean and validate each raw opportunity object before
// handing it to link verification. Ensures downstream layers
// always receive a consistent shape.
// ============================================================

/**
 * Normalise raw opportunity array from discovery response.
 * Assigns a fresh ID, fills missing fields with safe defaults,
 * and filters out any entry with no URL.
 * @param {Array} raw  raw opportunities array from model
 * @returns {Array}    normalised opportunities
 */
function normaliseOpportunities(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((o) => {
      // Hard requirement: must have a URL — no URL = not actionable
      if (!o.url || o.url.trim() === "" || o.url === "N/A") {
        console.warn(`Discovery: dropping "${o.funder}" — no URL provided`);
        return false;
      }
      // Hard requirement: must have a funder name
      if (!o.funder || o.funder.trim() === "") {
        console.warn("Discovery: dropping unnamed opportunity");
        return false;
      }
      return true;
    })
    .map((o) => ({
      // Use a fresh generated ID — never trust model-generated IDs
      id:            generateId(),
      funder:        (o.funder        || "").trim(),
      program:       (o.program       || "").trim(),
      amount:        (o.amount        || "TBD").trim(),
      appStatus:     normaliseAppStatus(o.appStatus),
      deadline:      normaliseDeadline(o.deadline),
      deadlineNote:  (o.deadlineNote  || "").trim(),
      geoEligibility:(o.geoEligibility|| "").trim(),
      orgEligibility:(o.orgEligibility|| "").trim(),
      focusAreas:    Array.isArray(o.focusAreas) ? o.focusAreas : [],
      url:           (o.url           || "").trim(),
      sourceNote:    (o.sourceNote    || "").trim(),
      flags:         Array.isArray(o.flags) ? o.flags : [],
      confidence:    normaliseConfidence(o.confidence),

      // Fields added by later layers — initialised as null here
      // Layer 1.5 fills: linkStatus, finalUrl, pageTitle, keywordsFound, dateVerified
      // Layer 2 fills:   fitScore, missionAlignment, risks, recommendedAction, whyQualifies
      // Layer 2.5 fills: guardStatus, guardIssues, guardNote
      linkStatus:       null,
      finalUrl:         null,
      pageTitle:        null,
      keywordsFound:    null,
      dateVerified:     null,
      fitScore:         null,
      missionAlignment: null,
      risks:            null,
      recommendedAction:null,
      whyQualifies:     null,
      guardStatus:      null,
      guardIssues:      [],
      guardNote:        null,
    }));
}

/**
 * Normalise future monitoring array.
 * @param {Array} raw
 * @returns {Array}
 */
function normaliseFutureMonitoring(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f.funder && f.funder.trim() !== "")
    .map((f) => ({
      id:         generateId(),
      funder:     (f.funder    || "").trim(),
      reason:     (f.reason    || "").trim(),
      cycleNote:  (f.cycleNote || "").trim(),
      url:        (f.url       || "").trim(),
    }));
}

/**
 * Normalise appStatus to one of the four valid values.
 * @param {string} raw
 * @returns {string}
 */
function normaliseAppStatus(raw) {
  const s = (raw || "").toUpperCase().trim();
  if (s.includes("ROLLING"))       return "OPEN – Rolling";
  if (s.includes("SOON"))          return "OPENS SOON";
  if (s.includes("OPEN"))          return "OPEN";
  return "NEEDS VERIFICATION";
}

/**
 * Normalise deadline string.
 * Accepts YYYY-MM-DD, "Rolling", or unknown.
 * @param {string} raw
 * @returns {string}
 */
function normaliseDeadline(raw) {
  if (!raw || raw.trim() === "") return "Needs Verification";
  const s = raw.trim();
  if (s.toLowerCase() === "rolling") return "Rolling";
  // Validate date format YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return s;
  }
  // Common alternatives — try to parse
  const parsed = new Date(s);
  if (!isNaN(parsed)) {
    return parsed.toISOString().split("T")[0];
  }
  return "Needs Verification";
}

/**
 * Normalise confidence to High / Medium / Low.
 * @param {string} raw
 * @returns {string}
 */
function normaliseConfidence(raw) {
  const s = (raw || "").toLowerCase().trim();
  if (s === "high")   return "High";
  if (s === "medium") return "Medium";
  if (s === "low")    return "Low";
  return "Medium"; // safe default
}


// ============================================================
// GROQ COMPOUND API CALL
// Separate from the shared groqCall() in config.js because
// compound calls need the extra "Groq-Model-Version: latest"
// header required for visit_website (used in Layer 1.5).
// We include it here too for consistency across both layers.
// ============================================================

/**
 * Make a Groq Compound API call.
 * Adds the "Groq-Model-Version: latest" header required by
 * visit_website and recommended by Groq for compound systems.
 *
 * Verified from Groq built-in tools docs, July 2026:
 * https://console.groq.com/docs/tool-use/built-in-tools
 *
 * @param {string} endpoint   full Groq API URL
 * @param {Object} body       request body object
 * @returns {Promise<Object>} parsed JSON response
 * @throws {Error}            on network or API error
 */
async function groqCallCompound(endpoint, body, onStatus) {
  const key = getApiKey("groq");
  if (!key) {
    throw new Error("Groq API key not set. Enter it in the Settings tab.");
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type":       "application/json",
      "Authorization":      `Bearer ${key}`,
      // Required for visit_website tool and recommended for all compound calls.
      // Source: https://console.groq.com/docs/compound/systems/compound
      "Groq-Model-Version": "latest",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try {
      const errBody = await resp.json();
      // Groq error format: { error: { message: "..." } }
      errMsg = errBody?.error?.message || errMsg;
    } catch (_) {
      // Response was not JSON — use status code only
    }

    // Specific guidance for common errors
    if (resp.status === 401) {
      throw new Error("Invalid Groq API key. Check your key in Settings.");
    }
    if (resp.status === 429) {
      // Auto-retry once after 65 seconds
      if (!body._retried) {
        if (typeof onStatus === "function") {
          onStatus("Rate limit hit — auto-retrying in 65 seconds…");
        }
        await new Promise(r => setTimeout(r, 65000));
        body._retried = true;
        return groqCallCompound(endpoint, body, onStatus);
      }
      throw new Error(
        "Groq rate limit reached. Wait 60 seconds and try again. " +
        "Free tier allows 30 requests/minute and 1,000 requests/day."
      );
    }
    if (resp.status === 413) {
      throw new Error(
        "Request too large. Try reducing the org profile length " +
        "or the number of funders in the exclude list."
      );
    }
    throw new Error(`Groq API error: ${errMsg}`);
  }

  return resp.json();
}


// ============================================================
// UI HELPERS
// Functions called directly by index.html to render discovery
// state and results during the run.
// ============================================================

/**
 * Render the pipeline progress bar in the UI.
 * Called once before the run starts.
 * Steps: Discovery → Link Verify → Qualify → Guard → Tracker
 * @param {string} activeStep  which step is currently running
 */
function renderPipelineBar(activeStep) {
  const el = document.getElementById("pipeline-bar");
  if (!el) return;

  const steps = [
    { id: "discover",  label: "1 — Discover"      },
    { id: "verify",    label: "1.5 — Verify Links" },
    { id: "qualify",   label: "2 — Qualify"        },
    { id: "guard",     label: "2.5 — Guard"        },
    { id: "tracker",   label: "3 — Tracker"        },
  ];

  el.innerHTML = steps
    .map((s, i) => {
      // Determine step state
      const stepOrder = steps.findIndex((x) => x.id === activeStep);
      const thisOrder = i;
      let stateClass = "step-waiting";
      if (thisOrder < stepOrder)  stateClass = "step-done";
      if (thisOrder === stepOrder) stateClass = "step-running";

      const arrow = i < steps.length - 1
        ? `<span class="pipeline-arrow">→</span>`
        : "";

      return `
        <div class="pipeline-step ${stateClass}" id="step-${s.id}">
          ${s.label}
        </div>
        ${arrow}`;
    })
    .join("");
}

/**
 * Update a single pipeline step's visual state.
 * Called as each layer completes.
 * @param {string} stepId     e.g. "discover"
 * @param {string} stateClass "step-running" | "step-done" | "step-error"
 */
function updatePipelineStep(stepId, stateClass) {
  const el = document.getElementById(`step-${stepId}`);
  if (!el) return;
  el.className = `pipeline-step ${stateClass}`;
}

/**
 * Render the discovery summary strip (stat cards).
 * Called after link verification completes so counts are final.
 * @param {Object} meta  summary data object
 */
function renderSummaryStrip(meta) {
  const el = document.getElementById("summary-strip");
  if (!el) return;

  const stats = [
    { n: meta.rawFound,     l: "Found"         },
    { n: meta.verified,     l: "Verified"       },
    { n: meta.dropped,      l: "Filtered out"   },
    { n: meta.proceeding,   l: "To qualify"     },
    { n: meta.webSearches,  l: "Web searches"   },
    { n: meta.earliestDeadline || "—", l: "Earliest deadline", mono: true },
  ];

  el.innerHTML = stats
    .map(
      (s) => `
      <div class="stat-card">
        <div class="stat-number ${s.mono ? "mono" : ""}">${esc(String(s.n))}</div>
        <div class="stat-label">${esc(s.l)}</div>
      </div>`
    )
    .join("");

  el.style.display = "flex";
}

/**
 * Render a single opportunity card in the results panel.
 * Called for each opportunity that passes all layers.
 * @param {Object} opp  fully-processed opportunity object
 * @returns {string}    HTML string for the card
 */
function renderOpportunityCard(opp) {
  // App status pill class
  const pillClass = {
    "OPEN":               "pill-open",
    "OPEN – Rolling":     "pill-rolling",
    "OPENS SOON":         "pill-soon",
    "NEEDS VERIFICATION": "pill-verify",
  }[opp.appStatus] || "pill-verify";

  // Fit score dots
  const fitDots = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<span class="fit-dot ${n <= (opp.fitScore || 0) ? "filled" : ""}"></span>`
    )
    .join("");

  // Deadline badge
  const dlClass = deadlineClass(opp.deadline);
  const dlText  = opp.deadline === "Rolling"
    ? "Rolling"
    : opp.deadline === "Needs Verification"
    ? "Check deadline"
    : daysLabel(opp.deadline);

  // Guard flag block — only shown if flagged
  const guardBlock = opp.guardStatus === "FLAG"
    ? `<div class="opp-guard-flag">
         ⚠️ <b>Staff review needed:</b> ${esc(opp.guardNote || "")}
         ${opp.guardIssues && opp.guardIssues.length
           ? `<ul style="margin:4px 0 0 16px;">${opp.guardIssues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
           : ""}
       </div>`
    : "";

  // Flags / risk block
  const riskText = [
    ...(opp.flags || []),
    ...(opp.risks ? [opp.risks] : []),
  ].filter(Boolean).join(" · ");

  const riskBlock = riskText
    ? `<div class="opp-risk">⚑ ${esc(riskText)}</div>`
    : "";

  // Link status badge
  const linkBadgeClass = opp.linkStatus === "VERIFIED" ? "verified" : "redirect";
  const linkBadge = opp.linkStatus
    ? `<span class="link-status ${linkBadgeClass}">${esc(CONFIG.linkStatusOptions[opp.linkStatus] || opp.linkStatus)}</span>`
    : "";

  // Card flagged class
  const cardFlaggedClass = opp.guardStatus === "FLAG" ? "guard-flagged" : "";

  return `
    <div class="opp-card ${cardFlaggedClass}" id="opp-${esc(opp.id)}">

      <div class="opp-card-top">
        <div>
          <p class="opp-funder">${esc(opp.funder)}</p>
          <div class="opp-program">${esc(opp.program)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;">
          <span class="pill ${pillClass}">${esc(opp.appStatus)}</span>
          ${opp.guardStatus === "PASS"
            ? `<span class="pill pill-pass">✅ Guard pass</span>`
            : opp.guardStatus === "FLAG"
            ? `<span class="pill pill-flag">⚠️ Review</span>`
            : ""}
        </div>
      </div>

      <div class="opp-meta">
        <div class="opp-meta-item">
          <span class="opp-meta-key">Amount</span>
          <span class="opp-meta-val">${esc(opp.amount)}</span>
        </div>
        <div class="opp-meta-item">
          <span class="opp-meta-key">Deadline</span>
          <span class="opp-meta-val">
            <span class="dl-badge ${dlClass}">${esc(dlText)}</span>
            ${opp.deadlineNote ? `<span class="muted" style="font-size:11px;margin-left:4px;">${esc(opp.deadlineNote)}</span>` : ""}
          </span>
        </div>
        <div class="opp-meta-item">
          <span class="opp-meta-key">Fit score</span>
          <span class="opp-meta-val">
            <span class="fit-dots score-${opp.fitScore || 0}">${fitDots}</span>
            <span class="mono" style="margin-left:6px;font-size:11px;color:var(--muted);">${esc(CONFIG.fitLabels[opp.fitScore] || "—")}</span>
          </span>
        </div>
        <div class="opp-meta-item">
          <span class="opp-meta-key">Confidence</span>
          <span class="opp-meta-val">${esc(opp.confidence || "—")}</span>
        </div>
        <div class="opp-meta-item">
          <span class="opp-meta-key">Geography</span>
          <span class="opp-meta-val">${esc(opp.geoEligibility || "—")}</span>
        </div>
        <div class="opp-meta-item">
          <span class="opp-meta-key">Link</span>
          <span class="opp-meta-val">${linkBadge}</span>
        </div>
      </div>

      ${opp.whyQualifies
        ? `<div class="opp-why"><b>Why it qualifies:</b> ${esc(opp.whyQualifies)}</div>`
        : ""}

      ${guardBlock}
      ${riskBlock}

      <div class="opp-actions">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <a href="${esc(opp.finalUrl || opp.url)}" target="_blank" rel="noopener noreferrer"
             class="btn btn-teal btn-sm">
            Open application page →
          </a>
          ${opp.pageTitle
            ? `<span class="opp-verified-info">📄 ${esc(opp.pageTitle)}</span>`
            : ""}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="opp-verified-info">
            Verified ${esc(opp.dateVerified || today())}
            · <b>${esc(opp.recommendedAction || "—")}</b>
          </span>
          <button
            class="btn btn-gold btn-sm"
            onclick="addOpportunityToTracker('${esc(opp.id)}')"
            title="Add this opportunity to the Grant Tracker">
            + Add to Tracker
          </button>
        </div>
      </div>

    </div>`;
}

/**
 * Render the future monitoring section below the results.
 * @param {Array} futureMonitoring  array of future monitoring objects
 * @returns {string}  HTML string or empty string if none
 */
function renderFutureMonitoring(futureMonitoring) {
  if (!futureMonitoring || futureMonitoring.length === 0) return "";

  const items = futureMonitoring
    .map(
      (f) => `
      <div class="future-item">
        <div>
          <div class="future-item-name">${esc(f.funder)}</div>
          <div class="future-item-reason">${esc(f.reason)}</div>
        </div>
        <div class="future-item-cycle">
          ${esc(f.cycleNote || "Cycle timing unknown")}
          ${f.url
            ? `<br><a href="${esc(f.url)}" target="_blank" rel="noopener">Visit site</a>`
            : ""}
        </div>
      </div>`
    )
    .join("");

  return `
    <div class="panel" style="margin-top:var(--gap-md);">
      <h2>Future monitoring candidates</h2>
      <p class="panel-desc">
        Strong long-term fits whose current cycle is closed.
        Not recommended for immediate action — watch for reopening.
        These are NOT added to the tracker automatically.
      </p>
      ${items}
    </div>`;
}
