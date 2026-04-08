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
import { createWhiteboard, getJoinedWhiteboards, getWhiteboardById, requestToJoinWhiteboard } from "../firestore.js";
import { initNotifications } from "../notifications.js";

/**
 * Initializes the whole whiteboard page.
 * 
 * @param {import('firebase/auth').User} user Currently signed in user
 * @param {string} boardID ID of the whiteboard the user is accessing
 */
async function initPage(user, boardID) {
  let meta;
  try {
    meta = await getWhiteboardById(activeBoardId);
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

  initOverlayPanels(boardID);
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
 */
function initOverlayPanels(boardID) {
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

      const boardState = whiteboard?.store?.serialize?.() || {};

      const res = await askAI({
        whiteboardId: boardID,
        prompt,
        boardState
      });

      addMessage("assistant", res.answer);

    } catch (err) {
      addMessage("assistant", "Error: " + err.message);
    }

    askBtn.disabled = false;
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
