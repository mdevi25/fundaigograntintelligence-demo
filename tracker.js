/**
 * ============================================================
 * tracker.js — Layer 3: Grant Pipeline Tracker
 * AI-Powered Grant Discovery System
 * Version: 1.0 | July 2026
 *
 * WHAT THIS FILE DOES:
 * Manages the persistent grant pipeline table — the operational
 * hub of the entire system. Every verified, qualified, and
 * guard-checked opportunity lands here for staff to manage.
 *
 * FEATURES:
 *   - Persistent storage via window.storage + localStorage fallback
 *   - Inline editable table (click any cell to edit)
 *   - Status dropdown with color-coded rows
 *   - Deadline urgency badges (red/amber/green)
 *   - One-click add from discovery results
 *   - Memory integration — addKnownFunder() called on every add
 *   - Delete with memory cleanup — removeKnownFunder() on delete
 *   - Sort by deadline ascending (earliest first)
 *   - Tab badge showing live count of tracked opportunities
 *   - Export to CSV for Google Sheets import
 *   - Deadline alert check — flags items within 14 days
 *
 * MEMORY INTEGRATION (memory.js):
 *   addKnownFunder()          called on every tracker add
 *   updateKnownFunderStatus() called on every status change
 *   removeKnownFunder()       called on every row delete
 *
 * DEPENDENCIES:
 *   config.js  (CONFIG, saveTrackerRows, loadTrackerRows,
 *               generateId, today, daysUntil, deadlineClass,
 *               daysLabel, esc, showToast)
 *   memory.js  (addKnownFunder, updateKnownFunderStatus,
 *               removeKnownFunder)
 * ============================================================
 */


// ============================================================
// STATE
// In-memory array of tracker rows.
// Synced to persistent storage on every change.
// ============================================================

let trackerRows = [];


// ============================================================
// INITIALISATION
// Called once by index.html on page load.
// ============================================================

/**
 * Load tracker rows from persistent storage and render.
 * Called once on app init from index.html.
 */
async function initTracker() {
  try {
    trackerRows = await loadTrackerRows();
  } catch (e) {
    console.warn("tracker.js: could not load rows:", e.message);
    trackerRows = [];
  }
  renderTracker();
  updateTrackerBadge();
  checkUpcomingDeadlines();
}


// ============================================================
// ADD OPPORTUNITY TO TRACKER
// Called from discovery results UI ("+ Add to Tracker" button)
// and from "Add all verified" bulk action.
// ============================================================

/**
 * Add a single opportunity to the tracker.
 * Called from discovery.js renderOpportunityCard() button.
 * Integrates with memory.js to mark funder as known.
 *
 * @param {string}  oppId   opportunity .id from discovery results
 * @param {boolean} silent  if true, skip toast and re-render
 *                          (used for bulk add)
 */
function addOpportunityToTracker(oppId, silent = false) {
  // Find the opportunity in the current pipeline results
  // Results are stored on window by index.html after each run
  const opp = findOpportunityById(oppId);

  if (!opp) {
    if (!silent) showToast("Opportunity not found. Try running search again.");
    return;
  }

  // Check for duplicate — same funder + program already in tracker
  const duplicate = trackerRows.find(
    (r) =>
      r.funder.toLowerCase()  === (opp.funder  || "").toLowerCase() &&
      r.program.toLowerCase() === (opp.program || "").toLowerCase()
  );

  if (duplicate) {
    if (!silent) showToast(`"${opp.funder}" is already in the tracker.`);
    return;
  }

  const newRow = {
    id:                generateId(),
    funder:            opp.funder            || "",
    program:           opp.program           || "",
    amount:            opp.amount            || "",
    deadline:          opp.deadline          || "",
    fitScore:          opp.fitScore          || 3,
    matchLevel:        opp.matchLevel        || "",
    focusMatch:        opp.focusMatch        || "",
    populationMatch:   opp.populationMatch   || "",
    geoMatch:          opp.geoMatch          || "",
    nonprofitEligible: opp.nonprofitEligible ?? "",
    // Always starts neutral — status is a deliberate team decision, not
    // something the AI's suggestion should imply has already happened.
    status:            "New",
    url:               opp.finalUrl          || opp.url || "",
    linkStatus:        opp.linkStatus        || "VERIFIED",
    pageTitle:         opp.pageTitle         || "",
    dateVerified:      opp.dateVerified      || today(),
    assignedTo:        "",
    notes:             buildInitialNotes(opp),
    dateFound:         today(),
    guardStatus:       opp.guardStatus       || "PASS",
    confidence:        opp.confidence        || "Medium",
  };

  trackerRows.push(newRow);

  // ── Memory integration ────────────────────────────────────
  // Mark funder as known so it is excluded from future searches
  addKnownFunder(opp.funder, newRow.status, "tracker");

  // ── Persist and render ────────────────────────────────────
  saveTrackerRows(trackerRows);

  if (!silent) {
    renderTracker();
    updateTrackerBadge();
    showToast(`"${opp.funder}" added to tracker.`);
  }
}

