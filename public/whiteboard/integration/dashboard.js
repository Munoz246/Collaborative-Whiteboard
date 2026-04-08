/**
 * Dashboard entry: after sign-in, loads whiteboards and navigates to whiteboard.html?board=<id>.
 */

import { mountAuthUI, currentUser } from "../auth.js";
import { getJoinedWhiteboards, createWhiteboard, addUserToWhiteboard, requestToJoinWhiteboard } from "../firestore.js";

/**
 * Shows a temporary toast message at the bottom of the screen.
 *
 * @param {string} message
 */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'dashboard-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger fade-in on next frame
  requestAnimationFrame(() => toast.classList.add('dashboard-toast--visible'));

  setTimeout(() => {
    toast.classList.remove('dashboard-toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3000);
}

/** @param {{ id: string, name: string }} board */
function boardWorkspaceHref(board) {
  return `whiteboard.html?board=${encodeURIComponent(board.id)}`;
}

/**
 * Populates the list of joined whiteboards with the provided information.
 * 
 * @param {{ id: string, name: string }[]} boards List of whiteboards
 */
function renderBoardList(boards) {
  const emptyEl = document.getElementById("dashboardEmptyState");
  const mount = document.getElementById("dashboardBoardsMount");
  if (!emptyEl || !mount) return;

  mount.innerHTML = "";

  if (boards.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;

  for (const board of boards) {
    const link = document.createElement("a");
    link.className = "dashboard-board-card dashboard-board-card-link";
    link.href = boardWorkspaceHref(board);
    link.setAttribute("aria-label", `Open whiteboard ${board.name}`);

    const thumb = document.createElement("div");
    thumb.className = "dashboard-board-thumb";
    thumb.setAttribute("aria-hidden", "true");

    const title = document.createElement("h2");
    title.className = "dashboard-board-title";
    title.textContent = board.name;

    const spacer = document.createElement("span");
    spacer.className = "dashboard-board-link-spacer";
    spacer.setAttribute("aria-hidden", "true");

    const chevron = document.createElement("span");
    chevron.className = "dashboard-board-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';

    link.append(thumb, title, spacer, chevron);
    mount.appendChild(link);
  }
}

/**
 * Fetches the list of whiteboards the currently signed in user has joined, and
 * populates the whiteboard list.
 */
async function loadAndRenderBoards() {
  const boards = await getJoinedWhiteboards();
  renderBoardList(boards);
}

// ---- Create whiteboard modal ----

/** @type {HTMLElement | null} */
let createModalRoot = null;
/** @type {HTMLInputElement | null} */
let createModalInput = null;
/** @type {HTMLElement | null} */
let createModalError = null;
/** @type {HTMLButtonElement | null} */
let createModalSubmit = null;

/** @param {KeyboardEvent} e */
function onCreateModalKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCreateWhiteboardModal();
  }
}

function openCreateWhiteboardModal() {
  if (!createModalRoot || !createModalInput || !createModalError || !createModalSubmit) return;

  createModalError.textContent = "";
  createModalInput.value = "";
  createModalRoot.hidden = false;
  createModalRoot.setAttribute("aria-hidden", "false");
  createModalSubmit.disabled = false;
  document.addEventListener("keydown", onCreateModalKeydown);
  requestAnimationFrame(() => {
    createModalInput?.focus();
  });
}

function closeCreateWhiteboardModal() {
  if (!createModalRoot) return;
  createModalRoot.hidden = true;
  createModalRoot.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onCreateModalKeydown);
}

function wireCreateModal() {
  createModalRoot = document.getElementById("dashboardCreateModal");
  createModalInput = /** @type {HTMLInputElement | null} */ (document.getElementById("dashboardCreateNameInput"));
  createModalError = document.getElementById("dashboardCreateModalError");
  createModalSubmit = /** @type {HTMLButtonElement | null} */ (document.getElementById("dashboardCreateModalSubmit"));
  const cancelBtn = document.getElementById("dashboardCreateModalCancel");

  document.querySelectorAll('[data-dashboard-modal-dismiss="create"]').forEach((el) => {
    el.addEventListener("click", () => closeCreateWhiteboardModal());
  });

  cancelBtn?.addEventListener("click", () => closeCreateWhiteboardModal());

  createModalInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createModalSubmit?.click();
    }
  });

  createModalSubmit?.addEventListener("click", async () => {
    const user = currentUser();
    if (!user || !createModalInput || !createModalError || !createModalSubmit) return;

    const trimmed = createModalInput.value.trim();
    if (!trimmed) {
      createModalError.textContent = "Please enter a name.";
      createModalInput.focus();
      return;
    }

    createModalError.textContent = "";
    createModalSubmit.disabled = true;
    try {
      const id = await createWhiteboard(user.uid, trimmed);
      window.location.href = `whiteboard.html?board=${encodeURIComponent(id)}`;
    } catch (err) {
      console.error(err);
      createModalError.textContent = "Could not create whiteboard. Please try again.";
      createModalSubmit.disabled = false;
    }
  });
}

