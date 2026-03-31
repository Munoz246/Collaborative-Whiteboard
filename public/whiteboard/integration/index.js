/**
 * Integrated whiteboard entry point (loaded as a module from index.html).
 *
 * Finds the canvas and toolbar DOM nodes, constructs WhiteboardModule with those references,
 * then wires OverlayManager so HUD buttons can open/close side panels. If anything fails
 * during startup, the user sees an alert so missing markup is obvious.
 *
 * Auth is handled by mountAuthUI() in auth.js — the app only initializes once
 * Firebase confirms a signed-in user.
 */
import { saveOpenAiKey, askAI, addMessage } from "../ai.js";
import { WhiteboardModule } from "../WhiteboardModule.js";
import { OverlayManager } from "../overlays/OverlayManager.js";
import { BaseOverlayPanel } from "../overlays/BaseOverlayPanel.js";
import { currentUser, mountAuthUI } from "../auth.js";
import { refreshWhiteboardList } from "../renderer.js";
import { createWhiteboard } from "../firestore.js";

// =============================================================================
// Startup — connect DOM to whiteboard + overlays
// =============================================================================

/**
 * Starts up the application (called after the user signs in).
 * 
 * @param {import('firebase/auth').User} user User that's currently signed in
 */
function initIntegratedApp(user) {
  // Get and display list of joined whiteboards
  refreshWhiteboardList();

  // Initialize whiteboard
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

  // Each overlay is a panel root id from index.html; keys must match data-overlay-target values.
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

  // AI assistant UI bindings
  const askBtn = document.getElementById("askAiBtn");
  const promptInput = document.getElementById("aiPromptInput");
  const apiKeyInput = document.getElementById("apiKeyInput");

  let activeWhiteboardId = null;

  // Track selected board
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-board-id]");
    if (link) {
      activeWhiteboardId = link.dataset.boardId;
    }
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

      const boardState = whiteboard?.store?.serialize?.() || {};

      const res = await askAI({
        whiteboardId: activeWhiteboardId,
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

// =============================================================================
// UI event implementations
// =============================================================================

/**
 * Shows the whiteboard creation form, and handles all button events within it
 */
function onNewBoardClick() {
  const newBoardForm = document.getElementById("newBoardForm");
  const newBoardName = /** @type {HTMLInputElement} */ (document.getElementById("newBoardName"));
  const cancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("cancelNewBoardBtn"));
  const user = currentUser();

  // Show whiteboard creation form
  newBoardForm.hidden = false;
  newBoardName.focus();

  // Hide form when canceled
  cancelBtn.addEventListener("click", () => {
    newBoardForm.hidden = true;
    newBoardName.value = "";
  });

  // Create whiteboard in the database, refresh the whiteboard list, and hide
  // the creation form
  newBoardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = /** @type {HTMLButtonElement} */ (newBoardForm.querySelector('button[type="submit"]'));
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await createWhiteboard(user.uid, newBoardName.value.trim());
      await refreshWhiteboardList();
      newBoardForm.hidden = true;
      newBoardName.value = "";
    } finally {
      submitBtn.disabled = false;
      cancelBtn.disabled = true;
    }
  });
}

// =============================================================================
// Startup — mount auth UI; app init runs once sign-in is confirmed
// =============================================================================

try {
  mountAuthUI({ onSignedIn: initIntegratedApp });
} catch (err) {
  console.error(err);
  alert("Failed to initialize integrated whiteboard: " + err.message);
}