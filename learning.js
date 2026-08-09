/**
 * ============================================================
 * learning.js — Compound Learning Layer
 * Fundaigo
 * Version: 1.0 | August 2026
 *
 * WHAT THIS FILE DOES:
 * Reads the org's own resolved Tracker history (Pursue, Submitted,
 * Funded, Declined, Not Eligible) and turns it into a preference
 * profile: which search categories, and which focus/population/geo
 * match patterns, have actually worked for this org versus which
 * ones haven't. That profile is then read by two other layers —
 * never written to by them:
 *
 *   1. discovery.js  — folds a short preference line into the
 *      weekly search prompt, so each run is shaped by everything
 *      that came before it instead of starting cold every time.
 *   2. matchScoring.js — applies a small, explainable, one-tier-
 *      max nudge to the Fit Score for new opportunities that
 *      resemble a category with a strong or weak track record.
 *
 * WHY A MINIMUM SAMPLE SIZE:
 * A "resolved" row is one with a real decision behind it — status
 * is Pursue, Submitted, Funded, Declined, or Not Eligible. Rows
 * still sitting at New or Defer haven't told us anything yet and
 * are excluded from every count below. Below MIN_RESOLVED_SAMPLE
 * resolved rows for a given category, that category stays silent
 * everywhere — no recommendation, no prompt line, no score nudge.
 * 1–2 outcomes is noise, not a pattern.
 *
 * WHY THIS NEVER TOUCHES deriveMatchLevel():
 * The pure HIGH/GOOD/OK/NO waterfall in matchScoring.js is
 * deterministic and already verified against ERE's real results.
 * Learning is deliberately a separate, optional, explainable layer
 * applied AFTER that waterfall runs — never folded into it — so the
 * core tier logic stays exactly as trustworthy and testable as it
 * was before this file existed.
 *
 * HOW IT CONNECTS TO OTHER FILES:
 *   tracker.js     → source of truth: trackerRows (fitScore,
 *                    matchLevel, focusMatch, populationMatch,
 *                    geoMatch, status, searchCategory)
 *   discovery.js    → calls buildLearningPromptLine()
 *   matchScoring.js → calls applyLearningAdjustment()
 *   index.html      → calls getRecommendedCategories() to render
 *                     the pre-search recommendation panel
 *
 * DEPENDENCIES:
 *   config.js  must be loaded first (CONFIG)
 *   tracker.js must be loaded first (trackerRows, CATEGORY labels)
 * ============================================================
 */


// ============================================================
// TUNABLES
// ============================================================

// A category needs at least this many RESOLVED rows before
// learning will say anything about it at all, in any surface.
// Reads from CONFIG.learning.minResolvedSample when available
// (config.js is the single source of truth); falls back to 5
// only if config.js hasn't loaded yet for some reason.
const MIN_RESOLVED_SAMPLE =
  (typeof CONFIG !== "undefined" && CONFIG.learning && CONFIG.learning.minResolvedSample) || 5;

// Statuses that count as "resolved" — a real decision was made.
// "New" and "Defer" are excluded: nothing has been learned yet.
const RESOLVED_STATUSES = ["Pursue", "Submitted", "Funded", "Declined", "Not Eligible"];

// Outcome weights used to compute a category's net signal.
// Funded counts more than Pursue (a bigger, later commitment);
// Not Eligible counts more against than Declined (Declined at
// least means the org was eligible and a human chose to apply).
const OUTCOME_WEIGHTS = {
  "Funded":       2,
  "Submitted":    1,
  "Pursue":       1,
  "Declined":    -1,
  "Not Eligible": -2,
};

// Human-readable labels for category keys, reused from
// discovery.js's CATEGORY_SEARCH_MAP keys so labels stay in sync
// with the actual chip values used at search time.
const CATEGORY_LABELS = {
  community:  "Community foundations",
  corporate:  "Corporate giving programs",
  government: "Government grants",
  faith:      "Faith-based funders",
  family:     "Family foundations",
  healthcare: "Healthcare foundations",
};

// Cap on how many category lines get folded into the discovery
// prompt, so the preference line never grows unbounded as tracker
// history accumulates over months of weekly runs.
const MAX_PROMPT_CATEGORY_LINES = 3;


// ============================================================
// INTERNAL — AGGREGATE TRACKER ROWS BY CATEGORY
// ============================================================

/**
 * Group resolved tracker rows by searchCategory and compute a net
 * signal per category. Unresolved rows and rows with no
 * searchCategory (added before this feature existed, or added
 * manually) are excluded — there's nothing to attribute them to.
 *
 * @param {Array} rows  trackerRows from tracker.js
 * @returns {Object}    { [category]: { resolved, net, funded,
 *                         declined, notEligible, pursue,
 *                         submitted } }
 */
