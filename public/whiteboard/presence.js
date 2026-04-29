const db = window.firebase.firestore();
const HEARTBEAT_MS = 30_000;
export const ONLINE_THRESHOLD_MS = 90_000;

/**
 * Stamps lastSeen on the user's member doc and refreshes it on a 30-second
 * heartbeat. The existing subscribeToMembers listener picks up the change, so
 * no separate subscription is needed to show online status.
 *
 * Returns a stop function that clears lastSeen and should be registered as a
 * disposer so it runs when the user leaves the board.
 *
 * @param {string} boardId
 * @param {string} uid
 * @returns {() => void} stop
 */
export function startPresence(boardId, uid) {
  const ref = db.collection("whiteboards").doc(boardId).collection("members").doc(uid);

  const update = () =>
    ref.update({ lastSeen: window.firebase.firestore.FieldValue.serverTimestamp() });

  update();
  const interval = setInterval(update, HEARTBEAT_MS);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    ref.update({ lastSeen: window.firebase.firestore.FieldValue.delete() }).catch(() => {});
  };

  window.addEventListener("beforeunload", stop, { once: true });
  return stop;
}
