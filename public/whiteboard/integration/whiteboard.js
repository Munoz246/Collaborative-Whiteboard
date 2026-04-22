/**
 * Integrated whiteboard entry (loaded from whiteboard.html).
 *
 * Requires URL query `board=<whiteboardId>`; otherwise redirects to index.html (dashboard).
 * Auth via mountAuthUI(); canvas initializes after sign-in.
 */
import { saveOpenAiKey, askAI, addMessage } from "../ai.js";
import { WhiteboardModule } from "../WhiteboardModule.js";
import { OverlayManager } from "../overlays/OverlayManager.js";
import { BaseOverlayPanel } from "../overlays/BaseOverlayPanel.js";
import { currentUser, mountAuthUI } from "../auth.js";
import { refreshWhiteboardList } from "../renderer.js";
import { createWhiteboard, getJoinedWhiteboards, getWhiteboardById, requestToJoinWhiteboard, addUserToWhiteboard } from "../firestore.js";
import { initNotifications } from "../notifications.js";
import { createItem, deleteItem, subscribeToItems, updateItem } from "../itemSyncService.js";
import { mountGroupChatPanel } from "../groupChatPanel.js";

let activeWhiteboard = null;

/**
 * Initializes the whole whiteboard page.
 * 
 * @param {import('firebase/auth').User} user Currently signed in user
 * @param {string} boardID ID of the whiteboard the user is accessing
 */
async function initPage(user, boardID) {
  let meta;
  try {
    meta = await getWhiteboardById(boardID);
    if (!meta) throw Error("Could not load whiteboard");
  } catch (err) {
    console.error(err);
    window.location.replace("index.html");
    return;
  }

  // If user isn't a member, show join requests modal
  if (!meta.members.includes(user.uid)) {
    showJoinRequestModal(meta);
    return;
  }

  const titleEl = document.getElementById("boardTitle");
  if (titleEl) titleEl.textContent = meta.name;
  
  getJoinedWhiteboards().then(boards => {
    refreshWhiteboardList(boards);
    initNotifications(boards);
  });

  const whiteboard = initWhiteboard();
  activeWhiteboard = whiteboard;
  attachRealtimeItemSync(whiteboard, boardID, user.uid);

  mountGroupChatPanel({
    boardId: boardID,
    user,
    meta,
    registerDisposer: (fn) => whiteboard.registerDisposer(fn),
  });

  initOverlayPanels(boardID, user, meta);
}

function attachRealtimeItemSync(whiteboard, boardID, userId) {
  if (typeof whiteboard.__realtimeSyncDispose === "function") {
    whiteboard.__realtimeSyncDispose();
    whiteboard.__realtimeSyncDispose = null;
  }
  let isApplyingRemote = false;

  const unsubscribeRemote = subscribeToItems(boardID, {
    onAdded: (item) => {
      isApplyingRemote = true;
      try {
        whiteboard.store.upsertRemoteElement(item);
        const synced = whiteboard.store.getElement(item.id);
        if (synced) whiteboard.renderer.upsertFromStoreElement(synced);
      } finally {
        isApplyingRemote = false;
      }
    },
    onModified: (item) => {
      if (item?.updatedBy === userId) {
        return;
      }
      isApplyingRemote = true;
      try {
        whiteboard.store.upsertRemoteElement(item);
        const synced = whiteboard.store.getElement(item.id);
        if (synced) whiteboard.renderer.upsertFromStoreElement(synced);
      } finally {
        isApplyingRemote = false;
      }
    },
    onRemoved: (itemId) => {
      isApplyingRemote = true;
      try {
        whiteboard.store.removeRemoteElement(itemId);
        whiteboard.renderer.removeByElementId(itemId);
      } finally {
        isApplyingRemote = false;
      }
    },
    onError: (err) => console.error("Firestore realtime sync failed:", err),
  });

  const unsubscribeStore = whiteboard.store.subscribe(async (event) => {
    if (isApplyingRemote || event.origin === "remote" || !event.persist) return;

    try {
      if (event.kind === "added") {
        await createItem(boardID, event.element, userId);
      } else if (event.kind === "updated") {
        await updateItem(boardID, event.elementId, event.previous, event.element, userId);
      } else if (event.kind === "removed") {
        await deleteItem(boardID, event.elementId);
      } else if (event.kind === "cleared") {
        await Promise.all((event.elementIds || []).map((id) => deleteItem(boardID, id)));
      }
    } catch (err) {
      console.error("Failed to sync whiteboard item change:", err);
    }
  });

  const dispose = () => {
    unsubscribeRemote?.();
    unsubscribeStore?.();
  };
  whiteboard.__realtimeSyncDispose = dispose;
  whiteboard.registerDisposer(dispose);
  window.addEventListener("beforeunload", dispose, { once: true });
}

