/**
 * ============================================================
 * qualification.js — Layer 2: Grant Qualification & Scoring
 * AI-Powered AI-Powered Grant Intelligence for Nonprofits
 * Version: 2.1 | July 2026 — org-relative match-tier scoring
 *
 * WHAT THIS FILE DOES:
 * Takes verified opportunities from Layer 1.5 (link verified,
 * dead URLs filtered out) and runs each through a structured
 * qualification evaluation using openai/gpt-oss-120b on Groq.
 *
 * SCORING ARCHITECTURE (generalized in v2.1 — see matchScoring.js):
 * The AI is asked to extract four FACTS about each grant, each
 * judged relative to THIS org's own profile (focusMatch,
 * populationMatch, geoMatch, nonprofitEligible) — reading
 * comprehension against whatever the org actually typed into
 * their profile. It is never asked to decide a tier.
 * mergeQualificationResults() then calls deriveMatchLevel() from
 * matchScoring.js, a pure deterministic function, to apply the
 * HIGH/GOOD/OK/NO waterfall (generalized from ERE's original
 * rubric, see matchScoring.js for detail) and derive fitScore
 * from that tier. This split exists so the actual business logic
 * is unit-testable and can't drift or hallucinate a tier — see
 * matchScoring.test.js.
 *
 * For each opportunity it produces:
 *   matchLevel        HIGH / GOOD / OK / NO — derived
 *                      deterministically, see matchScoring.js
 *   fitScore          1–5, derived from matchLevel (HIGH=5..NO=1)
 *   focusMatch, populationMatch, geoMatch, nonprofitEligible
 *                      raw AI-extracted facts kept on the row too,
 *                      so staff can see WHY a tier was assigned
 *   missionAlignment  one sentence — does the mission match?
 *   geoEligibility    does the funder cover the org's location(s)?
 *   orgEligibility    does the org meet size/type requirements?
 *   appStatus         OPEN / OPEN–Rolling / OPENS SOON
 *   deadline          confirmed or "Needs Verification"
 *   amount            confirmed funding range
 *   risks             flags: LOI / matching funds / etc.
 *   recommendedAction Apply Immediately / High Priority / etc.
 *   confidence        High / Medium / Low
 *   whyQualifies      one sentence for the staff card
 *
 * Opportunities scoring below CONFIG.qualification.minFitScore
 * are filtered out here — never reach the guard or tracker.
 * NO-tier grants (fitScore 1) fall below the default threshold
 * of 2 and are filtered automatically.
 *
 * API FACTS (verified from Groq docs, July 2026):
 * - Model: openai/gpt-oss-120b
 * - Endpoint: https://api.groq.com/openai/v1/chat/completions
 * - No special header required (unlike groq/compound)
 * - reasoning_effort: "low" — fast, deterministic, sufficient
 *   for structured scoring (verified: supports low/medium/high)
 * - include_reasoning: false — hides chain-of-thought to save
 *   output tokens (verified from Groq reasoning docs)
 * - response_format json_schema has a known regression bug on
 *   this model — use tagged JSON blocks instead (our pattern)
 * - Standard groqCall() from config.js works — no compound header
 * Source: https://console.groq.com/docs/model/openai/gpt-oss-120b
 *         https://console.groq.com/docs/reasoning
 *
 * DEPENDENCIES:
 * - config.js       (CONFIG, groqCall, extractText, extractTagged,
 *                     safeParseJSON, today, generateId)
 * - matchScoring.js (deriveMatchLevel, matchLevelToFitScore,
 *                     MATCH_EXTRACTION_INSTRUCTIONS) — load BEFORE
 *                     this file in index.html
 * - memory.js       (not called directly but loaded before this)
 * ============================================================
 */


// ============================================================
// QUALIFICATION SYSTEM PROMPT
// Instructs gpt-oss-120b to evaluate each opportunity against
// the org profile and return structured scoring JSON.
// ============================================================

/**
 * Build the system prompt for qualification.
 * @param {Object} profile  org profile from loadProfile()
 * @returns {string}
 */
