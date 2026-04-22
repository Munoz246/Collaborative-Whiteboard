/**
 * Group chat HUD: DOM rendering, optimistic send, pagination, and errors.
 * All Firestore I/O goes through `groupChatService.js` (this file stays UI-only).
 */

import { currentUser } from "./auth.js";
import {
  CHAT_PAGE_SIZE,
  RECENT_CHAT_LIMIT,
  fetchOlderGroupChatMessages,
  hideGroupChatMessage,
  editGroupChatMessage,
  newGroupChatMessageId,
  sanitizeChatMessageText,
  sendGroupChatMessage,
  subscribeToRecentGroupChat,
} from "./groupChatService.js";

/**
 * Milliseconds for ordering: server time, or local fallback while `createdAt` is still null.
 * @param {{ createdAt?: { toMillis?: () => number } | null, _localOrder?: number }} msg
 */
function sortTimeMs(msg) {
  const c = msg.createdAt;
  if (c && typeof c.toMillis === "function") return c.toMillis();
  if (typeof msg._localOrder === "number") return msg._localOrder;
  return Number.MAX_SAFE_INTEGER - 1;
}

/**
 * @param {string} boardId
 * @param {import('firebase/auth').User} user
 * @param {{ owner: string, mods?: string[] }} meta
 * @param {() => void} registerDisposer same pattern as whiteboard item sync teardown
 */