/**
 * Shows the "Request to Join" modal for a board the user can't access.
 * Wires up the confirm button to call requestToJoinWhiteboard.
 *
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }} boardInfo
 */
function showJoinRequestModal(boardInfo) {
  const modal = document.getElementById("joinRequestModal");
  const confirmBtn = document.getElementById("joinRequestConfirmBtn");
  const cancelBtn = document.getElementById("joinRequestCancelBtn");
  const statusEl = document.getElementById("joinRequestStatus");
  const titleEl = document.getElementById("joinRequestTitle");

  if (!modal) return;

  modal.removeAttribute("hidden");

  titleEl.textContent = boardInfo.name;

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    statusEl.textContent = "Sending request…";
    try {
      await requestToJoinWhiteboard(boardInfo.id);
      statusEl.textContent = "Request sent!";
      confirmBtn.hidden = true;
      cancelBtn.textContent = "Back to dashboard";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Failed to send request. Please try again.";
      confirmBtn.disabled = false;
    }
  }, { once: true });

  cancelBtn.addEventListener("click", () => {
    window.location.replace("index.html");
  }, { once: true });
}

/**
 * Initializes WhiteboardModule class and binds UI elements.
 *
 * @returns {WhiteboardModule}
 */
function initWhiteboard() {
  const canvasEl = /** @type {HTMLCanvasElement} */ (document.getElementById("whiteboardCanvas"));
  if (!canvasEl) throw new Error("Missing canvas element #whiteboardCanvas");

  const whiteboard = new WhiteboardModule({
    canvasEl,
    ui: {
      toolSelectBtn: document.getElementById("toolSelectBtn"),
      toolShapeBtn: document.getElementById("toolShapeBtn"),
      toolPenBtn: document.getElementById("toolPenBtn"),
      toolTextBtn: document.getElementById("toolTextBtn"),
      shapeRectBtn: document.getElementById("shapeRectBtn"),
      shapeCircleBtn: document.getElementById("shapeCircleBtn"),
      shapeSubtoolbarEl: document.getElementById("shapeSubtoolbar"),
      clearCanvasBtn: document.getElementById("clearCanvasBtn"),
    },
  });

  whiteboard.init();

  return whiteboard;
}

/**
 * Binds overlay panels (like whiteboard list, ai chat, etc) to UI elements, and
 * defines interaction logic.
 *
 * @param {string} boardID Whiteboard ID
 * @param {import('firebase/auth').User} user Currently signed in user
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }} meta Whiteboard metadata
 */
function initOverlayPanels(boardID, user, meta) {
  const overlays = new OverlayManager({
    toolbar: new BaseOverlayPanel("whiteboardToolbarOverlay", true),
    boards: new BaseOverlayPanel("boardNavigationOverlay", false),
    groupChat: new BaseOverlayPanel("groupChatOverlay", false),
    aiChat: new BaseOverlayPanel("aiChatOverlay", false),
    fileManager: new BaseOverlayPanel("fileManagerOverlay", false),
  });
  overlays.mount();

  // Bind "create whiteboard" button
  document.getElementById('newBoardBtn').addEventListener('click', onNewBoardClick);

  initAIPanel(boardID);
  initSharePanel(boardID, user, meta);
}

/**
 * Handles interaction logic for the AI panel.
 * 
 * @param {string} boardID Whiteboard ID
 */