function aggregateByCategory(rows) {
  const byCategory = {};

  (rows || []).forEach((r) => {
    const cats = Array.isArray(r.searchCategory)
      ? r.searchCategory
      : (r.searchCategory ? [r.searchCategory] : []);

    if (cats.length === 0) return;
    if (!RESOLVED_STATUSES.includes(r.status)) return;

    cats.forEach((cat) => {
      if (cat === "all" || !CATEGORY_LABELS[cat]) return; // skip the catch-all bucket
      if (!byCategory[cat]) {
        byCategory[cat] = {
          resolved: 0, net: 0,
          funded: 0, submitted: 0, pursue: 0, declined: 0, notEligible: 0,
        };
      }
      const bucket = byCategory[cat];
      bucket.resolved += 1;
      bucket.net += OUTCOME_WEIGHTS[r.status] || 0;
      if (r.status === "Funded")       bucket.funded += 1;
      if (r.status === "Submitted")    bucket.submitted += 1;
      if (r.status === "Pursue")       bucket.pursue += 1;
      if (r.status === "Declined")     bucket.declined += 1;
      if (r.status === "Not Eligible") bucket.notEligible += 1;
    });
  });

  return byCategory;
}

/**
 * Build a short, human-readable "why" for one category's signal.
 * e.g. "3 pursued, 1 funded" or "2 of 5 marked Not Eligible"
 * @param {Object} b  one category's bucket from aggregateByCategory
 * @returns {string}
 */
function describeBucket(b) {
  const parts = [];
  if (b.funded)      parts.push(`${b.funded} funded`);
  if (b.submitted)   parts.push(`${b.submitted} submitted`);
  if (b.pursue)      parts.push(`${b.pursue} pursued`);
  if (b.declined)    parts.push(`${b.declined} declined`);
  if (b.notEligible) parts.push(`${b.notEligible} not eligible`);
  return parts.join(", ") || `${b.resolved} resolved`;
}


// ============================================================
// PUBLIC — PREFERENCE PROFILE
// ============================================================

/**
 * Build the full preference profile from current tracker history.
 * Categories below MIN_RESOLVED_SAMPLE are omitted entirely from
 * reinforce/avoid — they show up only in untried/insufficient so
 * the UI can still be transparent about why nothing is being said.
 *
 * @returns {Object} {
 *   reinforce:   [{ category, label, resolved, net, why }]  sorted best-first
 *   avoid:       [{ category, label, resolved, net, why }]  sorted worst-first
 *   insufficient:[{ category, label, resolved }]  below MIN_RESOLVED_SAMPLE, has some data
 *   untried:     [{ category, label }]             zero resolved rows at all
 *   minSample:   number
 * }
 */
function buildPreferenceProfile() {
  const rows = (typeof trackerRows !== "undefined") ? trackerRows : [];
  const byCategory = aggregateByCategory(rows);

  const reinforce = [];
  const avoid = [];
  const insufficient = [];
  const untried = [];

  Object.keys(CATEGORY_LABELS).forEach((cat) => {
    const b = byCategory[cat];
    const label = CATEGORY_LABELS[cat];

    if (!b || b.resolved === 0) {
      untried.push({ category: cat, label });
      return;
    }
    if (b.resolved < MIN_RESOLVED_SAMPLE) {
      insufficient.push({ category: cat, label, resolved: b.resolved });
      return;
    }

    const entry = { category: cat, label, resolved: b.resolved, net: b.net, why: describeBucket(b) };
    if (b.net > 0) reinforce.push(entry);
    else if (b.net < 0) avoid.push(entry);
    // net === 0 with enough sample: genuinely neutral, surfaced nowhere
  });

  reinforce.sort((a, b) => b.net - a.net);
  avoid.sort((a, b) => a.net - b.net);

  return { reinforce, avoid, insufficient, untried, minSample: MIN_RESOLVED_SAMPLE };
}


// ============================================================
// PUBLIC — CONSUMED BY discovery.js (COMPOUNDING THE PROMPT)
// ============================================================

/**
 * Build the short preference line folded into the discovery user
 * prompt. Returns "" (nothing) if there isn't enough resolved
 * history anywhere yet — an empty-history org should search exactly
 * as it does today, with no invented signal.
 * @returns {string}
 */