/**
 * Add all verified opportunities from the last discovery run.
 * Skips duplicates and ineligible ones silently.
 * Called from the "Add all verified" button in index.html.
 */
function addAllToTracker() {
  const allOpps = window._currentPipelineResults || [];
  const eligible = allOpps.filter(
    (o) =>
      o.guardStatus !== null &&          // went through full pipeline
      o.fitScore >= CONFIG.qualification.minFitScore &&
      o.recommendedAction !== "Do Not Pursue"
  );

  if (eligible.length === 0) {
    showToast("No eligible opportunities to add. Run a discovery search first.");
    return;
  }

  let added = 0;
  eligible.forEach((opp) => {
    const duplicate = trackerRows.find(
      (r) =>
        r.funder.toLowerCase()  === (opp.funder  || "").toLowerCase() &&
        r.program.toLowerCase() === (opp.program || "").toLowerCase()
    );
    if (!duplicate) {
      addOpportunityToTracker(opp.id, true); // silent
      added++;
    }
  });

  saveTrackerRows(trackerRows);
  renderTracker();
  updateTrackerBadge();
  showToast(
    added > 0
      ? `Added ${added} opportunit${added !== 1 ? "ies" : "y"} to tracker.`
      : "All opportunities already in tracker."
  );
}

/**
 * Build the initial notes string from opportunity flags and guard.
 * Gives staff immediate context on why the opp was flagged.
 * @param {Object} opp
 * @returns {string}
 */
function buildInitialNotes(opp) {
  const parts = [];
  if (opp.risks && opp.risks.trim()) {
    parts.push(`Risks: ${opp.risks}`);
  }
  if (opp.guardStatus === "FLAG" && opp.guardNote) {
    parts.push(`⚠️ Guard flag: ${opp.guardNote}`);
  }
  if (opp.deadlineNote) {
    parts.push(`Note: ${opp.deadlineNote}`);
  }
  return parts.join(" | ");
}


// ============================================================
// ADD BLANK ROW (manual entry)
// Called from the "Add manually" button in the tracker UI.
// ============================================================

/**
 * Add a blank row to the tracker for manual entry.
 * Staff fills in all fields directly in the table.
 */
function addBlankTrackerRow() {
  const newRow = {
    id:           generateId(),
    funder:       "",
    program:      "",
    amount:       "",
    deadline:     "",
    fitScore:     3,
    status:       "New",
    url:          "",
    linkStatus:   "",
    pageTitle:    "",
    dateVerified: "",
    assignedTo:   "",
    notes:        "",
    dateFound:    today(),
    guardStatus:  "PASS",
    confidence:   "Medium",
  };

  // Add at top so staff sees it immediately
  trackerRows.unshift(newRow);
  saveTrackerRows(trackerRows);
  renderTracker();
  updateTrackerBadge();

  // Focus the funder cell of the new row
  setTimeout(() => {
    const firstInput = document.querySelector(
      `#tracker-row-${newRow.id} .tracker-funder-input`
    );
    if (firstInput) firstInput.focus();
  }, 50);
}


