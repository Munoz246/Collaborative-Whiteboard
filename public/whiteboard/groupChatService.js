/**
 * Firestore access for per-whiteboard group chat (`whiteboards/{boardId}/group-chat`).
 *
 * Why a separate module: keeps UI code free of query details and matches `itemSyncService.js`.
 * Security rules (not this file) are the real gate; we still trim/length-check here to avoid
 * useless writes and give fast client-side feedback.
 */

const db = window.firebase.firestore();
const { FieldValue } = window.firebase.firestore;

/** Max characters after trim (keep in sync with firestore.rules). */
export const CHAT_MESSAGE_MAX_LENGTH = 4000;

/** Default page size for “load older” batches. */
export const CHAT_PAGE_SIZE = 40;

/** How many newest messages the realtime listener tracks at once. */
export const RECENT_CHAT_LIMIT = 60;

export function chatCollection(boardId) {
  return db.collection("whiteboards").doc(boardId).collection("group-chat");
}

/** Allocate a Firestore id before `setDoc` so optimistic UI can use the same id the listener will return. */
export function newGroupChatMessageId(boardId) {
  return chatCollection(boardId).doc().id;
}

/**
 * Trim and validate user input. Returns null if nothing should be stored (empty / whitespace-only).
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function sanitizeChatMessageText(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\u0000/g, "");
  if (!trimmed) return null;
  if (trimmed.length > CHAT_MESSAGE_MAX_LENGTH) {
    throw new Error(`Message is too long (max ${CHAT_MESSAGE_MAX_LENGTH} characters).`);
  }
  return trimmed;
}

/**
 * @param {import('firebase/firestore').DocumentSnapshot} doc
 * @returns {GroupChatMessage | null}
 */
export function messageFromDoc(doc) {
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    id: doc.id,
    senderId: d.senderId,
    senderDisplayName: typeof d.senderDisplayName === "string" ? d.senderDisplayName : "",
    message: typeof d.message === "string" ? d.message : "",
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
    edited: !!d.edited,
    hidden: !!d.hidden,
    hiddenBy: typeof d.hiddenBy === "string" ? d.hiddenBy : null,
  };
}

/**
 * Subscribe to the N most recent messages (by `createdAt`), newest first in the query;
 * callbacks receive normalized messages suitable for merging into a local Map by `id`.
 *
 * `docChanges()` tells us exactly what changed so the UI can patch rows instead of refetching
 * the full history on every tick (see `groupChatPanel.js`).
 *
 * @param {string} boardId
 * @param {object} opts
 * @param {number} [opts.limit]
 * @param {(msg: GroupChatMessage) => void} [opts.onAdded]
 * @param {(msg: GroupChatMessage) => void} [opts.onModified]
 * @param {(messageId: string) => void} [opts.onRemoved]
 * @param {(err: Error) => void} [opts.onError]
 * @param {(snapshot: import('firebase/firestore').QuerySnapshot) => void} [opts.onBatchComplete] includes full snapshot so the UI can keep the oldest doc for pagination cursors
 * @returns {() => void} unsubscribe
 */
export function subscribeToRecentGroupChat(boardId, opts = {}) {
  const lim = opts.limit ?? RECENT_CHAT_LIMIT;
  const q = chatCollection(boardId).orderBy("createdAt", "desc").limit(lim);

  return q.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        const msg = messageFromDoc(change.doc);
        if (!msg) continue;
        if (change.type === "added") opts.onAdded?.(msg);
        else if (change.type === "modified") opts.onModified?.(msg);
        else if (change.type === "removed") opts.onRemoved?.(change.doc.id);
      }
      opts.onBatchComplete?.(snapshot);
    },
    (err) => opts.onError?.(err),
  );
}

/**
 * Send a new message. Uses a client-generated document id + `setDoc` so:
 * - the optimistic UI row id matches the eventual Firestore id before `createdAt` resolves;
 * - ordering stays stable once the server timestamp is written.
 *
 * @param {string} boardId
 * @param {{ uid: string, displayName: string, text: string, messageId?: string }} author optional `messageId` for optimistic UI (must be a new unused id)
 * @returns {Promise<{ messageId: string }>}
 */
export async function sendGroupChatMessage(boardId, author) {
  const message = sanitizeChatMessageText(author.text);
  if (!message) throw new Error("Message is empty.");

  const col = chatCollection(boardId);
  const messageId = author.messageId || col.doc().id;
  const ref = col.doc(messageId);
  const now = FieldValue.serverTimestamp();

  await ref.set({
    senderId: author.uid,
    senderDisplayName: author.displayName || "Member",
    message,
    createdAt: now,
    updatedAt: now,
    edited: false,
    hidden: false,
  });

  return { messageId };
}

/**
 * Edit own message text (members only; rules enforce sender).
 *
 * @param {string} boardId
 * @param {string} messageId
 * @param {string} nextText
 */
export async function editGroupChatMessage(boardId, messageId, nextText) {
  const message = sanitizeChatMessageText(nextText);
  if (!message) throw new Error("Message is empty.");

  await chatCollection(boardId)
    .doc(messageId)
    .update({
      message,
      edited: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/**
 * Soft-hide a message (moderation or author retract). Rules decide who may hide whom.
 *
 * @param {string} boardId
 * @param {string} messageId
 * @param {string} actorUid authenticated user performing the hide
 * @param {{ privileged: boolean }} opts privileged = owner/mod hiding someone else’s message (sets hiddenBy)
 */
export async function hideGroupChatMessage(boardId, messageId, actorUid, opts) {
  if (!actorUid) throw new Error("Not signed in.");

  const patch = {
    hidden: true,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (opts.privileged) {
    patch.hiddenBy = actorUid;
  }

  await chatCollection(boardId).doc(messageId).update(patch);
}

/**
 * Load the next older batch (descending `createdAt`). Pass the Firestore `DocumentSnapshot`
 * returned as `cursorDoc` from the previous batch (oldest doc in the prior page along this query).
 *
 * Overlap with the live listener window is OK: the UI dedupes by message id.
 *
 * @param {string} boardId
 * @param {import('firebase/firestore').DocumentSnapshot} cursorDoc start after this document (the current oldest loaded along the desc query)
 * @param {number} [pageSize]
 * @returns {Promise<{ messages: GroupChatMessage[], oldestSnapshot: import('firebase/firestore').DocumentSnapshot | null }>}
 */
export async function fetchOlderGroupChatMessages(boardId, cursorDoc, pageSize = CHAT_PAGE_SIZE) {
  if (!cursorDoc.exists) {
    return { messages: [], oldestSnapshot: null };
  }
  const snap = await chatCollection(boardId)
    .orderBy("createdAt", "desc")
    .startAfter(cursorDoc)
    .limit(pageSize)
    .get();
  const messages = [];
  /** @type {import('firebase/firestore').DocumentSnapshot | null} */
  let oldestSnapshot = null;

  snap.docs.forEach((doc, i) => {
    const m = messageFromDoc(doc);
    if (m) messages.push(m);
    if (i === snap.docs.length - 1) oldestSnapshot = doc;
  });

  return { messages, oldestSnapshot };
}

/**
 * @typedef {object} GroupChatMessage
 * @property {string} id
 * @property {string} senderId
 * @property {string} senderDisplayName
 * @property {string} message
 * @property {object | null} createdAt Firestore Timestamp or null while server time is pending
 * @property {object | null} updatedAt
 * @property {boolean} edited
 * @property {boolean} hidden
 * @property {string | null} hiddenBy
 */
