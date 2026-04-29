import { buildItemPatch, fromFirestoreItem, toFirestoreItem } from "./itemModel.js?v=shape-style-v3";

const db = window.firebase.firestore();
const { FieldValue } = window.firebase.firestore;

function itemCollection(boardId) {
  return db.collection("whiteboards").doc(boardId).collection("items");
}

/**
 * Subscribe to realtime item changes for a whiteboard.
 * Returns unsubscribe function.
 */
export function subscribeToItems(boardId, callbacks = {}) {
  return itemCollection(boardId).onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        const localItem = fromFirestoreItem(change.doc);
        if (!localItem) continue;

        if (change.type === "added") callbacks.onAdded?.(localItem);
        if (change.type === "modified") callbacks.onModified?.(localItem);
        if (change.type === "removed") callbacks.onRemoved?.(localItem.id);
      }
      callbacks.onBatchComplete?.();
    },
    (error) => callbacks.onError?.(error),
  );
}

export async function createItem(boardId, item, userId) {
  const payload = toFirestoreItem(item, userId, FieldValue.serverTimestamp());
  await itemCollection(boardId).doc(item.id).set(payload, { merge: true });
}

export async function updateItem(boardId, itemId, previousItem, nextItem, userId) {
  const itemRef = itemCollection(boardId).doc(itemId);
  const latest = await itemRef.get();
  if (!latest.exists) {
    await createItem(boardId, nextItem, userId);
    return;
  }

  const latestLocal = fromFirestoreItem(latest);
  if (latestLocal?.isLocked && latestLocal.updatedBy && latestLocal.updatedBy !== userId) {
    // First-pass lock policy: locked items can only be changed by the locker.
    return;
  }

  const patch = buildItemPatch(previousItem, nextItem, userId, FieldValue.serverTimestamp());
  if (!patch) return;
  await itemRef.update(patch);
}

export async function deleteItem(boardId, itemId) {
  await itemCollection(boardId).doc(itemId).delete();
}
