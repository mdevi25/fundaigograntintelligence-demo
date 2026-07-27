/**
 * ============================================================
 * auth.js — Tier 1 Google Sign-In gate
 * Fundigo — AI-Powered Grant Intelligence for Nonprofits
 * Version: 1.0 | July 2026
 *
 * WHAT THIS FILE DOES:
 * Gates the app behind "Sign in with Google" using Google
 * Identity Services (GIS) — free, no third-party vendor beyond
 * Google itself, no billing account required.
 *
 * WHAT THIS FILE DOES NOT DO (by design, Tier 1 scope):
 * - Does NOT verify the token server-side (there is no server).
 *   The ID token is decoded client-side purely to display the
 *   signed-in person's name/email/photo. This is an access gate,
 *   not a security boundary — do not rely on it to protect
 *   sensitive data.
 * - Does NOT sync data across devices. Tracker/profile/memory
 *   still live in localStorage exactly as before. Signing in on
 *   a different device/browser starts with empty local data.
 *   (That's Tier 2 — needs a backend.)
 * - Does NOT restrict sign-in to nonprofit-verified accounts.
 *   Any Google account (personal or Workspace) can sign in.
 *
 * SETUP REQUIRED BEFORE THIS WORKS:
 * 1. Go to https://console.cloud.google.com/ → create a project
 *    (free, no billing account needed for this use case).
 * 2. APIs & Services → OAuth consent screen → configure
 *    (External, app name "Fundigo", your support email).
 * 3. APIs & Services → Credentials → Create Credentials →
 *    OAuth client ID → Application type: Web application.
 * 4. Under "Authorized JavaScript origins" add your Netlify URL,
 *    e.g. https://fundigograntdiscovery.netlify.app
 *    (and http://localhost:8888 or similar for local testing).
 * 5. Copy the generated Client ID and paste it into
 *    AUTH_CONFIG.clientId below, replacing the placeholder.
 *
 * DEPENDENCIES:
 * - Google Identity Services script must be loaded in <head>:
 *   <script src="https://accounts.google.com/gsi/client" async defer></script>
 * ============================================================
 */

const AUTH_CONFIG = {
  // ⚠️ REPLACE THIS — see setup steps above.
  clientId: "604500199210-obblscfvreo3lecbu8tugvkjlreo34cf.apps.googleusercontent.com",
  storageKey: "fundigo_auth_user",
  tokenKey: "fundigo_auth_token", // sessionStorage — raw ID token
  guestKey: "fundigo_guest_session", // sessionStorage — "1" while continuing as guest
};

let _authOnSignedIn = null; // callback set by enterApp()
window._isGuest = false; // true when the user chose "Continue as guest"

/**
 * Decode a JWT payload without any external library.
 * Only used to read display fields (name/email/picture) —
 * never treated as a verified/trusted security claim.
 * @param {string} token
 * @returns {Object|null}
 */
function decodeJwtPayload(token) {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonStr);
  } catch (e) {
    console.warn("Could not decode ID token:", e);
    return null;
  }
}

/**
 * Called by Google Identity Services after a successful sign-in.
 * Stores a lightweight profile in localStorage and hands off
 * to whatever the app registered via requireSignIn().
 * @param {Object} response  { credential: <JWT string> }
 */
function handleCredentialResponse(response) {
  const payload = decodeJwtPayload(response.credential);
  if (!payload) {
    showToast && showToast("Sign-in failed to decode. Try again.");
    return;
  }
  window._isGuest = false; // real sign-in — clear any leftover guest state
  try { sessionStorage.removeItem(AUTH_CONFIG.guestKey); } catch (e) {}

  const user = {
    name: payload.name || payload.email,
    email: payload.email,
    picture: payload.picture || "",
    signedInAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(AUTH_CONFIG.storageKey, JSON.stringify(user));
    // ID token itself lives in sessionStorage only — it's short-lived
    // (~1hr) and only needed to authenticate calls to org-data.js.
    sessionStorage.setItem(AUTH_CONFIG.tokenKey, response.credential);
  } catch (e) {
    console.warn("Could not persist auth session:", e);
  }

  hideAuthGate();
  renderAuthHeader(user);
  if (typeof _authOnSignedIn === "function") _authOnSignedIn(user);
}

/**
 * @returns {Object|null} the signed-in user, or null if none.
 */
