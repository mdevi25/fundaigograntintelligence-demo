/**
 * ============================================================
 * matchScoring.js — org-relative grant match-tier logic
 * Fundaigo
 *
 * GENERALIZED from ERE's original hardcoded rubric (2026-
 * GrantMatchScoring.txt), which was built and tuned using ERE
 * as the test org while proving out the scoring pipeline. The
 * original hardcoded version is preserved as
 * matchScoring.ere-hardcoded.js for reference/revert.
 *
 * WHY THIS IS A SEPARATE, PURE, DETERMINISTIC FUNCTION:
 * qualification.js asks the AI to extract three FACTS about a
 * grant relative to THIS org's own profile — focus alignment,
 * population alignment, geographic alignment — plus nonprofit
 * eligibility. Reading comprehension against the org's own
 * stated profile, which LLMs are good at. The actual HIGH/GOOD/
 * OK/NO decision is a fixed waterfall over those facts, applied
 * here in plain code, no AI involved, so it can't drift, can't
 * hallucinate a tier, and is fully unit testable without ever
 * calling the Groq API.
 *
 * TUNABLE: this waterfall shape mirrors ERE's original tiering
 * exactly (exact match on everything = HIGH, broader-but-related
 * = GOOD, loosely related = OK, mismatch/ineligible = NO) — just
 * parameterized by whatever the org actually typed into their
 * own profile instead of ERE's specific math/reading/7-12/TX-IL
 * categories. For ERE's own profile this should reproduce
 * equivalent results to the original, since it derives the same
 * relationships from ERE's actual profile text instead of a
 * hardcoded string — worth a spot-check against real runs before
 * fully trusting it in production.
 * ============================================================
 */

const MATCH_LEVELS = ["HIGH", "GOOD", "OK", "NO"];

// Categorical fit score a grant with each tier maps to, for
// compatibility with the existing 1–5 fitScore used everywhere
// else in the app (tracker sort/filter, UI stars, minFitScore
// threshold). NO deliberately maps below CONFIG.qualification
// .minFitScore (default 2) so it's filtered out automatically.
const MATCH_LEVEL_TO_FIT_SCORE = { HIGH: 5, GOOD: 4, OK: 3, NO: 1 };

/**
 * Apply the org-relative match-tier waterfall to AI-extracted
 * facts about one grant opportunity, each fact judged against
 * THIS org's own profile (focus areas, population served,
 * locations), not a fixed taxonomy. Pure function — same input
 * always gives same output, independent of any AI call.
 *
 * @param {Object} facts
 * @param {"yes"|"partial"|"no"|"unclear"} facts.focusMatch
 *   Does the grant's subject/purpose align with the org's own
 *   stated focus areas?
 * @param {"yes"|"partial"|"no"|"unclear"} facts.populationMatch
 *   Does the grant's target population align with the org's own
 *   stated population served?
 * @param {"yes"|"partial"|"no"|"unclear"} facts.geoMatch
 *   Does the grant's geographic eligibility align with the org's
 *   own stated locations/service area?
 * @param {true|false|"unclear"} facts.nonprofitEligible
 * @returns {"HIGH"|"GOOD"|"OK"|"NO"}
 */
function deriveMatchLevel(facts) {
  const f = facts || {};

  // Nonprofit eligibility is a hard gate for every tier — "unclear"
  // is treated as failing it (conservative: don't rank a grant highly
  // when we're not sure this org can even apply).
  const nonprofitOk = f.nonprofitEligible === true;
  if (!nonprofitOk) return "NO";

  const focusYes    = f.focusMatch === "yes";
  const focusAtAll  = focusYes || f.focusMatch === "partial";

  const popYes      = f.populationMatch === "yes";
  const popAtAll    = popYes || f.populationMatch === "partial";

  const geoYes      = f.geoMatch === "yes";
  const geoAtAll    = geoYes || f.geoMatch === "partial";

  // HIGH — exact match on every dimension.
  if (focusYes && popYes && geoYes) return "HIGH";

  // GOOD — exact focus match, broader-but-related population and geography.
  if (focusYes && popAtAll && geoAtAll) return "GOOD";

  // OK — focus can be partial (loosely related), population/geo still at least partial.
  if (focusAtAll && popAtAll && geoAtAll) return "OK";

  // Everything else, including "unclear" facts that never satisfied
  // a tier above — falls to NO. Better to under-surface than to
  // rank an ambiguous grant as a good use of the Grant Team's time.
  return "NO";
}

/**
 * @param {"HIGH"|"GOOD"|"OK"|"NO"} level
 * @returns {number} 1–5, for compatibility with existing fitScore fields
 */
function matchLevelToFitScore(level) {
  return MATCH_LEVEL_TO_FIT_SCORE[level] ?? 1;
}

/**
 * Text block injected into the qualification system prompt,
 * telling the AI exactly which enum values to use for each fact
 * and nothing about tiers — the tier is never the AI's job.
 * Judged relative to the org's own profile, which qualification.js
 * places directly above this block in the prompt.
 */
const MATCH_EXTRACTION_INSTRUCTIONS = `
Extract these FACTS about the grant, relative to THIS org's own profile above — do not decide a tier, just report what you read:

focusMatch — does the grant's subject/purpose align with the org's stated focus areas? one of:
  "yes"     grant funds work squarely within the org's stated focus areas
  "partial" grant funds related or adjacent work, not a precise match
  "no"      grant funds something unrelated to the org's focus areas
  "unclear" cannot tell from available information

populationMatch — does the grant's target population align with the org's stated population served? one of:
  "yes"     grant explicitly targets the same population the org serves
  "partial" grant targets a broader or adjacent population that includes the org's population
  "no"      grant targets a population outside what the org serves
  "unclear" cannot tell from available information

geoMatch — does the grant's geographic eligibility align with the org's stated locations/service area? one of:
  "yes"     grant is explicitly eligible in the org's stated location(s)
  "partial" grant is nationally/regionally open, not restricted against the org's location(s)
  "no"      grant is restricted to a region that excludes the org's location(s)
  "unclear" cannot tell from available information

nonprofitEligible — true, false, or "unclear" — does the grant explicitly allow 501(c)(3) nonprofit applicants?
`.trim();

// ── Interpretation choices, carried over from ERE's original
// rubric and generalized the same way — documented here so the
// Grant Team can push back on any of these when tuning:
//
// 1. HIGH requires an exact match on every dimension (focus,
//    population, and geography all "yes") — a broader-but-related
//    match on any dimension caps the tier at GOOD, even if the
//    grant technically covers the org's population/area.
// 2. "partial" on population or geography is read as "broader,
//    but still includes the org" — e.g. a nationally-open grant
//    partially matches an org restricted to one state.
// 3. "unclear" on any fact never promotes a grant above NO for that
//    criterion — ambiguous grants fall to the lowest tier rather
//    than being optimistically ranked higher.

// Node-only export for matchScoring.test.js — no effect in the
// browser (index.html loads this as a plain <script>, same as
// every other file in the app; this block never runs there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { deriveMatchLevel, matchLevelToFitScore, MATCH_EXTRACTION_INSTRUCTIONS, MATCH_LEVELS };
}