export function mountGroupChatPanel({ boardId, user, meta, registerDisposer }) {
  const listEl = document.getElementById("chatList");
  const statusEl = document.getElementById("chatStatus");
  const retryBtn = document.getElementById("chatRetryBtn");
  const loadOlderBtn = document.getElementById("chatLoadOlderBtn");
  const inputEl = /** @type {HTMLInputElement | null} */ (document.getElementById("chatInput"));
  const sendBtn = document.getElementById("sendChatBtn");
  const overlayEl = document.getElementById("groupChatOverlay");

  if (!listEl || !inputEl || !sendBtn || !statusEl) {
    console.warn("Group chat: missing DOM nodes; panel disabled.");
    return () => {};
  }

  const mods = meta.mods ?? [];
  const isPrivileged = meta.owner === user.uid || mods.includes(user.uid);

  /** @type {Map<string, object>} merged server + optimistic rows */
  const messages = new Map();
  /** @type {Map<string, HTMLLIElement>} */
  const rowEls = new Map();

  /** Oldest doc in the “recent” listener window (desc query tail). */
  let listenerOldestDoc = null;
  /**
   * Cursor for `startAfter` when loading older pages. `null` means “next page uses `listenerOldestDoc`”.
   * After each successful batch, set to that batch’s oldest snapshot.
   */
  let olderPageCursor = null;
  /** True when every message in Firestore is already represented locally (short snapshot or pagination end). */
  let olderHistoryFullyLoaded = false;
  let loadOlderFailed = false;
  let unsubChat = null;
  let disposed = false;

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("chat-status--error", !!isError);
    if (retryBtn) retryBtn.hidden = !isError;
  }

  function sortedIds() {
    return [...messages.keys()].sort((a, b) => {
      const ta = sortTimeMs(messages.get(a));
      const tb = sortTimeMs(messages.get(b));
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  }

  function renderRowContent(li, msg) {
    // Row can outlive the map entry (e.g. another client hid the message while this user was editing).
    if (!msg) {
      const id = li?.dataset?.messageId;
      if (id) removeMessageLocal(id);
      else li?.remove();
      return;
    }
    const mine = msg.senderId === user.uid;
    const hidden = !!msg.hidden;
    li.className = "chat-row hud-chat-row" + (mine ? " chat-row--mine" : "");
    li.dataset.messageId = msg.id;

    const metaLine = document.createElement("div");
    metaLine.className = "chat-row__meta";
    const who = document.createElement("span");
    who.className = "chat-row__who";
    who.textContent = mine ? "You" : msg.senderDisplayName || msg.senderId;
    const when = document.createElement("span");
    when.className = "chat-row__when";
    if (msg.createdAt && typeof msg.createdAt.toDate === "function") {
      when.textContent = msg.createdAt.toDate().toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (msg._pending) {
      when.textContent = "Sending…";
    } else {
      when.textContent = "";
    }
    metaLine.append(who, when);

    const body = document.createElement("div");
    body.className = "chat-row__body hud-chat-bubble";
    if (hidden) {
      body.classList.add("chat-row__body--removed");
      body.textContent = "Message removed";
    } else {
      body.textContent = msg.message || "";
    }
    if (msg.edited && !hidden) {
      const ed = document.createElement("span");
      ed.className = "chat-row__edited";
      ed.textContent = " (edited)";
      body.appendChild(ed);
    }

    li.replaceChildren(metaLine, body);

    const actions = document.createElement("div");
    actions.className = "chat-row__actions";
    if (!hidden && !msg._pending) {
      if (mine) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "chat-row__action-btn";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => beginEdit(msg.id, li));
        const hideBtn = document.createElement("button");
        hideBtn.type = "button";
        hideBtn.className = "chat-row__action-btn";
        hideBtn.textContent = "Remove";
        hideBtn.addEventListener("click", () => retractOwn(msg.id));
        actions.append(editBtn, hideBtn);
      } else if (isPrivileged) {
        const modHide = document.createElement("button");
        modHide.type = "button";
        modHide.className = "chat-row__action-btn";
        modHide.textContent = "Hide";
        modHide.addEventListener("click", () => hideAsModerator(msg));
        actions.append(modHide);
      }
    }
    if (actions.childElementCount) li.appendChild(actions);
  }

  function upsertDom(msg) {
    let li = rowEls.get(msg.id);
    if (!li) {
      li = document.createElement("li");
      rowEls.set(msg.id, li);
    }
    renderRowContent(li, msg);
    return li;
  }

  function reorderList() {
    const frag = document.createDocumentFragment();
    for (const id of sortedIds()) {
      const li = rowEls.get(id);
      if (li) frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    listEl.scrollTop = listEl.scrollHeight;
  }

  function mergeMessage(serverMsg, { preservePending } = {}) {
    const prev = messages.get(serverMsg.id) || {};
    const next = { ...serverMsg };
    if (preservePending && prev._pending && !serverMsg.createdAt) {
      next._pending = true;
      next._localOrder = prev._localOrder;
    }
    messages.set(serverMsg.id, next);
    upsertDom(next);
    reorderList();
  }

  function removeMessageLocal(id) {
    messages.delete(id);
    const li = rowEls.get(id);
    if (li) {
      li.remove();
      rowEls.delete(id);
    }
  }

  async function retractOwn(messageId) {
    const u = currentUser();
    if (!u) return;
    setStatus("");
    try {
      await hideGroupChatMessage(boardId, messageId, u.uid, { privileged: false });
    } catch (e) {
      setStatus(e?.message || "Could not remove message.", true);
    }
  }

  async function hideAsModerator(msg) {
    const u = currentUser();
    if (!u) return;
    setStatus("");
    try {
      const privileged = isPrivileged && msg.senderId !== u.uid;
      await hideGroupChatMessage(boardId, msg.id, u.uid, { privileged });
    } catch (e) {
      setStatus(e?.message || "Could not hide message.", true);
    }
  }

  function beginEdit(messageId, li) {
    const msg = messages.get(messageId);
    if (!msg || msg.hidden) return;
    const body = li.querySelector(".chat-row__body");
    if (!body) return;
    const ta = document.createElement("textarea");
    ta.className = "form-control hud-input chat-row__edit-input";
    ta.rows = 2;
    ta.value = msg.message;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-sm btn-dark mt-1";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-sm btn-secondary mt-1 ms-1";
    cancel.textContent = "Cancel";
    const wrap = document.createElement("div");
    wrap.append(ta, save, cancel);
    body.replaceChildren(wrap);
    save.addEventListener("click", async () => {
      setStatus("");
      try {
        const text = sanitizeChatMessageText(ta.value);
        if (!text) {
          setStatus("Message cannot be empty.", true);
          const still = messages.get(messageId);
          if (still) renderRowContent(li, still);
          else removeMessageLocal(messageId);
          return;
        }
        await editGroupChatMessage(boardId, messageId, text);
        const cur = messages.get(messageId);
        if (cur) {
          messages.set(messageId, { ...cur, message: text, edited: true });
        }
      } catch (e) {
        setStatus(e?.message || "Could not save edit.", true);
      }
      const afterSave = messages.get(messageId);
      if (afterSave) renderRowContent(li, afterSave);
      else removeMessageLocal(messageId);
    });
    cancel.addEventListener("click", () => {
      const afterCancel = messages.get(messageId);
      if (afterCancel) renderRowContent(li, afterCancel);
      else removeMessageLocal(messageId);
    });
  }

  async function tryLoadOlder() {
    if (!loadOlderBtn) return;
    const cursor = olderPageCursor ?? listenerOldestDoc;
    if (!cursor || !cursor.exists) {
      olderHistoryFullyLoaded = true;
      loadOlderBtn.hidden = true;
      loadOlderBtn.disabled = false;
      loadOlderBtn.textContent = "Load older messages";
      setStatus("");
      return;
    }
    loadOlderBtn.hidden = false;
    loadOlderBtn.disabled = true;
    setStatus("Loading older…", false);
    try {
      const { messages: batch, oldestSnapshot } = await fetchOlderGroupChatMessages(boardId, cursor, CHAT_PAGE_SIZE);
      loadOlderFailed = false;
      for (const m of batch) {
        if (!messages.has(m.id)) {
          messages.set(m.id, m);
          upsertDom(m);
        }
      }
      olderPageCursor = oldestSnapshot;
      reorderList();
      if (batch.length === 0 || batch.length < CHAT_PAGE_SIZE || !oldestSnapshot) {
        olderHistoryFullyLoaded = true;
        loadOlderBtn.hidden = true;
        loadOlderBtn.disabled = false;
        loadOlderBtn.textContent = "Load older messages";
      } else {
        loadOlderBtn.hidden = false;
        loadOlderBtn.disabled = false;
        loadOlderBtn.textContent = "Load older messages";
      }
      setStatus("");
    } catch (e) {
      loadOlderFailed = true;
      setStatus(e?.message || "Could not load older messages.", true);
      loadOlderBtn.hidden = false;
      loadOlderBtn.disabled = false;
    }
  }

  async function sendFromInput() {
    const u = currentUser();
    if (!u) return;
    const raw = inputEl.value;
    let text;
    try {
      text = sanitizeChatMessageText(raw);
    } catch (e) {
      setStatus(e?.message || "Invalid message.", true);
      return;
    }
    if (!text) return;

    const displayName = u.displayName || u.email || "Member";
    const messageId = newGroupChatMessageId(boardId);
    const optimistic = {
      id: messageId,
      senderId: u.uid,
      senderDisplayName: displayName,
      message: text,
      createdAt: null,
      updatedAt: null,
      edited: false,
      hidden: false,
      hiddenBy: null,
      _pending: true,
      _localOrder: Date.now(),
    };
    messages.set(messageId, optimistic);
    upsertDom(optimistic);
    reorderList();
    inputEl.value = "";
    sendBtn.disabled = true;
    setStatus("");

    try {
      await sendGroupChatMessage(boardId, {
        uid: u.uid,
        displayName,
        text,
        messageId,
      });
    } catch (e) {
      removeMessageLocal(messageId);
      reorderList();
      setStatus(e?.message || "Message could not be sent. Check your connection and try again.", true);
    } finally {
      sendBtn.disabled = false;
    }
  }

  unsubChat = subscribeToRecentGroupChat(boardId, {
    onAdded: (msg) => mergeMessage(msg, { preservePending: !!messages.get(msg.id)?._pending }),
    onModified: (msg) => mergeMessage(msg, { preservePending: false }),
    /**
     * With `limit(N)`, Firestore emits `removed` when a row slides out of the window — not a delete.
     * Hard deletes are disallowed by rules, so we ignore `removed` here to avoid wiping valid history.
     */
    onRemoved: () => {},
    onError: (err) => {
      console.error("Group chat listener:", err);
      setStatus("Live chat disconnected. Try refreshing the page.", true);
    },
    onBatchComplete: (snapshot) => {
      listenerOldestDoc = snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null;
      if (snapshot.docs.length < RECENT_CHAT_LIMIT) {
        olderHistoryFullyLoaded = true;
      }
      if (loadOlderBtn) {
        const canLoadOlder = !olderHistoryFullyLoaded && listenerOldestDoc;
        loadOlderBtn.hidden = !canLoadOlder;
        loadOlderBtn.disabled = false;
        loadOlderBtn.textContent = "Load older messages";
      }
    },
  });

  const onInputKeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendFromInput();
    }
  };

  sendBtn.addEventListener("click", sendFromInput);
  inputEl.addEventListener("keydown", onInputKeydown);

  const onLoadOlderClick = () => tryLoadOlder();
  const onRetryClick = () => {
    if (loadOlderFailed) tryLoadOlder();
    else setStatus("");
  };

  if (loadOlderBtn) {
    loadOlderBtn.addEventListener("click", onLoadOlderClick);
  }
  if (retryBtn) {
    retryBtn.addEventListener("click", onRetryClick);
  }

  let overlayObserver = null;
  if (overlayEl) {
    overlayObserver = new MutationObserver(() => {
      const open = overlayEl.classList.contains("is-open");
      if (open) scrollChatToBottom();
    });
    overlayObserver.observe(overlayEl, { attributes: true, attributeFilter: ["class"] });
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubChat?.();
    unsubChat = null;
    overlayObserver?.disconnect();
    overlayObserver = null;
    sendBtn.removeEventListener("click", sendFromInput);
    inputEl.removeEventListener("keydown", onInputKeydown);
    if (loadOlderBtn) loadOlderBtn.removeEventListener("click", onLoadOlderClick);
    if (retryBtn) retryBtn.removeEventListener("click", onRetryClick);
  };
  registerDisposer(dispose);
  window.addEventListener("beforeunload", dispose, { once: true });

  return dispose;
}