// ============================================================
// UPDATE ROW FIELD
// Called from inline table cell onChange handlers.
// ============================================================

/**
 * Update a single field on a tracker row.
 * Called by inline table inputs on change.
 * Integrates with memory.js when status changes.
 *
 * @param {string} rowId  tracker row .id
 * @param {string} field  field name to update
 * @param {*}      value  new value
 */
function updateTrackerField(rowId, field, value) {
  const row = trackerRows.find((r) => r.id === rowId);
  if (!row) return;

  row[field] = value;

  // ── Memory integration on status change ──────────────────
  if (field === "status" && row.funder) {
    updateKnownFunderStatus(row.funder, value);
  }

  // ── Memory integration on funder name change ──────────────
  if (field === "funder" && value.trim()) {
    addKnownFunder(value.trim(), row.status, "manual");
  }

  saveTrackerRows(trackerRows);

  // Re-render only the deadline badge if deadline changed
  // (avoid full re-render on every keystroke)
  if (field === "deadline" || field === "status") {
    renderTracker();
  }
}


// ============================================================
// DELETE ROW
// ============================================================

/**
 * Delete a tracker row by ID.
 * Cleans up memory so funder can be rediscovered.
 * Asks for confirmation before deleting.
 *
 * @param {string} rowId  tracker row .id
 */
function deleteTrackerRow(rowId) {
  const row = trackerRows.find((r) => r.id === rowId);
  if (!row) return;

  const confirmed = confirm(
    `Remove "${row.funder || "this opportunity"}" from the tracker?\n\n` +
    `This will also allow it to appear in future discovery searches.`
  );
  if (!confirmed) return;

  // ── Memory cleanup ────────────────────────────────────────
  if (row.funder) {
    removeKnownFunder(row.funder);
  }

  trackerRows = trackerRows.filter((r) => r.id !== rowId);
  saveTrackerRows(trackerRows);
  renderTracker();
  updateTrackerBadge();
  showToast(`"${row.funder || "Opportunity"}" removed from tracker.`);
}


// ============================================================
// RENDER TRACKER TABLE
// Full re-render of the tracker tab UI.
// ============================================================

/**
 * Render the full tracker table.
 * Called after any data change.
 */
function renderTracker() {
  const tableBody  = document.getElementById("tracker-body");
  const emptyState = document.getElementById("tracker-empty");
  const countEl    = document.getElementById("tracker-count");

  if (!tableBody) return;

  // Sort by deadline ascending (earliest first)
  // Rows with no deadline go to bottom
  const sorted = [...trackerRows].sort((a, b) => {
    const da = a.deadline && a.deadline !== "Rolling"
      ? new Date(a.deadline) : new Date("2999-01-01");
    const db = b.deadline && b.deadline !== "Rolling"
      ? new Date(b.deadline) : new Date("2999-01-01");
    return da - db;
  });

  // Update count label
  if (countEl) {
    countEl.textContent = trackerRows.length
      ? `${trackerRows.length} opportunit${trackerRows.length !== 1 ? "ies" : "y"} tracked`
      : "";
  }

  // Empty state
  if (sorted.length === 0) {
    tableBody.innerHTML = "";
    if (emptyState) emptyState.style.display = "block";
    return;
  }

  if (emptyState) emptyState.style.display = "none";

  // Render rows
  tableBody.innerHTML = sorted.map((row) => renderTrackerRow(row)).join("");
}

/**
 * Render a single tracker table row.
 * All cells are inline-editable.
 * @param {Object} row  tracker row object
 * @returns {string}    HTML string
 */
