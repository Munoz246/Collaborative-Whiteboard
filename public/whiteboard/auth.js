/**
 * Firebase Auth helpers (Google sign-in) and auth UI wiring.
 *
 * Relies on firebase-app-compat and firebase-auth-compat being loaded via CDN
 * before this module is imported, so window.firebase is available.
 *
 * mountAuthUI() owns the login screen and profile button — call it once at startup
 * with a callback that receives the signed-in user and initializes the app.
 */

import { getUserProfile } from "./firestore.js";

const auth = window.firebase.auth();
const googleProvider = new window.firebase.auth.GoogleAuthProvider();

async function callPost(path, body) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 1000)}`);
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function promptUsername() {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)";
    root.innerHTML = `
      <div class="dashboard-modal-card hud-glass" role="dialog" aria-modal="true" aria-labelledby="_usTitle" style="max-width:360px;width:90%">
        <h2 id="_usTitle" class="dashboard-modal-title">Welcome! Choose a username</h2>
        <p class="dashboard-modal-desc">This is how you'll appear to other users.</p>
        <label class="dashboard-modal-label" for="_usInput">Username</label>
        <input id="_usInput" class="dashboard-modal-input" type="text" maxlength="20" placeholder="e.g. cool_user42" autocomplete="off" spellcheck="false" />
        <p id="_usError" class="dashboard-modal-error" aria-live="polite"></p>
        <div class="dashboard-modal-actions">
          <button type="button" class="dashboard-modal-btn dashboard-modal-btn--primary" id="_usSubmit">Continue</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const input = root.querySelector("#_usInput");
    const error = root.querySelector("#_usError");
    const submit = root.querySelector("#_usSubmit");

    input.focus();

    async function attempt() {
      const username = input.value.trim().toLowerCase();
      error.textContent = "";

      submit.disabled = true;
      try {
        await callPost("/api/initializeUser", { username });
        document.body.removeChild(root);
        resolve();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
        input.focus();
      }
    }

    submit.addEventListener("click", attempt);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  });
}

// =============================================================================
// Core auth API
// =============================================================================

/** Opens the Google sign-in popup. Returns a Promise<UserCredential>. */
export function signIn() {
  return auth.signInWithPopup(googleProvider);
}

/** Signs the current user out. Returns a Promise<void>. */
export function signOut() {
  return auth.signOut();
}

/**
 * Subscribes to auth state changes.
 * @param {(user: import('firebase/auth').User) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(callback) {
  return auth.onAuthStateChanged(callback);
}

/**
 * Returns the currently signed-in user, or null if the user isn't signed in.
 *
 * @returns {import('firebase/auth').User | null}
 */
export function currentUser() {
  return auth.currentUser;
}

// =============================================================================
// Auth UI — login screen + profile button
// =============================================================================

/**
 * Wires the login screen and profile button to Firebase auth state.
 *
 * @param {{ onSignedIn: (user: import('firebase/auth').User) => void }} options
 *   onSignedIn is called once the first time a user is confirmed authenticated.
 */
export function mountAuthUI({ onSignedIn }) {
  const loginScreen  = document.getElementById("loginScreen");
  const googleBtn    = document.getElementById("googleSignInBtn");
  const loginError   = document.getElementById("loginError");
  const profileBtn   = document.getElementById("profileBtn");
  const profilePhoto = /** @type {HTMLImageElement} */ (document.getElementById("profilePhoto"));
  const profileIcon  = document.getElementById("profileIcon");

  if (loginScreen) {
    loginScreen.classList.add("is-hidden");
    loginScreen.setAttribute("aria-hidden", "true");
  }

  // Sign-in button
  googleBtn.addEventListener("click", async () => {
    loginError.textContent = "";
    try {
      await signIn();
    } catch (err) {
      loginError.textContent = "Sign-in failed. Please try again.";
      console.error(err);
    }
  });

  // Profile button — signs out when user is already signed in
  profileBtn.addEventListener("click", () => {
    if (!profilePhoto.hidden) {
      signOut().catch(console.error);
    }
  });

  let appInitialized = false;

  function bindAuthListener() {
    onAuthChange(async (user) => {
      if (user) {
        // Hide login screen
        loginScreen.classList.add("is-hidden");
        loginScreen.setAttribute("aria-hidden", "true");

        // Show user photo in profile button
        if (user.photoURL) {
          profilePhoto.src = user.photoURL;
          profilePhoto.alt = user.displayName ?? "Profile photo";
          profilePhoto.hidden = false;
          profileIcon.style.display = "none";
        }
        profileBtn.title = `Signed in as ${user.displayName ?? user.email} — click to sign out`;
        profileBtn.setAttribute("aria-label", "Sign out");

        if (!appInitialized) {
          appInitialized = true;
          const profile = await getUserProfile(user.uid);
          if (!profile) await promptUsername();
          onSignedIn(user);
        }
      } else {
        // Reload if the app was already running so in-memory state is cleared cleanly
        if (appInitialized) {
          window.location.reload();
          return;
        }

        if (auth.currentUser) {
          return;
        }

        loginScreen.classList.remove("is-hidden");
        loginScreen.setAttribute("aria-hidden", "false");

        // Reset profile button to default state
        profilePhoto.hidden = true;
        profilePhoto.src = "";
        profileIcon.style.display = "";
        profileBtn.title = "Sign in";
        profileBtn.setAttribute("aria-label", "Sign in");
      }
    });
  }

  if (typeof auth.authStateReady === "function") {
    void auth.authStateReady().then(bindAuthListener);
  } else {
    bindAuthListener();
  }
}