function buildQualificationSystemPrompt(profile) {
  const focusList = Array.isArray(profile.focus) ? profile.focus.join(", ") : profile.focus;
  const serviceArea = profile.serviceAreas ? `${profile.locations} (${profile.serviceAreas})` : profile.locations;

  return `Evaluate each grant opportunity for this nonprofit. Output ONLY JSON inside <QUALIFICATION_JSON> tags.

Org: ${profile.name} | ${profile.mission} | ${profile.locations}
Org's stated focus areas: ${focusList}
Org's stated population served: ${profile.population}
Org's stated service area: ${serviceArea}

${MATCH_EXTRACTION_INSTRUCTIONS}

Today: ${today()}.

<QUALIFICATION_JSON>
{
  "evaluationDate": "${today()}",
  "results": [
    {
      "id": "opp id",
      "focusMatch": "yes",
      "populationMatch": "yes",
      "geoMatch": "yes",
      "nonprofitEligible": true,
      "missionAlignment": "one sentence",
      "geoEligibility": "Yes/No/Partial",
      "orgEligibility": "qualifies or not",
      "appStatus": "OPEN",
      "deadline": "YYYY-MM-DD",
      "amount": "$X,XXX",
      "risks": "",
      "recommendedAction": "High Priority",
      "confidence": "High",
      "whyQualifies": "one sentence"
    }
  ]
}
</QUALIFICATION_JSON>`;
}

/**
 * Build the user prompt listing all opportunities to qualify.
 * @param {Array} opportunities  verified opportunities from Layer 1.5
 * @returns {string}
 */
function buildQualificationUserPrompt(opportunities) {
  const oppList = opportunities.map((o, i) => `
Opportunity ${i + 1}:
  ID:           ${o.id}
  Funder:       ${o.funder}
  Program:      ${o.program}
  Amount:       ${o.amount}
  Status:       ${o.appStatus}
  Deadline:     ${o.deadline}${o.deadlineNote ? ` (${o.deadlineNote})` : ""}
  Geography:    ${o.geoEligibility}
  Eligibility:  ${o.orgEligibility}
  Focus areas:  ${(o.focusAreas || []).join(", ")}
  Flags:        ${(o.flags || []).join(", ") || "none"}
  Confidence:   ${o.confidence}
  Source note:  ${o.sourceNote}
  URL:          ${o.finalUrl || o.url}
  Page title:   ${o.pageTitle || "—"}
  Keywords:     ${(o.keywordsFound || []).join(", ") || "—"}`
  ).join("\n");

  return `Please evaluate the following ${opportunities.length} grant opportunities
against the organization profile in your system prompt.

Return a fit score, mission alignment assessment, risks, and
recommended action for each one.

${oppList}

Evaluation date: ${today()}`;
}


// ============================================================
// MAIN QUALIFICATION FUNCTION
// ============================================================

/**
 * Run qualification scoring on all verified opportunities.
 *
 * Flow:
 * 1. Build prompts from org profile + verified opportunities
 * 2. Call openai/gpt-oss-120b with reasoning_effort: "low"
 * 3. Parse structured JSON results
 * 4. Merge qualification data back into opportunity objects
 * 5. Filter out opportunities below minFitScore
 * 6. Sort by fitScore descending
 *
 * @param {Array}    opportunities  verified opps from Layer 1.5
 * @param {Function} onStatus       callback(message) for UI updates
 * @returns {Promise<Object>}
 *   { qualified: [], filtered: [], meta: {} }
 * @throws {Error}  on API failure
 */
