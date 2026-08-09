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

PRIORITY: Strongly prefer grants with the most time remaining before their
deadline. Do not return a grant whose deadline has already passed unless,
after searching thoroughly, no better alternative exists, this should be
rare, not a fallback you reach for early.

SEARCH STRATEGY:
Search across ALL of these funder categories in separate searches:
1. Community foundations (local, often rolling deadlines)
2. Corporate giving programs (unpublicized funders)
3. Government grants (federal, state, and local)
4. Faith-based funders (churches, dioceses, religious organizations)
5. Family foundations (private, rarely publicized)
6. University foundations (regional and national)
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
 * tailored to whichever org profile is currently loaded.
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

  // ── Compound learning ──────────────────────────────────────
  // Read from learning.js — a short, org-history-derived preference
  // line, or "" if there isn't enough resolved tracker history yet
  // to say anything (see learning.js MIN_RESOLVED_SAMPLE). This is
  // advisory only — it never overrides the org's own selected
  // category or the STRICT VALIDATION RULES in the system prompt,
  // it just gives the model extra context about what has actually
  // worked for this org so far.
  let learningLine = "";
  try {
    if (typeof buildLearningPromptLine === "function") {
      learningLine = buildLearningPromptLine();
    }
  } catch (e) {}

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

  const learningSection = learningLine ? `\n${learningLine}` : "";

  return `Find 1 currently OPEN grant for this nonprofit:
Name: ${profile.name}
Mission: ${profile.mission}
Location: ${profile.locations}
Focus: ${focusList}
Grant range: ${profile.grantRange}
${excludeSection}${learningSection}

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
async function runDiscoveryOnce(onStatus, searchOverride) {
  // ── Guard: check API key is set ──────────────────────────
  if (!hasApiKey("groq")) {
    throw new Error(
      "Groq API key not found. Enter your key in the Settings tab first."
    );
  }

  onStatus("Layer 1 · Searching the live web for open grant opportunities…");

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

  // ── Call the API — provider branch ────────────────────────
  // Groq and Gemini have entirely different request/response
  // shapes (see groqCallCompound/geminiCallGrounded below), but
  // both branches converge to the same two values before this
  // point ends: responseText and toolsUsedCount. Everything from
  // here down (JSON-tag extraction, normalisation) never needs to
  // know which provider ran.
  const provider = (CONFIG.discovery && CONFIG.discovery.provider) || "groq";

  let rawData, responseText, toolsUsedCount;
  try {
    if (provider === "gemini") {
      const geminiCfg = CONFIG.discovery.gemini || {};
      const requestBody = buildGeminiRequestBody(systemPrompt, userPrompt, geminiCfg);
      rawData = await geminiCallGrounded(geminiCfg, requestBody, onStatus);
      responseText = extractGeminiText(rawData);
      toolsUsedCount = extractGeminiToolCount(rawData);
    } else {
      // ── Build request body ──────────────────────────────────
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
      rawData = await groqCallCompound(CONFIG.discovery.endpoint, requestBody);
      responseText = extractText(rawData);
      toolsUsedCount = (rawData?.choices?.[0]?.message?.executed_tools || []).length;
    }
  } catch (err) {
    // Rethrow with context so UI can surface a useful message
    throw new Error(`Discovery search failed: ${err.message}`);
  }

  onStatus("Layer 1 · Parsing search results…");

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
  // The model is instructed to return exactly 1 grant, but LLMs don't
  // always obey instruction counts precisely. Truncate here so "one
  // result per run" is a real guarantee enforced in code, not just a
  // hope based on the prompt, this is what the rest of the app (and
  // the FAQ) documents as the actual behavior.
  const maxResults = (CONFIG.discovery && CONFIG.discovery.maxResults) || 1;
  // Categories actually used for THIS search — "all" is stored as-is
  // rather than expanded, since learning.js already excludes "all"
  // from its per-category aggregation (there's nothing to attribute
  // to a catch-all search).
  const usedCategories = normalisedOverride && normalisedOverride.category
    ? (Array.isArray(normalisedOverride.category) ? normalisedOverride.category : [normalisedOverride.category])
    : ["all"];
  const opportunities = normaliseOpportunities(parsed.opportunities || [])
    .slice(0, maxResults)
    .map((o) => ({ ...o, searchCategory: usedCategories }));
  const futureMonitoring = normaliseFutureMonitoring(parsed.futureMonitoring || []);

  // ── Tool-use count already extracted above (provider-agnostic) ──
  // Groq: executed_tools array length. Gemini: groundingMetadata
  // search-query/chunk count. Both represent the same thing to the
  // UI — "how many live web searches backed this result" — so it's
  // computed once, in the provider branch above, not re-derived here.

  onStatus(
    `Layer 1 \u00b7 Found ${opportunities.length} candidate${opportunities.length !== 1 ? "s" : ""}` +
    ` from ${toolsUsedCount} web search${toolsUsedCount !== 1 ? "es" : ""}. Passing to link check\u2026`
  );

  return {
    opportunities,
    futureMonitoring,
    meta: {
      searchDate:     today(),
      totalSearched:  parsed.totalSearched || opportunities.length,
      executedTools:  toolsUsedCount,
      rawResultCount: opportunities.length,
      provider,
    },
  };
}

/**
 * Public entry point. Runs discovery once, and if the single candidate
 * that comes back already has a passed deadline, retries exactly once
 * before returning. This never drops or hides an expired result, it
 * just gives the model one extra chance to find something with time
 * left, absorbing one manual re-click a user would otherwise have to
 * do themselves. Whatever comes back after the retry is returned as-is,
 * expired or not, no gate, no third attempt.
 * @param {Function} onStatus
 * @param {Object|string} searchOverride
 */
async function runDiscovery(onStatus, searchOverride) {
  const first = await runDiscoveryOnce(onStatus, searchOverride);

  const firstIsExpired = first.opportunities.length > 0
    && first.opportunities.every((o) => o.deadlinePassed);

  if (!firstIsExpired) return first;

  onStatus("Layer 1 \u00b7 That result's deadline had already passed, trying once more for something with time left\u2026");

  const retry = await runDiscoveryOnce(onStatus, searchOverride);
  return retry;
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
      // True when the deadline is a real date already in the past.
      // Kept visible rather than dropped — the org may still want to
      // add it to the tracker for next year's cycle. daysUntil()
      // returns null for Rolling or unparseable dates, those are
      // left unflagged since we can't confirm they're expired either.
      deadlinePassed: (typeof daysUntil === "function" ? daysUntil(o.deadline) : null) !== null
                       && daysUntil(o.deadline) < 0,
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
          onStatus("Rate limit hit, auto-retrying in 65 seconds…");
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
// GEMINI PROVIDER — Grounding with Google Search
// Fundaigo's Layer 1 provider alternative to Groq Compound.
//
// WHY THIS IS SEPARATE FROM groqCallCompound:
// Gemini's live-web-search feature ("Grounding with Google
// Search") is a completely different mechanism from Groq's
// Compound system — different endpoint, different auth (API key
// as a query param, not a Bearer header), different request body
// shape (`contents`/`parts`, not `messages`), different response
// shape (`candidates[0].content.parts`, not `choices[0].message`),
// and search is enabled via an explicit `tools` field rather than
// being implicit in the model choice. None of that complexity
// leaks past this section — runDiscoveryOnce() only ever sees the
// same responseText/toolsUsedCount shape Groq produces.
//
// Verified from Gemini API docs, August 2026:
// https://ai.google.dev/gemini-api/docs/grounding
// ============================================================

/**
 * Build the Gemini request body for a grounded search call.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {Object} geminiCfg  CONFIG.discovery.gemini
 * @returns {Object}
 */
function buildGeminiRequestBody(systemPrompt, userPrompt, geminiCfg) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    // Enables live Google Search grounding — Gemini's equivalent of
    // Groq compound's built-in web_search tool. Without this field
    // the model answers from training data only, no live search.
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature:     geminiCfg.temperature ?? CONFIG.discovery.temperature,
      maxOutputTokens: geminiCfg.maxOutputTokens || 2000,
    },
  };
}

/**
 * Make a Gemini generateContent call with Google Search grounding.
 * On a 429 (rate limit), auto-retries exactly once after 65 seconds
 * — same pattern and same wait as groqCallCompound(). 65s rather
 * than a flat 60s to give Gemini's rolling 60-second RPM window a
 * safety margin before retrying, same reasoning as the Groq side.
 * @param {Object} geminiCfg  CONFIG.discovery.gemini
 * @param {Object} body       request body from buildGeminiRequestBody()
 * @param {Function} [onStatus]  optional UI status callback
 * @returns {Promise<Object>} parsed JSON response
 * @throws {Error}            on network, auth, or repeated rate-limit error
 */
async function geminiCallGrounded(geminiCfg, body, onStatus) {
  const key = getApiKey("gemini");
  if (!key) {
    throw new Error("Gemini API key not set. Enter it in the Settings tab.");
  }

  const url = `${geminiCfg.endpoint}/${geminiCfg.model}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      // Header-based auth, not a URL query param — avoids the key
      // showing up in logs or browser history. As of mid-2026,
      // Google has also begun phasing out unrestricted keys and
      // issuing some keys with a different prefix than the classic
      // "AIza" format, so this app deliberately does not validate
      // key format/prefix client-side — only Google's own API can
      // tell you whether a given key is valid.
      "x-goog-api-key": key,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try {
      const errBody = await resp.json();
      // Gemini error format: { error: { message: "..." } }
      errMsg = errBody?.error?.message || errMsg;
    } catch (_) {
      // Response was not JSON — use status code only
    }

    if (resp.status === 400 || resp.status === 403) {
      throw new Error("Invalid Gemini API key. Check your key in Settings.");
    }
    if (resp.status === 429) {
      // Auto-retry once after 65 seconds — Gemini 2.5 Flash's free
      // tier RPM limit is a rolling 60-second window, confirmed
      // August 2026. Mirrors groqCallCompound()'s exact retry
      // pattern below, including the same _retried guard so a
      // second consecutive 429 fails loudly instead of looping.
      if (!body._retried) {
        if (typeof onStatus === "function") {
          onStatus("Gemini rate limit hit, auto-retrying in 65 seconds…");
        }
        await new Promise(r => setTimeout(r, 65000));
        body._retried = true;
        return geminiCallGrounded(geminiCfg, body, onStatus);
      }
      throw new Error(
        "Gemini rate limit reached again after retrying. " +
        "Free tier allows 10 requests/minute on Gemini 2.5 Flash. " +
        "Wait a minute and try again, or switch provider to Groq in Settings."
      );
    }
    throw new Error(`Gemini API error: ${errMsg}`);
  }

  return resp.json();
}

/**
 * Extract the model's text response from a Gemini API result.
 * Gemini can return multiple parts (rare for a text-only grounded
 * call) — concatenated here, same convention as extractText() for
 * Groq's response shape.
 * @param {Object} rawData
 * @returns {string}
 */
function extractGeminiText(rawData) {
  const parts = rawData?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

/**
 * Count how many live searches backed this Gemini response, for
 * parity with Groq's executed_tools count — used only for the
 * "searched X sources" trust signal in the UI, never for logic.
 * @param {Object} rawData
 * @returns {number}
 */
function extractGeminiToolCount(rawData) {
  const gm = rawData?.candidates?.[0]?.groundingMetadata;
  if (!gm) return 0;
  if (Array.isArray(gm.webSearchQueries)) return gm.webSearchQueries.length;
  if (Array.isArray(gm.groundingChunks))  return gm.groundingChunks.length;
  return 0;
}