function getSignedInUser() {
  try {
    const raw = localStorage.getItem(AUTH_CONFIG.storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/**
 * @returns {string|null} the raw Google ID token for this session,
 *   used by org-storage.js to authenticate calls to org-data.js.
 *   Null if not signed in or the token has aged out of sessionStorage.
 */
function getIdToken() {
  try {
    return sessionStorage.getItem(AUTH_CONFIG.tokenKey);
  } catch (e) {
    return null;
  }
}

// ============================================================
// SHEETS ACCESS TOKEN (separate consent from basic sign-in)
// ============================================================
// The ID token above proves WHO someone is. Reading/writing their
// org's Google Sheet needs a second, different kind of token — an
// OAuth access token scoped to Sheets — which Google issues via a
// separate consent screen. This is unavoidable: Google does not
// bundle "prove your identity" and "let this app edit your Sheets"
// into one grant, by design (least-privilege).
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets " +
                      "https://www.googleapis.com/auth/drive.file";

let _sheetsTokenClient = null;
let _sheetsAccessToken = null; // kept in memory only, never persisted
let _sheetsTokenExpiresAt = 0;

/**
 * Request (or silently reuse) an OAuth access token scoped to
 * Google Sheets. Shows a one-time consent popup the first time;
 * Google will often renew silently after that while the tab is open.
 * @returns {Promise<string>} the access token
 */
function requestSheetsAccessToken() {
  return new Promise((resolve, reject) => {
    if (_sheetsAccessToken && Date.now() < _sheetsTokenExpiresAt - 30000) {
      resolve(_sheetsAccessToken);
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      reject(new Error("Google OAuth client not loaded yet — try again in a moment."));
      return;
    }
    if (!_sheetsTokenClient) {
      _sheetsTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: AUTH_CONFIG.clientId,
        scope: SHEETS_SCOPE,
        callback: (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          _sheetsAccessToken = resp.access_token;
          _sheetsTokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
          resolve(_sheetsAccessToken);
        },
      });
    }
    _sheetsTokenClient.requestAccessToken({ prompt: "" }); // "" = silent if already granted
  });
}

/**
 * Sign out: clear the local session and Google's auto-select,
 * then return to the landing page.
 */
function signOut() {
  try {
    localStorage.removeItem(AUTH_CONFIG.storageKey);
    sessionStorage.removeItem(AUTH_CONFIG.tokenKey);
    sessionStorage.removeItem(AUTH_CONFIG.guestKey);
  } catch (e) {}
  window._isGuest = false;
  try {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
  } catch (e) {}
  document.body.classList.remove("in-app");
  window._appInited = false;
  hideAuthGate();
  const headerSlot = document.getElementById("auth-header-slot");
  if (headerSlot) headerSlot.innerHTML = "";
}

/**
 * Render the signed-in user's avatar/name + sign-out link
 * into the app header.
 * @param {Object} user
 */
function renderAuthHeader(user) {
  const slot = document.getElementById("auth-header-slot");
  if (!slot) return;
  const initials = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  slot.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      ${
        user.picture
          ? `<img src="${user.picture}" alt="" referrerpolicy="no-referrer"
               style="width:26px;height:26px;border-radius:50%;object-fit:cover;">`
          : `<div style="width:26px;height:26px;border-radius:50%;background:var(--c-purple,#7B2FBE);
               color:#fff;display:flex;align-items:center;justify-content:center;
               font-size:11px;font-weight:700;">${initials}</div>`
      }
      <div style="line-height:1.2;">
        <div style="font-size:11px;font-weight:600;color:var(--c-text,#1F2937);">${user.name}</div>
        <a href="#" onclick="signOut();return false;"
           style="font-size:10px;color:var(--c-muted,#6B7280);text-decoration:none;">Sign out</a>
      </div>
    </div>
    <div id="org-sharing-note" style="font-size:9.5px;color:var(--c-muted,#9CA3AF);margin-top:2px;text-align:right;"></div>`;

  renderOrgSharingNote(user);
}

/**
 * Small trust-building note: tells staff whether their data is
 * being shared with teammates on the same domain, or kept private
 * (public email providers like gmail.com never auto-share).
 * @param {Object} user
 */
function renderOrgSharingNote(user) {
  const note = document.getElementById("org-sharing-note");
  if (!note) return;
  if (!user) return; // guest mode — renderGuestHeader() already set its own note
  const domain = (user.email || "").split("@")[1] || "";
  const info = window._fundigoOrgInfo;
  if (info && info.isSharedOrg) {
    note.textContent = `Shared with your @${domain} team`;
  } else if (info && !info.isSharedOrg) {
    note.textContent = `Private to your account`;
  } else {
    note.textContent = ""; // not yet loaded from backend, or offline/guest
  }
}

/**
 * Show the full-screen sign-in gate overlay.
 */
function showAuthGate() {
  const gate = document.getElementById("auth-gate");
  if (gate) gate.style.display = "flex";
  renderGoogleButton();
}

/**
 * Hide the sign-in gate overlay.
 */
function hideAuthGate() {
  const gate = document.getElementById("auth-gate");
  if (gate) gate.style.display = "none";
}

/**
 * Render the actual Google Sign-In button into the gate.
 * Safe to call multiple times — GIS handles re-render.
 */
function renderGoogleButton() {
  const container = document.getElementById("google-signin-btn");
  if (!container || !window.google || !google.accounts || !google.accounts.id) return;

  if (AUTH_CONFIG.clientId.startsWith("YOUR_GOOGLE_CLIENT_ID")) {
    container.innerHTML = `<div style="font-size:12px;color:#B91C1C;max-width:280px;text-align:center;">
      Sign-in isn't configured yet — add a real Google OAuth Client ID
      in auth.js (AUTH_CONFIG.clientId) to enable this button.
    </div>`;
    return;
  }

  google.accounts.id.initialize({
    client_id: AUTH_CONFIG.clientId,
    callback: handleCredentialResponse,
    auto_select: true,
  });

  google.accounts.id.renderButton(container, {
    theme: "outline",
    size: "large",
    text: "signin_with",
    shape: "pill",
    logo_alignment: "left",
  });

  // Also offer the One Tap prompt for returning users.
  try { google.accounts.id.prompt(); } catch (e) {}
}

/**
 * Entry point called instead of jumping straight into the app.
 * If already signed in, proceeds immediately. If a guest session
 * is already active (chosen earlier in this tab), proceeds as guest.
 * Otherwise shows the gate and waits for a choice.
 * @param {Function} onSignedIn  called once a user (or guest) is available
 */
function requireSignIn(onSignedIn) {
  _authOnSignedIn = onSignedIn;
  const user = getSignedInUser();
  const token = getIdToken();
  if (user && token) {
    renderAuthHeader(user);
    onSignedIn(user);
    return;
  }
  try {
    if (sessionStorage.getItem(AUTH_CONFIG.guestKey) === "1") {
      window._isGuest = true;
      renderGuestHeader();
      onSignedIn(null);
      return;
    }
  } catch (e) {}
  // Cached display profile exists but the token expired/was cleared
  // (e.g. tab was closed) — re-show the gate. Google's One Tap will
  // often re-auth this silently since the browser still has a session.
  showAuthGate();
}

/**
 * Continue without a Google account. Search, discovery, and the
 * tracker all still work — everything just reads/writes localStorage
 * in this browser instead of the org's shared Google Sheet. Persists
 * for the rest of this tab session, so switching tabs or navigating
 * back to the landing page and re-entering doesn't re-prompt.
 */
function continueAsGuest() {
  window._isGuest = true;
  try { sessionStorage.setItem(AUTH_CONFIG.guestKey, "1"); } catch (e) {}
  hideAuthGate();
  renderGuestHeader();
  if (typeof _authOnSignedIn === "function") _authOnSignedIn(null);
}

/**
 * Render the header for guest mode: no avatar, a "Sign in" link
 * so they can upgrade to a synced account at any point without
 * losing anything already in localStorage.
 */
function renderGuestHeader() {
  const slot = document.getElementById("auth-header-slot");
  if (!slot) return;
  slot.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="width:26px;height:26px;border-radius:50%;background:rgba(36,28,20,.1);
           color:#241C14;display:flex;align-items:center;justify-content:center;
           font-size:11px;font-weight:700;">G</div>
      <div style="line-height:1.2;">
        <div style="font-size:11px;font-weight:600;color:var(--c-text,#1F2937);">Guest</div>
        <a href="#" onclick="showAuthGate();return false;"
           style="font-size:10px;color:var(--c-muted,#6B7280);text-decoration:none;">Sign in</a>
      </div>
    </div>
    <div style="font-size:9.5px;color:var(--c-muted,#9CA3AF);margin-top:2px;text-align:right;">Saved to this browser only</div>`;
}