async function runQualification(opportunities, onStatus) {
  // ── Guard: nothing to qualify ─────────────────────────────
  if (!opportunities || opportunities.length === 0) {
    return {
      qualified: [],
      filtered:  [],
      meta: { total: 0, qualified: 0, filtered: 0, avgFitScore: 0 }
    };
  }

  if (!hasApiKey("groq")) {
    throw new Error("Groq API key not set. Enter your key in the Settings tab.");
  }

  onStatus(
    `Layer 2 — Qualifying ${opportunities.length} verified opportunit${
      opportunities.length !== 1 ? "ies" : "y"
    } (reasoning + fit scoring)…`
  );

  // ── Load profile ──────────────────────────────────────────
  const profile = await loadProfile();

  // ── Build prompts ─────────────────────────────────────────
  const systemPrompt = buildQualificationSystemPrompt(profile);
  const userPrompt   = buildQualificationUserPrompt(opportunities);

  // ── Build request body ────────────────────────────────────
  // Verified from Groq docs July 2026:
  // - openai/gpt-oss-120b supports reasoning_effort: "low|medium|high"
  // - include_reasoning: false hides chain-of-thought (saves tokens)
  // - response_format json_schema has regression bug — use tagged JSON
  // - No compound header needed — standard groqCall() works
  // Source: https://console.groq.com/docs/reasoning
  const requestBody = {
    model:               CONFIG.qualification.model, // "openai/gpt-oss-120b"
    max_completion_tokens: 600,   // 1 result needs ~300 tokens — stay under TPM limit
    temperature:         CONFIG.qualification.temperature, // 0.1
    reasoning_effort:    "low",     // fast + deterministic for scoring
    include_reasoning:   false,     // hide chain-of-thought, save tokens
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
  };

  // ── Call the API ──────────────────────────────────────────
  let rawData;
  try {
    rawData = await groqCall(
      CONFIG.qualification.endpoint,
      requestBody
    );
  } catch (err) {
    throw new Error(`Qualification failed: ${err.message}`);
  }

  onStatus("Layer 2 — Parsing qualification scores…");

  // ── Extract and parse ─────────────────────────────────────
  const responseText = extractText(rawData);

  if (!responseText || responseText.trim().length === 0) {
    throw new Error(
      "Qualification returned an empty response. " +
      "This may be a rate limit — wait 60 seconds and try again."
    );
  }

  const jsonStr = extractTagged(responseText, "QUALIFICATION_JSON");

  if (!jsonStr) {
    console.warn(
      "Qualification: no JSON block found. Raw response:",
      responseText.slice(0, 400)
    );
    throw new Error(
      "Qualification results could not be parsed. " +
      "The model did not return the expected format. Try again."
    );
  }

  const parsed = safeParseJSON(jsonStr);

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error(
      "Qualification returned malformed JSON. Try again."
    );
  }

  // ── Merge scores into opportunity objects ─────────────────
  const merged = mergeQualificationResults(opportunities, parsed.results);

  // ── Filter below minFitScore ──────────────────────────────
  const minScore = CONFIG.qualification.minFitScore; // default 2
  const qualified = merged.filter((o) => (o.fitScore || 0) >= minScore);
  const filtered  = merged.filter((o) => (o.fitScore || 0) <  minScore);

  if (filtered.length > 0) {
    console.info(
      `Qualification: filtered ${filtered.length} low-score opportunit${
        filtered.length !== 1 ? "ies" : "y"
      }:\n` +
      filtered.map((o) => `  Score ${o.fitScore} — ${o.funder}`).join("\n")
    );
  }

  // ── Sort by fitScore descending, then deadline ascending ──
  qualified.sort((a, b) => {
    if ((b.fitScore || 0) !== (a.fitScore || 0)) {
      return (b.fitScore || 0) - (a.fitScore || 0);
    }
    // Equal scores — earlier deadline first
    const da = new Date(a.deadline || "2999-01-01");
    const db = new Date(b.deadline || "2999-01-01");
    return da - db;
  });

  // ── Compute average fit score for summary strip ───────────
  const avgFitScore = qualified.length
    ? (
        qualified.reduce((sum, o) => sum + (o.fitScore || 0), 0) /
        qualified.length
      ).toFixed(1)
    : "0";

  // ── Find highest funding amount ───────────────────────────
  const highestAmount = findHighestAmount(qualified);

  onStatus(
    `Layer 2 — ${qualified.length} qualified (avg fit ${avgFitScore}/5). ` +
    `Running guard check…`
  );

  return {
    qualified,
    filtered,
    meta: {
      total:         merged.length,
      qualified:     qualified.length,
      filteredOut:   filtered.length,
      avgFitScore,
      highestAmount,
      minFitScore:   minScore,
    },
  };
}


// ============================================================
// MERGE QUALIFICATION RESULTS
// Merges the model's scoring output back into opportunity objects.
// Matches by opportunity ID passed through the prompt.
// ============================================================

