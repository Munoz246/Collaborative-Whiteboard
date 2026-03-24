/**
 * Firebase Auth helpers (Google sign-in) and auth UI wiring.
 *
 * Relies on firebase-app-compat and firebase-auth-compat being loaded via CDN
 * before this module is imported, so window.firebase is available.
 *
 * mountAuthUI() owns the login screen and profile button — call it once at startup
 * with a callback that receives the signed-in user and initializes the app.
 */

window.firebase.initializeApp({
  apiKey:            "AIzaSyDLfw_BLPm6pxTIYCKAPn66zy4GplL_5Dw",
  authDomain:        "collaborative-whiteboard-c486.firebaseapp.com",
  projectId:         "collaborative-whiteboard-c486",
  storageBucket:     "collaborative-whiteboard-c486.firebasestorage.app",
  messagingSenderId: "794925840469",
  appId:             "1:794925840469:web:1e477a65a9c20857c93cdc",
});

const auth = window.firebase.auth();
const googleProvider = new window.firebase.auth.GoogleAuthProvider();

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
 * @param {(user: firebase.User | null) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(callback) {
  return auth.onAuthStateChanged(callback);
}

/** Returns the currently signed-in user, or null. */
export function currentUser() {
  return auth.currentUser;
}

// =============================================================================
// Auth UI — login screen + profile button
// =============================================================================

/**
 * Wires the login screen and profile button to Firebase auth state.
 *
 * @param {{ onSignedIn: (user: firebase.User) => void }} options
 *   onSignedIn is called once the first time a user is confirmed authenticated.
 */
export function mountAuthUI({ onSignedIn }) {
  const loginScreen  = document.getElementById("loginScreen");
  const googleBtn    = document.getElementById("googleSignInBtn");
  const loginError   = document.getElementById("loginError");
  const profileBtn   = document.getElementById("profileBtn");
  const profilePhoto = document.getElementById("profilePhoto");
  const profileIcon  = document.getElementById("profileIcon");

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

  let appInitialised = false;

  onAuthChange((user) => {
    if (user) {
      // Hide login screen
      loginScreen.classList.add("is-hidden");

      // Show user photo in profile button
      if (user.photoURL) {
        profilePhoto.src = user.photoURL;
        profilePhoto.alt = user.displayName ?? "Profile photo";
        profilePhoto.hidden = false;
        profileIcon.style.display = "none";
      }
      profileBtn.title = `Signed in as ${user.displayName ?? user.email} — click to sign out`;
      profileBtn.setAttribute("aria-label", "Sign out");

      if (!appInitialised) {
        appInitialised = true;
        onSignedIn(user);
      }
    } else {
      // Reload if the app was already running so in-memory state is cleared cleanly
      if (appInitialised) {
        window.location.reload();
        return;
      }

      loginScreen.classList.remove("is-hidden");

      // Reset profile button to default state
      profilePhoto.hidden = true;
      profilePhoto.src = "";
      profileIcon.style.display = "";
      profileBtn.title = "Sign in";
      profileBtn.setAttribute("aria-label", "Sign in");
    }
  });
}
