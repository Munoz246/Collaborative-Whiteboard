/**
 * Integrated whiteboard entry (loaded from whiteboard.html).
 *
 * Requires URL query `board=<whiteboardId>`; otherwise redirects to index.html (dashboard).
 * Auth via mountAuthUI(); canvas initializes after sign-in.
 */
import { saveOpenAiKey, askAI, addMessage, getAiHistory } from "../ai.js";
import { WhiteboardModule } from "../WhiteboardModule.js?v=shape-style-v3";
import { OverlayManager } from "../overlays/OverlayManager.js";
import { BaseOverlayPanel } from "../overlays/BaseOverlayPanel.js";
import { currentUser, mountAuthUI } from "../auth.js";
import { refreshWhiteboardList } from "../renderer.js";
import { createWhiteboard, getJoinedWhiteboards, getWhiteboardById, subscribeToWhiteboard, requestToJoinWhiteboard, addUserToWhiteboard } from "../firestore.js";
import { initNotifications } from "../notifications.js";
import { createItem, deleteItem, subscribeToItems, updateItem } from "../itemSyncService.js?v=shape-style-v3";
import { mountGroupChatPanel } from "../groupChatPanel.js";
import { startPresence } from "../presence.js";
import { showToast } from "../utils.js";
import { toggleBoardSettingsMenu } from "../boardSettingsMenu.js";
import {
  subscribeToWhiteboardFiles,
  uploadWhiteboardFiles,
  getWhiteboardFileDownloadUrl,
  deleteWhiteboardFile,
} from "../fileManager.js";
import { createWhiteboardFileItem, isViewableFile } from "../fileItemService.js?v=shape-style-v3";
import { FileViewerLayer } from "../fileViewerLayer.js?v=shape-style-v3";

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

  whiteboard.registerDisposer(startPresence(boardID, user.uid));

  const getRole = (board) =>
    board.owner === user.uid ? "owner" : (board.mods ?? []).includes(user.uid) ? "mod" : "member";

  const ROLE_MESSAGES = {
    "member->mod":    "You have been promoted to moderator.",
    "mod->member":    "You have been demoted to member.",
    "mod->owner":     "You are now the owner of this board.",
    "member->owner":  "You are now the owner of this board.",
    "owner->mod":     "Ownership transferred. You are now a moderator.",
    "owner->member":  "Ownership transferred. You are now a member.",
  };

  let prevRole = getRole(meta);

  whiteboard.registerDisposer(subscribeToWhiteboard(boardID, {
    onUpdate: (board) => {
      if (!board.members.includes(user.uid)) {
        window.location.replace("index.html");
        return;
      }

      const nextRole = getRole(board);
      if (nextRole !== prevRole) {
        const msg = ROLE_MESSAGES[`${prevRole}->${nextRole}`];
        if (msg) showToast(msg);
        prevRole = nextRole;
      }

      if (titleEl) titleEl.textContent = board.name;
    },
  }));

  mountGroupChatPanel({
    boardId: boardID,
    user,
    meta,
    registerDisposer: (fn) => whiteboard.registerDisposer(fn),
  });

  initOverlayPanels(boardID, user, meta);
  initTitleSettingsMenu(user, meta);
}

/**
 * Wires the settings caret next to the whiteboard title. Opens the shared
 * settings menu anchored to the caret, with canvas access for the Export PNG
 * option.
 *
 * @param {import('firebase/auth').User} user
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }} meta
 */