/**
 * Merge qualification scores into opportunity objects.
 * The model returns results keyed by the opportunity's .id field.
 *
 * @param {Array} opportunities  verified opportunity objects
 * @param {Array} results        qualification results from model
 * @returns {Array}              opportunities with qualification fields
 */
function mergeQualificationResults(opportunities, results) {
  // Build lookup: id → result
  const resultMap = new Map();
  results.forEach((r) => {
    if (r.id) resultMap.set(String(r.id).trim(), r);
  });

  return opportunities.map((opp) => {
    const result = resultMap.get(String(opp.id).trim());

    if (!result) {
      // Model missed this opportunity — assign minimum score
      // so it gets filtered out rather than silently passing
      console.warn(
        `Qualification: no result for opportunity "${opp.funder}" (${opp.id})`
      );
      return {
        ...opp,
        matchLevel:        "NO",
        fitScore:          1,
        missionAlignment:  "Could not be evaluated — no result returned",
        geoEligibility:    opp.geoEligibility || "—",
        orgEligibility:    opp.orgEligibility || "—",
        appStatus:         opp.appStatus,
        deadline:          opp.deadline,
        amount:            opp.amount,
        risks:             "Needs manual review — qualification skipped",
        recommendedAction: "Needs Verification",
        confidence:        "Low",
        whyQualifies:      "Could not be evaluated automatically",
      };
    }

    // ── Derive the tier deterministically from AI-extracted facts.
    // The model never decides HIGH/GOOD/OK/NO directly — see
    // matchScoring.js for why that split matters.
    const matchLevel = deriveMatchLevel({
      focusMatch:        result.focusMatch,
      populationMatch:   result.populationMatch,
      geoMatch:          result.geoMatch,
      nonprofitEligible: result.nonprofitEligible,
    });

    return {
      ...opp,
      // Qualification fields — overwrite discovery estimates with
      // model's more careful evaluation
      matchLevel:        matchLevel,
      fitScore:          matchLevelToFitScore(matchLevel),
      // Raw extracted facts kept on the row too — useful for the
      // Grant Team to see WHY a tier was assigned, and for spot-
      // checking the AI's reading against the actual grant text.
      focusMatch:        result.focusMatch      || "unclear",
      populationMatch:   result.populationMatch || "unclear",
      geoMatch:          result.geoMatch        || "unclear",
      nonprofitEligible: result.nonprofitEligible ?? "unclear",
      missionAlignment:  (result.missionAlignment  || "").trim(),
      geoEligibility:    (result.geoEligibility    || opp.geoEligibility || "").trim(),
      orgEligibility:    (result.orgEligibility    || opp.orgEligibility || "").trim(),
      // Update appStatus and deadline only if model has better data
      appStatus:         result.appStatus || opp.appStatus,
      deadline:          normaliseQualDeadline(result.deadline, opp.deadline),
      amount:            (result.amount            || opp.amount || "—").trim(),
      risks:             (result.risks             || "").trim(),
      recommendedAction: normaliseAction(result.recommendedAction),
      confidence:        normaliseConfidence(result.confidence),
      whyQualifies:      (result.whyQualifies      || "").trim(),
    };
  });
}

/**
 * Normalise deadline from qualification — prefer the more specific
 * value between qualification result and original discovery data.
 * @param {string} qualDeadline   from model
 * @param {string} origDeadline   from discovery
 * @returns {string}
 */
function normaliseQualDeadline(qualDeadline, origDeadline) {
  // If qualification confirmed a real date, use it
  if (qualDeadline && /^\d{4}-\d{2}-\d{2}$/.test(qualDeadline)) {
    const d = new Date(qualDeadline);
    if (!isNaN(d)) return qualDeadline;
  }
  if (qualDeadline && qualDeadline.toLowerCase() === "rolling") {
    return "Rolling";
  }
  // Fall back to discovery deadline
  return origDeadline || "Needs Verification";
}

/**
 * Normalise recommended action to one of six valid values.
 * @param {string} raw
 * @returns {string}
 */