function renderTrackerRow(row) {
  // Deadline badge
  const dlClass = deadlineClass(row.deadline);
  const dlText  = row.deadline === "Rolling"
    ? "Rolling"
    : row.deadline
    ? daysLabel(row.deadline)
    : "—";

  // Fit score dots (compact — 5 dots)
  const fitDots = [1,2,3,4,5].map((n) =>
    `<span class="fit-dot ${n <= (row.fitScore || 0) ? "filled" : ""}"></span>`
  ).join("");

  // Status row class
  const rowClass = {
    "Funded":    "status-funded",
    "Submitted": "status-submitted",
    "Declined":  "status-declined",
  }[row.status] || "";

  // Guard flag indicator
  const guardFlag = row.guardStatus === "FLAG"
    ? `<span title="Guard flagged — verify before applying"
             style="color:var(--gold);margin-left:4px;">⚠️</span>`
    : "";

  // Status dropdown options
  const statusOptions = CONFIG.statusOptions.map((s) =>
    `<option value="${esc(s)}" ${normaliseLegacyStatus(row.status) === s ? "selected" : ""}>${esc(s)}</option>`
  ).join("");

  // Fit score dropdown
  const fitOptions = [1,2,3,4,5].map((n) =>
    `<option value="${n}" ${String(row.fitScore) === String(n) ? "selected" : ""}>${n}</option>`
  ).join("");

  return `
    <tr id="tracker-row-${esc(row.id)}" class="${rowClass}">

      <!-- Funder -->
      <td>
        <input
          class="table-input tracker-funder-input"
          value="${esc(row.funder)}"
          placeholder="Funder name"
          onchange="updateTrackerField('${esc(row.id)}', 'funder', this.value)"
        >
        ${guardFlag}
      </td>

      <!-- Program -->
      <td>
        <input
          class="table-input"
          value="${esc(row.program)}"
          placeholder="Grant program"
          onchange="updateTrackerField('${esc(row.id)}', 'program', this.value)"
        >
      </td>

      <!-- Amount -->
      <td style="white-space:nowrap;">
        <input
          class="table-input"
          value="${esc(row.amount)}"
          placeholder="$—"
          style="width:90px;"
          onchange="updateTrackerField('${esc(row.id)}', 'amount', this.value)"
        >
      </td>

      <!-- Deadline -->
      <td>
        <input
          class="table-input mono"
          value="${esc(row.deadline)}"
          placeholder="YYYY-MM-DD"
          style="width:108px;"
          onchange="updateTrackerField('${esc(row.id)}', 'deadline', this.value)"
        >
        ${row.deadline
          ? `<div class="dl-badge ${dlClass}" style="margin-top:3px;display:inline-block;">
               ${esc(dlText)}
             </div>`
          : ""}
      </td>

      <!-- Fit Score -->
      <td style="text-align:center;">
        <select
          class="table-input"
          style="width:48px;padding:4px 2px;text-align:center;"
          onchange="updateTrackerField('${esc(row.id)}', 'fitScore', this.value)"
        >
          ${fitOptions}
        </select>
        <div class="fit-dots" style="margin-top:3px;">${fitDots}</div>
      </td>

      <!-- Status -->
      <td>
        <select
          class="table-input"
          onchange="updateTrackerField('${esc(row.id)}', 'status', this.value)"
        >
          ${statusOptions}
        </select>
      </td>

      <!-- Source URL -->
      <td>
        ${row.url
          ? `<a href="${esc(row.url)}" target="_blank" rel="noopener"
                style="font-size:var(--text-xs);white-space:nowrap;">
               Open →
             </a>`
          : `<input
               class="table-input"
               value=""
               placeholder="URL"
               style="width:80px;"
               onchange="updateTrackerField('${esc(row.id)}', 'url', this.value)"
             >`
        }
        ${row.pageTitle
          ? `<div style="font-size:10px;color:var(--muted);margin-top:2px;
                         max-width:120px;overflow:hidden;text-overflow:ellipsis;
                         white-space:nowrap;" title="${esc(row.pageTitle)}">
               ${esc(row.pageTitle)}
             </div>`
          : ""}
      </td>

      <!-- Assigned To -->
      <td>
        <input
          class="table-input"
          value="${esc(row.assignedTo)}"
          placeholder="Name"
          style="width:80px;"
          onchange="updateTrackerField('${esc(row.id)}', 'assignedTo', this.value)"
        >
      </td>

      <!-- Notes -->
      <td>
        <textarea
          class="table-input"
          style="min-height:36px;width:160px;resize:vertical;"
          onchange="updateTrackerField('${esc(row.id)}', 'notes', this.value)"
        >${esc(row.notes)}</textarea>
      </td>

      <!-- Date Found -->
      <td class="mono" style="color:var(--muted);white-space:nowrap;font-size:var(--text-xs);">
        ${esc(row.dateFound || "—")}
      </td>

      <!-- Delete -->
      <td>
        <button
          class="btn btn-danger btn-sm"
          onclick="deleteTrackerRow('${esc(row.id)}')"
          title="Remove from tracker"
        >×</button>
      </td>

    </tr>`;
}