function initTitleSettingsMenu(user, meta) {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("boardTitleSettingsBtn"));
  const titleEl = document.getElementById("boardTitle");
  if (!btn) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleBoardSettingsMenu({
      anchorEl: btn,
      board: meta,
      userId: user.uid,
      canvas: activeWhiteboard?.canvas ?? null,
      onRenamed: (newName) => {
        if (titleEl) titleEl.textContent = newName;
        getJoinedWhiteboards().then(refreshWhiteboardList).catch(console.error);
      },
      onRemoved: () => {
        window.location.replace("index.html");
      },
    });
  });
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

  const ui = {
    toolSelectBtn: document.getElementById("toolSelectBtn"),
    toolShapeBtn: document.getElementById("toolShapeBtn"),
    toolPenBtn: document.getElementById("toolPenBtn"),
    toolTextBtn: document.getElementById("toolTextBtn"),
    shapeRectBtn: document.getElementById("shapeRectBtn"),
    shapeCircleBtn: document.getElementById("shapeCircleBtn"),
    shapeTriangleBtn: document.getElementById("shapeTriangleBtn"),
    shapeRhombusBtn: document.getElementById("shapeRhombusBtn"),
    shapeSubtoolbarEl: document.getElementById("shapeSubtoolbar"),
    shapeStyleControlsEl: document.getElementById("shapeStyleControls"),
    shapeFillColorInput: document.getElementById("shapeFillColorInput"),
    shapeStrokeColorInput: document.getElementById("shapeStrokeColorInput"),
    shapeStrokeWidthInput: document.getElementById("shapeStrokeWidthInput"),
    shapeStrokeWidthValue: document.getElementById("shapeStrokeWidthValue"),
    clearCanvasBtn: document.getElementById("clearCanvasBtn"),
  };

  const whiteboard = new WhiteboardModule({
    canvasEl,
    ui,
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
  initFileManager(boardID, user, activeWhiteboard);
  initSharePanel(boardID, user, meta);
  initFileViewerLayer(activeWhiteboard);
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

  getAiHistory(boardID)
    .then((data) => {
      const container = document.getElementById("aiMessages");

      if (!container) return;

      container.innerHTML = "";

      for (const msg of data.messages || []) {
        if (msg.userPrompt) {
          addMessage("user", msg.userPrompt);
        }
        if (msg.assistantReply) {
          addMessage("assistant", msg.assistantReply);
        }
      }
    })
    .catch((err) => {
      console.error("Failed to load AI history:", err);
    });
    console.log("Loading AI history for board:", boardID);

    getAiHistory(boardID)
      .then((data) => {
        console.log("AI history loaded:", data);

        const container = document.getElementById("aiMessages");
        if (!container) return;

        container.innerHTML = "";

        for (const msg of data.messages || []) {
          if (msg.userPrompt) addMessage("user", msg.userPrompt);
          if (msg.assistantReply) addMessage("assistant", msg.assistantReply);
        }
      })
      .catch((err) => {
        console.error("Failed to load AI history:", err);
      });

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

function initFileViewerLayer(whiteboard) {
  if (!whiteboard?.store) return;
  const host = document.getElementById("whiteboardFileViewerLayer");
  if (!host) return;
  const layer = new FileViewerLayer({
    rootEl: host,
    store: whiteboard.store,
    canvas: whiteboard.canvas,
  });
  layer.attach();
  whiteboard.registerDisposer(() => layer.detach());
}

function initFileManager(boardID, user, whiteboard) {
  const uploadBtn = document.getElementById("uploadWhiteboardFileBtn");
  const fileInput = document.getElementById("whiteboardFileInput");
  const fileList = document.getElementById("whiteboardFileList");
  const statusEl = document.getElementById("fileManagerStatus");

  if (!uploadBtn || !fileInput || !fileList) return;

  // open file picker
  uploadBtn.addEventListener("click", () => {
    fileInput.click();
  });

  // handle upload
  fileInput.addEventListener("change", async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    uploadBtn.disabled = true;
    if (statusEl) statusEl.textContent = "Uploading…";

    try {
      await uploadWhiteboardFiles(boardID, files);
      if (statusEl) statusEl.textContent = "Upload complete.";
      fileInput.value = "";
    } catch (err) {
      console.error(err);
      if (statusEl) statusEl.textContent = err.message;
    } finally {
      uploadBtn.disabled = false;
    }
  });

  // listen for file changes (realtime)
  subscribeToWhiteboardFiles(
    boardID,
    (files) => {
      fileList.innerHTML = "";

      if (!files.length) {
        const empty = document.createElement("li");
        empty.className = "text-muted small";
        empty.textContent = "No files uploaded yet.";
        fileList.appendChild(empty);
        return;
      }

      for (const file of files) {
        const item = document.createElement("li");
        item.className = "file-manager-row";

        const info = document.createElement("div");
        info.className = "file-manager-info";

        const name = document.createElement("div");
        name.className = "file-manager-name";
        name.textContent = file.name || "Untitled file";

        const meta = document.createElement("div");
        meta.className = "file-manager-meta";
        meta.textContent = `${Math.ceil((file.size || 0) / 1024)} KB`;

        info.append(name, meta);

        const actions = document.createElement("div");
        actions.className = "file-manager-row-actions";

        // download
        const downloadBtn = document.createElement("button");
        downloadBtn.type = "button";
        downloadBtn.className = "btn btn-sm btn-outline-dark";
        downloadBtn.textContent = "Download";
        downloadBtn.addEventListener("click", async () => {
          const url = await getWhiteboardFileDownloadUrl(file.storagePath);
          window.open(url, "_blank", "noopener");
        });

        const viewBtn = document.createElement("button");
        viewBtn.type = "button";
        viewBtn.className = "btn btn-sm btn-outline-primary";
        viewBtn.textContent = "View";
        if (!isViewableFile(file)) {
          viewBtn.disabled = true;
          viewBtn.title = "Only PDF and text files can be viewed on the canvas.";
        }
        viewBtn.addEventListener("click", async () => {
          if (!whiteboard?.store || !user?.uid) return;
          try {
            await createWhiteboardFileItem({
              boardId: boardID,
              userId: user.uid,
              store: whiteboard.store,
              canvas: whiteboard.canvas,
              fileDoc: file,
            });
            if (statusEl) statusEl.textContent = "Added file viewer to whiteboard.";
          } catch (err) {
            console.error(err);
            if (statusEl) statusEl.textContent = err.message || "Could not place file on whiteboard.";
          }
        });

        // delete
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn btn-sm btn-outline-danger";
        deleteBtn.textContent = "Remove";
        deleteBtn.addEventListener("click", async () => {
          if (!confirm(`Remove ${file.name}?`)) return;
          await deleteWhiteboardFile(boardID, file.id, file.storagePath);
        });

        actions.append(viewBtn, downloadBtn, deleteBtn);
        item.append(info, actions);
        fileList.appendChild(item);
      }
    },
    (err) => {
      console.error("File manager subscription failed:", err);
      if (statusEl) statusEl.textContent = "Could not load files.";
    }
  );
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