function initAIPanel(boardID) {
  // AI assistant UI bindings
  const askBtn = document.getElementById("askAiBtn");
  const promptInput = document.getElementById("aiPromptInput");
  const apiKeyInput = document.getElementById("apiKeyInput");

  const dropZone = document.getElementById("aiDropZone");
  const fileInput = document.getElementById("aiFileInput");
  const fileListEl = document.getElementById("aiFileList");

  let attachedFiles = [];

  askBtn.addEventListener("click", async () => {
    const prompt = promptInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!prompt) return;

    askBtn.disabled = true;

    try {
      // Save key if entered
      if (apiKey) {
        await saveOpenAiKey(apiKey);
        apiKeyInput.value = "";
        apiKeyInput.placeholder = "API key saved";
      }

      addMessage("user", prompt);
      promptInput.value = "";

      const boardState = activeWhiteboard?.store?.serialize?.() || {};

      const fileContents = await Promise.all(
        attachedFiles.map(async (file) => ({
          name: file.name,
          type: file.type || "text/plain",
          text: await file.text()
        }))
      );
      //debugging to verify file contents before sending to askAI
      console.log("FILES BEING SENT:", fileContents);

      const res = await askAI({
        whiteboardId: boardID,
        prompt,
        boardState,
        files: fileContents
      });

      addMessage("assistant", res.answer);

      attachedFiles = [];
      renderAttachedFiles();

    } catch (err) {
      addMessage("assistant", "Error: " + err.message);
    }

    askBtn.disabled = false;
  });
  //file stuff for ai
  function renderAttachedFiles() {
    if (!fileListEl) return;
    fileListEl.innerHTML = "";

    for (const file of attachedFiles) {
      const chip = document.createElement("div");
      chip.className = "ai-file-chip";
      chip.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KB)`;
      fileListEl.appendChild(chip);
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    attachedFiles.push(...files);
    renderAttachedFiles();
  }
  //click support for file input
  if (dropZone && fileInput) {
    dropZone.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      handleFiles(e.target.files);
      fileInput.value = "";
    });
  }

  //drag & drop support for files
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      handleFiles(e.dataTransfer.files);
    });
  }

}

/**
 * Wires up the share modal: copy link, QR code generation, and add-member form.
 *
 * @param {string} boardID
 * @param {import('firebase/auth').User} user Currently signed in user
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }} meta Whiteboard metadata
 */
function initSharePanel(boardID, user, meta) {
  const modal = document.getElementById("shareModal");
  const openBtn = document.getElementById("shareBtn");
  const closeBtn = document.getElementById("shareModalCloseBtn");
  const linkInput = /** @type {HTMLInputElement} */ (document.getElementById("shareLinkInput"));
  const copyBtn = document.getElementById("shareCopyBtn");
  const addUserSection = document.getElementById("shareAddUserSection");
  const addUserInput = /** @type {HTMLInputElement} */ (document.getElementById("shareAddUserInput"));
  const addUserBtn = document.getElementById("shareAddUserBtn");
  const addUserStatus = document.getElementById("shareAddUserStatus");

  const shareUrl = `${location.origin}${location.pathname}?board=${encodeURIComponent(boardID)}`;
  linkInput.value = shareUrl;

  const isPrivileged = meta.owner === user.uid || (meta.mods ?? []).includes(user.uid);
  if (addUserSection) addUserSection.hidden = !isPrivileged;

  let qrGenerated = false;

  openBtn.addEventListener("click", () => {
    modal.removeAttribute("hidden");
    if (!qrGenerated) {
      qrGenerated = true;
      const container = document.getElementById("shareQrContainer");
      // @ts-ignore — QRCode loaded via CDN script tag
      new QRCode(container, { text: shareUrl, width: 180, height: 180 });
    }
  });

  closeBtn.addEventListener("click", () => modal.setAttribute("hidden", ""));

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.setAttribute("hidden", "");
  });

  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(shareUrl);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });

  addUserBtn.addEventListener("click", async () => {
    const uid = addUserInput.value.trim();
    if (!uid) return;
    addUserBtn.disabled = true;
    addUserStatus.textContent = "Adding…";
    try {
      await addUserToWhiteboard(boardID, uid);
      addUserStatus.textContent = "User added!";
      addUserInput.value = "";
    } catch (err) {
      console.error(err);
      addUserStatus.textContent = "Failed: " + err.message;
    } finally {
      addUserBtn.disabled = false;
    }
  });
}

/**
 * Shows whiteboard creation UI and defines whiteboard creation logic.
 */
function onNewBoardClick() {
  const newBoardForm = document.getElementById("newBoardForm");
  const newBoardName = /** @type {HTMLInputElement} */ (document.getElementById("newBoardName"));
  const cancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("cancelNewBoardBtn"));
  const user = currentUser();
  if (!newBoardForm || !newBoardName || !cancelBtn || !user) return;

  newBoardForm.hidden = false;
  newBoardName.focus();

  cancelBtn.addEventListener(
    "click",
    () => {
      newBoardForm.hidden = true;
      newBoardName.value = "";
    },
    { once: true },
  );

  newBoardForm.addEventListener(
    "submit",
    async (e) => {
      e.preventDefault();
      const submitBtn = /** @type {HTMLButtonElement} */ (newBoardForm.querySelector('button[type="submit"]'));
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        const id = await createWhiteboard(user.uid, newBoardName.value.trim());
        window.location.href = `whiteboard.html?board=${encodeURIComponent(id)}`;
      } finally {
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    },
    { once: true },
  );
}

/**
 * Entrypoint for whiteboard.html
 * 
 * Ensures a board id is provided and the user is signed in, then initializes
 * the page.
 */
const boardParams = new URLSearchParams(window.location.search);
const activeBoardId = boardParams.get("board")?.trim();
if (!activeBoardId) {
  window.location.replace("index.html");
} else {
  try {
    mountAuthUI({ onSignedIn: (user) => {
      initPage(user, activeBoardId);
    } });
  } catch (err) {
    console.error(err);
    alert("Failed to initialize integrated whiteboard: " + err.message);
  }
}