function buildLearningPromptLine() {
  const cfg = (typeof CONFIG !== "undefined" && CONFIG.learning) || {};
  if (cfg.enabled === false || cfg.promptCompounding === false) return "";

  const profile = buildPreferenceProfile();
  if (profile.reinforce.length === 0 && profile.avoid.length === 0) return "";

  const lean = profile.reinforce.slice(0, MAX_PROMPT_CATEGORY_LINES).map((e) => e.label);
  const away = profile.avoid.slice(0, MAX_PROMPT_CATEGORY_LINES).map((e) => e.label);

  const parts = [];
  if (lean.length) parts.push(`this org's past results lean toward: ${lean.join(", ")}`);
  if (away.length) parts.push(`past results lean away from: ${away.join(", ")}`);

  return parts.length ? `Based on this org's own tracker history, ${parts.join("; ")}.` : "";
}


// ============================================================
// PUBLIC — CONSUMED BY matchScoring.js (SCORE ADJUSTMENT)
// ============================================================

/**
 * Apply a small, explainable, one-tier-max adjustment to a match
 * level based on the org's own history for that category — never
 * touches deriveMatchLevel() itself, always returns a visible
 * reason so the adjustment is never silent.
 *
 * Rules (deliberately conservative):
 * - Only moves ONE tier, and only among HIGH > GOOD > OK > NO.
 * - NO never gets promoted — nonprofit ineligibility is a hard
 *   gate in matchScoring.js and learning does not override it.
 * - Requires MIN_RESOLVED_SAMPLE resolved rows for that category.
 * - opportunityCategory may be a single category string or an
 *   array of the categories the search that found it used.
 *
 * @param {"HIGH"|"GOOD"|"OK"|"NO"} level   output of deriveMatchLevel()
 * @param {string|string[]} opportunityCategory
 * @returns {{ level: string, adjusted: boolean, reason: string }}
 */
function applyLearningAdjustment(level, opportunityCategory) {
  const cfg = (typeof CONFIG !== "undefined" && CONFIG.learning) || {};
  if (cfg.enabled === false || cfg.scoreAdjustment === false) {
    return { level, adjusted: false, reason: "" };
  }

  const TIER_ORDER = ["NO", "OK", "GOOD", "HIGH"];
  const cats = Array.isArray(opportunityCategory)
    ? opportunityCategory
    : (opportunityCategory ? [opportunityCategory] : []);

  if (cats.length === 0 || level === "NO") {
    return { level, adjusted: false, reason: "" };
  }

  const profile = buildPreferenceProfile();
  const reinforceHit = profile.reinforce.find((e) => cats.includes(e.category));
  const avoidHit      = profile.avoid.find((e) => cats.includes(e.category));

  // If a category shows up in both (multi-select search spanning a
  // strong and a weak category), do nothing — signal is ambiguous,
  // safer to leave the pure waterfall result untouched.
  if (reinforceHit && avoidHit) {
    return { level, adjusted: false, reason: "" };
  }

  const idx = TIER_ORDER.indexOf(level);

  if (reinforceHit && idx < TIER_ORDER.length - 1 && idx >= 0) {
    const newLevel = TIER_ORDER[idx + 1];
    return {
      level: newLevel,
      adjusted: true,
      reason: `Raised from ${level} to ${newLevel}: ${reinforceHit.label} has a strong track record with this org (${reinforceHit.why}).`,
    };
  }

  if (avoidHit && idx > 0) {
    const newLevel = TIER_ORDER[idx - 1];
    return {
      level: newLevel,
      adjusted: true,
      reason: `Lowered from ${level} to ${newLevel}: ${avoidHit.label} has a weak track record with this org (${avoidHit.why}).`,
    };
  }

  return { level, adjusted: false, reason: "" };
}


// ============================================================
// PUBLIC — CONSUMED BY index.html (RECOMMENDATION PANEL)
// ============================================================

/**
 * Ranked category suggestions for the pre-search recommendation
 * panel, plus untried categories worth exploring. Returns null
 * if there's nothing worth saying yet (no category has reached
 * MIN_RESOLVED_SAMPLE and there's no untried category either,
 * which in practice only happens once every category has both
 * been tried and resolved into "insufficient").
 * @returns {Object|null} { recommended: [...], untried: [...] }
 */
function getRecommendedCategories() {
  const cfg = (typeof CONFIG !== "undefined" && CONFIG.learning) || {};
  if (cfg.enabled === false) return null;

  const profile = buildPreferenceProfile();
  if (profile.reinforce.length === 0 && profile.untried.length === 0) return null;

  return {
    recommended: profile.reinforce.slice(0, MAX_PROMPT_CATEGORY_LINES),
    untried: profile.untried,
  };
}


// Node-only export for tests — no effect in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MIN_RESOLVED_SAMPLE,
    RESOLVED_STATUSES,
    CATEGORY_LABELS,
    buildPreferenceProfile,
    buildLearningPromptLine,
    applyLearningAdjustment,
    getRecommendedCategories,
  };
}