function normaliseAction(raw) {
  const s = (raw || "").trim();
  const valid = CONFIG.actionOptions;
  // Exact match first
  if (valid.includes(s)) return s;
  // Fuzzy match
  const lower = s.toLowerCase();
  if (lower.includes("immediately"))   return "Apply Immediately";
  if (lower.includes("high"))          return "High Priority";
  if (lower.includes("review"))        return "Review This Week";
  if (lower.includes("verif"))         return "Needs Verification";
  if (lower.includes("monitor"))       return "Monitor Future Cycle";
  if (lower.includes("not") ||
      lower.includes("do not"))        return "Do Not Pursue";
  return "Review This Week"; // safe default
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
  return "Medium";
}

/**
 * Find the highest funding amount in a set of opportunities.
 * Used for the summary strip stat card.
 * @param {Array} opportunities
 * @returns {string}  formatted amount string or "—"
 */
function findHighestAmount(opportunities) {
  let highest = 0;
  opportunities.forEach((o) => {
    // Extract all numbers from amount string
    const nums = (o.amount || "")
      .replace(/,/g, "")
      .match(/\d+/g);
    if (nums) {
      const max = Math.max(...nums.map(Number));
      if (max > highest) highest = max;
    }
  });
  if (highest === 0) return "—";
  return "$" + highest.toLocaleString();
}


// ============================================================
// UI HELPERS
// ============================================================

/**
 * Render the qualification summary panel in the UI.
 * Shows how many passed, average score, highest amount.
 * @param {Object} meta  from runQualification()
 */
function renderQualificationSummary(meta) {
  const el = document.getElementById("qualification-summary");
  if (!el) return;

  el.innerHTML = `
    <div class="panel panel-tint" style="margin-bottom:var(--gap-md);">
      <div class="flex-between flex-wrap gap-sm">
        <div>
          <h4 style="margin:0 0 2px 0;">Layer 2 — Qualification & Scoring</h4>
          <div class="muted" style="font-size:var(--text-sm);">
            model: <span class="mono">${esc(CONFIG.qualification.model)}</span>
            · reasoning effort: low
            · min fit score: ${esc(String(meta.minFitScore))}
          </div>
        </div>
        <div class="flex gap-sm flex-wrap">
          <span class="pill pill-pass">✅ ${esc(String(meta.qualified))} qualified</span>
          ${meta.filteredOut > 0
            ? `<span class="pill pill-verify">
                 🗑 ${esc(String(meta.filteredOut))} below score ${esc(String(meta.minFitScore))}
               </span>`
            : ""}
        </div>
      </div>
      <div class="summary-strip" style="margin-top:var(--gap-md);margin-bottom:0;">
        <div class="stat-card">
          <div class="stat-number">${esc(String(meta.avgFitScore))}<span style="font-size:14px;color:var(--muted);">/5</span></div>
          <div class="stat-label">Avg fit score</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${esc(meta.highestAmount)}</div>
          <div class="stat-label">Highest amount</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${esc(String(meta.qualified))}</div>
          <div class="stat-label">To guard check</div>
        </div>
      </div>
    </div>`;

  el.style.display = "block";
}

/**
 * Render top 3 recommendations panel.
 * Shown above the full opportunity card list.
 * @param {Array} qualified  sorted qualified opportunities
 */
function renderTopRecommendations(qualified) {
  const el = document.getElementById("top-recommendations");
  if (!el) return;

  if (qualified.length === 0) {
    el.innerHTML = "";
    return;
  }

  const top3 = qualified.slice(0, 3);

  const items = top3.map((o, i) => `
    <div class="top-rec">
      <b>${esc(i + 1 + ". " + o.funder)}</b>
      ${esc(o.missionAlignment || o.whyQualifies || "")}
      <div class="top-rec-meta">
        ${esc(o.amount || "—")} ·
        due ${esc(o.deadline || "Rolling")} ·
        fit ${esc(String(o.fitScore || "—"))}/5 ·
        <b>${esc(o.recommendedAction || "—")}</b>
      </div>
    </div>`
  ).join("");

  el.innerHTML = `
    <div class="panel" style="margin-bottom:var(--gap-md);">
      <h3 style="margin:0 0 var(--gap-sm) 0;">Top recommendations</h3>
      ${items}
    </div>`;

  el.style.display = "block";
}
