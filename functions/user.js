const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

const db = () => admin.firestore();

async function requireAuth(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    throw new Error("Missing auth token.");
  }
  return admin.auth().verifyIdToken(match[1]);
}

/**
 * Ensures a username is in a valid form: all lower case, alpha-numeric with
 * underscores, between 3 and 20 characters in length.
 * 
 * @param {string} username Input username.
 * @returns {boolean} True if the username is valid.
 */
function validUsername(username) {
  return /^[a-z0-9_]{3,20}$/.test(username);
}

// POST { username } — Called when a user first signs up. Sets a username, and
// creates the users/{uid} document.
exports.initializeUser = onRequest(async (req, res) => {
  try {
    // Ensure protocol
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }

    // Ensure user is signed in and username is valid
    const user = await requireAuth(req);
    const username = String(req.body?.username || "").trim().toLowerCase();

    if (!username) throw new Error("Missing username");
    if (!validUsername(username)) throw new Error("Username must be 3-20 characters: letters, numbers, underscores only");

    console.log("Validated params");
    
    // Apply changes
    const usernameRef = db().doc(`usernames/${username}`);
    const userRef = db().doc(`users/${user.uid}`);

    await db().runTransaction(async (tx) => {
      const [usernameSnap, userSnap] = await Promise.all([
        tx.get(usernameRef),
        tx.get(userRef),
      ]);

      // Ensure username isn't taken and user is uninitialized
      if (usernameSnap.exists) throw new Error("Username already taken");
      if (userSnap.exists) throw new Error("User has already been initialized");

      // Create documents
      tx.set(usernameRef, { userID: user.uid });
      tx.set(userRef, {
        username,
        joinedWhiteboards: [],
        photoURL: user.picture || null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    console.log("Completed");

    res.json({ ok: true, username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST { username } — claim a username for the first time or update it.
// Writes users/{uid} and usernames/{username}, deletes the old usernames entry.
exports.setUsername = onRequest(async (req, res) => {
  try {
    // Ensure protocol
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }

    const user = await requireAuth(req);
    const username = String(req.body?.username || "").trim().toLowerCase();

    if (!username) throw new Error("Missing username");
    if (!validUsername(username)) throw new Error("Username must be 3–20 characters: letters, numbers, underscores only");

    const usernameRef = db().doc(`usernames/${username}`);
    const userRef = db().doc(`users/${user.uid}`);

    await db().runTransaction(async (tx) => {
      const [usernameSnap, userSnap] = await Promise.all([
        tx.get(usernameRef),
        tx.get(userRef),
      ]);

      if (usernameSnap.exists) {
        throw new Error("Username already taken");
      }

      // Remove old username
      const previousUsername = userSnap.exists ? userSnap.data().username : null;
      if (previousUsername && previousUsername !== username) {
        tx.delete(db().doc(`usernames/${previousUsername}`));
      }

      // Update documents
      tx.set(usernameRef, { userID: user.uid });
      tx.set(
        userRef,
        {
          username,
          photoURL: user.picture || null, // Update photo (in case it changed)
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    res.json({ ok: true, username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST { username } — check if a username is available without claiming it.
exports.checkUsername = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }

    await requireAuth(req);
    const username = String(req.body?.username || "").trim().toLowerCase();

    if (!username) throw new Error("Missing username");
    
    if (!validUsername(username)) {
      res.json({ available: false, reason: "Invalid format" });
      return;
    }

    const snap = await db().doc(`usernames/${username}`).get();
    res.json({ available: !snap.exists });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET — return the current user's profile from Firestore.
exports.getProfile = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "GET only" });
      return;
    }

    const user = await requireAuth(req);
    const snap = await db().doc(`users/${user.uid}`).get();

    if (!snap.exists) {
      res.json({ profile: null });
      return;
    }

    const { username, displayName, email, photoURL } = snap.data();
    res.json({ profile: { username, displayName, email, photoURL } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