// ============================================================
// TAB BADGE
// Shows live count on the Tracker nav tab.
// ============================================================

/**
 * Update the tracker tab badge with current row count.
 */
function updateTrackerBadge() {
  const badge = document.getElementById("tracker-tab-badge");
  if (!badge) return;
  if (trackerRows.length === 0) {
    badge.style.display = "none";
  } else {
    badge.textContent   = String(trackerRows.length);
    badge.style.display = "inline-flex";
  }
}


// ============================================================
// DEADLINE ALERTS
// Checks for upcoming deadlines and shows an alert banner.
// Called on init and after tracker changes.
// ============================================================

/**
 * Check for opportunities with deadlines within urgentDays.
 * Shows a banner in the tracker tab if any are found.
 */
function checkUpcomingDeadlines() {
  const el = document.getElementById("deadline-alert-banner");
  if (!el) return;

  const urgent = trackerRows.filter((row) => {
    if (!row.deadline || row.deadline === "Rolling") return false;
    if (["Submitted","Funded","Declined","Not Eligible"].includes(row.status)) {
      return false; // don't alert on closed items
    }
    const days = daysUntil(row.deadline);
    return days !== null && days >= 0 && days <= CONFIG.tracker.urgentDays;
  });

  if (urgent.length === 0) {
    el.style.display = "none";
    return;
  }

  // Sort by days remaining ascending
  urgent.sort((a, b) => daysUntil(a.deadline) - daysUntil(b.deadline));

  el.innerHTML = `
    <div style="background:var(--red-soft);border:1px solid var(--red);
                border-radius:var(--radius-md);padding:12px 16px;
                margin-bottom:var(--gap-md);">
      <b style="color:var(--red);">
        ⏰ ${urgent.length} deadline${urgent.length !== 1 ? "s" : ""} within
        ${CONFIG.tracker.urgentDays} days:
      </b>
      <ul style="margin:6px 0 0 16px;font-size:var(--text-sm);">
        ${urgent.map((r) => `
          <li>
            <b>${esc(r.funder)}</b> — ${esc(r.program || "—")}
            <span class="dl-badge dl-urgent" style="margin-left:6px;">
              ${esc(daysLabel(r.deadline))}
            </span>
            — due ${esc(r.deadline)}
          </li>`).join("")}
      </ul>
    </div>`;

  el.style.display = "block";
}


// ============================================================
// CSV EXPORT
// Exports tracker rows to CSV for Google Sheets import.
// ============================================================

/**
 * Export all tracker rows to a CSV file and trigger download.
 * Staff can import this into Google Sheets for sharing.
 */
