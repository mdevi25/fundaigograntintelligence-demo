/**
 * ============================================================
 * staging.js — Search-provider staging layer
 * Fundaigo
 * Version: 1.0 | August 2026
 *
 * CURRENT STATUS (August 2026): Gemini support was built, tested,
 * then rolled back — the provider toggle UI was removed from
 * Settings, and the Gemini call code was removed from discovery.js
 * and config.js. Groq is the only active search provider right now.
 * This file's functional code is unchanged by that rollback — it
 * was never Gemini-specific, and stays ready to route between
 * providers again the moment a second one exists.
 *
 * WHAT THIS FILE DOES:
 * Sits between Layer 1 (search) and everything after it (link
 * verification, qualification, guard). Discovery doesn't hand its
 * output directly to qualification; instead it publishes a "search
 * results staged" event through this file, and a registered
 * handler picks it up from there.
 *
 * WHY THIS EXISTS:
 * Built while Fundaigo supported both Groq and Gemini for search
 * (see the CURRENT STATUS note above for why that's since rolled
 * back). Downstream processing was — and still is — identical no
 * matter which provider found an opportunity: same link
 * verification, same qualification, same guard, all still Groq-
 * based. This file was the ONE place that would change if that
 * ever needed to differ by provider. Nothing in qualification.js,
 * guard.js, matchScoring.js, tracker.js, or learning.js changed for
 * this — they never knew which provider ran, and still don't.
 *
 * WHY THIS ISN'T A REAL EVENT BUS / MESSAGE QUEUE:
 * Fundaigo runs entirely client-side, one pipeline run at a time,
 * in a single browser tab — there's no separate service to route
 * between. A minimal awaitable handler list gets the real benefit
 * (a named, single extension point instead of a direct function
 * call buried in index.html's pipeline glue) without the
 * complexity a real pub/sub system would add for zero actual gain
 * at this scale.
 *
 * WHAT GETS TAGGED HERE VS. ELSEWHERE:
 * searchCategory is tagged upstream in discovery.js's
 * runDiscoveryOnce() (unchanged, still tested by the dry-run
 * harness) — this file does not re-tag it. This file adds
 * searchProvider and stagedAt, the two fields that only make
 * sense once staging exists as a distinct step. searchProvider is
 * currently always "groq" (hardcoded in discovery.js's return
 * value) since there's only one provider active, but the field is
 * kept rather than removed — no other file needs to change if a
 * second provider comes back.
 *
 * HOW IT CONNECTS TO OTHER FILES:
 *   discovery.js → produces the normalised opportunities and the
 *                  provider that found them (runDiscovery()'s
 *                  meta.provider)
 *   index.html   → calls publishSearchResults() instead of calling
 *                  runQualification() directly; registers the one
 *                  downstream handler once, at boot, via
 *                  onSearchResultsStaged()
 *   learning.js  → unaffected — still reads searchCategory off the
 *                  final opportunity object, same as before staging
 *                  existed
 * ============================================================
 */

const _searchStagedHandlers = [];

/**
 * Register a handler to run whenever new search results are
 * staged. Call once, at app boot (see index.html). Handlers run in
 * registration order, each awaited before the next starts.
 *
 * Registering more than one handler is supported — a future
 * handler could, for example, log provider-comparison stats
 * without touching the main processing handler at all — but
 * nothing in Fundaigo does that yet. See learning.js's file header
 * for why that's deliberately not built until there's usage
 * history to support it.
 *
 * @param {Function} handler  async (stagedOpportunities, meta) => any
 */
function onSearchResultsStaged(handler) {
  if (typeof handler !== "function") return;
  _searchStagedHandlers.push(handler);
}

/**
 * Stage raw discovery output: tag provenance, then notify every
 * registered handler in order, awaiting each in turn. This is the
 * single call site that replaces "call qualification directly
 * after discovery" in index.html's pipeline glue.
 *
 * @param {Array} opportunities  normalised opportunities from
 *   discovery.js's runDiscovery() — already carry searchCategory
 * @param {Object} meta  must include provider (currently always "groq").
 *   Any other keys (e.g. onStatus, setPipe callbacks the UI needs)
 *   are passed through untouched to every handler.
 * @returns {Promise<any>} the LAST registered handler's return
 *   value. Today there's exactly one handler (the full downstream
 *   pipeline in index.html), so this resolves to whatever that
 *   handler returns — see processStagedResults() in index.html.
 * @throws {Error} if no handler has been registered — a silent
 *   no-op here would mean staged results simply vanish, which is
 *   worse than a loud failure during development.
 */
async function publishSearchResults(opportunities, meta) {
  if (_searchStagedHandlers.length === 0) {
    throw new Error(
      "publishSearchResults() called with no handler registered — " +
      "see onSearchResultsStaged() in index.html's boot sequence."
    );
  }

  const stagedAt = new Date().toISOString();
  const staged = (opportunities || []).map((o) => ({
    ...o,
    searchProvider: meta.provider,
    stagedAt,
  }));

  let result;
  for (const handler of _searchStagedHandlers) {
    result = await handler(staged, meta);
  }
  return result;
}

/**
 * Test/dev helper — clears all registered handlers. Not used by
 * the app itself; exists so a dry-run harness can reset state
 * between test sections without reloading the whole page/context.
 */
function _clearStagedHandlers() {
  _searchStagedHandlers.length = 0;
}

// Node-only export for tests — no effect in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { onSearchResultsStaged, publishSearchResults, _clearStagedHandlers };
}