// ---- Join whiteboard modal ----

/** @type {HTMLElement | null} */
let joinModalRoot = null;
/** @type {HTMLInputElement | null} */
let joinModalInput = null;
/** @type {HTMLElement | null} */
let joinModalError = null;
/** @type {HTMLButtonElement | null} */
let joinModalSubmit = null;

/** @param {KeyboardEvent} e */
function onJoinModalKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeJoinWhiteboardModal();
  }
}

function openJoinWhiteboardModal() {
  if (!joinModalRoot || !joinModalInput || !joinModalError || !joinModalSubmit) return;

  joinModalError.textContent = "";
  joinModalInput.value = "";
  joinModalRoot.hidden = false;
  joinModalRoot.setAttribute("aria-hidden", "false");
  joinModalSubmit.disabled = false;
  document.addEventListener("keydown", onJoinModalKeydown);
  requestAnimationFrame(() => {
    joinModalInput?.focus();
  });
}

function closeJoinWhiteboardModal() {
  if (!joinModalRoot) return;
  joinModalRoot.hidden = true;
  joinModalRoot.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onJoinModalKeydown);
}

function wireJoinModal() {
  joinModalRoot = document.getElementById("dashboardJoinModal");
  joinModalInput = /** @type {HTMLInputElement | null} */ (document.getElementById("dashboardJoinIdInput"));
  joinModalError = document.getElementById("dashboardJoinModalError");
  joinModalSubmit = /** @type {HTMLButtonElement | null} */ (document.getElementById("dashboardJoinModalSubmit"));
  const cancelBtn = document.getElementById("dashboardJoinModalCancel");

  document.querySelectorAll('[data-dashboard-modal-dismiss="join"]').forEach((el) => {
    el.addEventListener("click", () => closeJoinWhiteboardModal());
  });

  cancelBtn?.addEventListener("click", () => closeJoinWhiteboardModal());

  joinModalInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      joinModalSubmit?.click();
    }
  });

  joinModalSubmit?.addEventListener("click", async () => {
    const user = currentUser();
    if (!user || !joinModalInput || !joinModalError || !joinModalSubmit) return;

    const whiteboardId = joinModalInput.value.trim();
    if (!whiteboardId) {
      joinModalError.textContent = "Please enter a whiteboard ID.";
      joinModalInput.focus();
      return;
    }

    joinModalError.textContent = "";
    joinModalSubmit.disabled = true;
    try {
      await requestToJoinWhiteboard(whiteboardId, user.uid);
      closeJoinWhiteboardModal();
      showToast('Join request sent!');
      // await loadAndRenderBoards();
      
    } catch (err) {
      console.error(err);
      joinModalError.textContent = "Could not join that whiteboard. Check the ID and try again.";
      joinModalSubmit.disabled = false;
    }
  });
}

function wireActions() {
  const createBtn = document.getElementById("dashboardCreateBtn");
  const joinBtn = document.getElementById("dashboardJoinBtn");

  createBtn?.addEventListener("click", () => {
    const user = currentUser();
    if (!user) return;
    openCreateWhiteboardModal();
  });

  joinBtn?.addEventListener("click", () => {
    const user = currentUser();
    if (!user) return;
    openJoinWhiteboardModal();
  });
}

/**
 * @param {import('firebase/auth').User} user
 */
function initDashboard(user) {
  wireCreateModal();
  wireJoinModal();
  wireActions();
  loadAndRenderBoards().catch((err) => {
    console.error(err);
    window.alert("Could not load whiteboards.");
  });
}

try {
  mountAuthUI({ onSignedIn: initDashboard });
} catch (err) {
  console.error(err);
  alert("Failed to initialize dashboard: " + err.message);
}
