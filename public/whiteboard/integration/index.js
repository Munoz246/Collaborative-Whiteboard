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
import { WhiteboardModule } from "../WhiteboardModule.js";
import { OverlayManager } from "../overlays/OverlayManager.js";
import { BaseOverlayPanel } from "../overlays/BaseOverlayPanel.js";
import { mountAuthUI } from "../auth.js";

// =============================================================================
// Startup — connect DOM to whiteboard + overlays
// =============================================================================

function initIntegratedApp() {
  const canvasEl = document.getElementById("whiteboardCanvas");
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