function exportTrackerToCSV() {
  if (trackerRows.length === 0) {
    showToast("No opportunities to export. Add some to the tracker first.");
    return;
  }

  const headers = [
    "Funder", "Program", "Amount", "Deadline", "Fit Score",
    "Status", "URL", "Link Status", "Page Title", "Date Verified",
    "Assigned To", "Notes", "Date Found", "Guard Status", "Confidence"
  ];

  const rows = trackerRows.map((r) => [
    r.funder, r.program, r.amount, r.deadline, r.fitScore,
    r.status, r.url, r.linkStatus, r.pageTitle, r.dateVerified,
    r.assignedTo, r.notes, r.dateFound, r.guardStatus, r.confidence
  ]);

  const csvContent = [headers, ...rows]
    .map((row) =>
      row.map((cell) => {
        // Escape quotes and wrap in quotes if contains comma/newline
        const str = String(cell == null ? "" : cell).replace(/"/g, '""');
        return /[,"\n]/.test(str) ? `"${str}"` : str;
      }).join(",")
    )
    .join("\n");

  // Trigger download
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href     = url;
  link.download = `ere-grant-tracker-${today()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`Exported ${trackerRows.length} rows to CSV.`);
}


// ============================================================
// FIND OPPORTUNITY BY ID
// Looks up an opportunity in the current pipeline results.
// Results stored on window by index.html after each run.
// ============================================================

/**
 * Find an opportunity by ID in the current pipeline results.
 * @param {string} oppId
 * @returns {Object|null}
 */
function findOpportunityById(oppId) {
  const qualified = window._currentPipelineResults || [];
  const filtered  = window._currentFilteredResults  || [];
  return qualified.find((o) => o.id === oppId) || filtered.find((o) => o.id === oppId) || null;
}


// ============================================================
// TRACKER SUMMARY STATS
// Used by index.html to show pipeline health at a glance.
// ============================================================

/**
 * Get summary stats for the tracker.
 * Used to populate stat cards in the Tracker tab header.
 * @returns {Object}
 */
function getTrackerStats() {
  const total     = trackerRows.length;
  const pursuing  = trackerRows.filter((r) => normaliseLegacyStatus(r.status) === "Pursue").length;
  const submitted = trackerRows.filter((r) => r.status === "Submitted").length;
  const funded    = trackerRows.filter((r) => r.status === "Funded").length;
  const urgent    = trackerRows.filter((r) => {
    const days = daysUntil(r.deadline);
    return days !== null && days >= 0 && days <= CONFIG.tracker.urgentDays &&
           !["Submitted","Funded","Declined","Not Eligible"].includes(r.status);
  }).length;

  // Total potential funding from Pursuing rows
  let totalPotential = 0;
  trackerRows
    .filter((r) => normaliseLegacyStatus(r.status) === "Pursue" || r.status === "New")
    .forEach((r) => {
      const nums = (r.amount || "").replace(/,/g, "").match(/\d+/g);
      if (nums) totalPotential += Math.max(...nums.map(Number));
    });

  return {
    total,
    pursuing,
    submitted,
    funded,
    urgent,
    totalPotential: totalPotential > 0
      ? "$" + totalPotential.toLocaleString()
      : "—",
  };
}

/**
 * Render the tracker summary stat cards.
 * Called by renderTracker() and after status changes.
 */
function renderTrackerStats() {
  const el = document.getElementById("tracker-stats");
  if (!el) return;

  const stats = getTrackerStats();

  el.innerHTML = `
    <div class="summary-strip" style="margin-bottom:var(--gap-md);">
      <div class="stat-card">
        <div class="stat-number">${esc(String(stats.total))}</div>
        <div class="stat-label">Total tracked</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" style="color:var(--gold-deep);">
          ${esc(String(stats.pursuing))}
        </div>
        <div class="stat-label">Pursuing</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" style="color:var(--teal);">
          ${esc(String(stats.submitted))}
        </div>
        <div class="stat-label">Submitted</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" style="color:var(--green);">
          ${esc(String(stats.funded))}
        </div>
        <div class="stat-label">Funded</div>
      </div>
      ${stats.urgent > 0
        ? `<div class="stat-card" style="border-color:var(--red);">
             <div class="stat-number dl-urgent" style="background:none;padding:0;">
               ${esc(String(stats.urgent))}
             </div>
             <div class="stat-label">Urgent deadlines</div>
           </div>`
        : ""}
      <div class="stat-card">
        <div class="stat-number" style="font-size:16px;">
          ${esc(stats.totalPotential)}
        </div>
        <div class="stat-label">Pipeline value</div>
      </div>
    </div>`;
}
