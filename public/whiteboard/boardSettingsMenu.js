/**
 * Shared settings dropdown for a whiteboard. Used from:
 *   - the active board title on whiteboard.html
 *   - each item in the boards panel on whiteboard.html
 *   - each board card on index.html
 *
 * Menu items depend on the caller's role:
 *   - Rename / Delete: owner only
 *   - Leave: non-owner members
 *   - Export PNG: only when a fabric canvas is passed (i.e., active board)
 *   - Board info / Copy link: everyone
 *
 * All modals are created ad-hoc and removed on close, so neither HTML file
 * needs to declare them.
 */

import { deleteWhiteboard, leaveWhiteboard, renameWhiteboard } from "./firestore.js";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   members: string[],
 *   mods?: string[],
 *   owner: string
 * }} BoardMeta
 *
 * @typedef {{
 *   anchorEl: HTMLElement,
 *   board: BoardMeta,
 *   userId: string,
 *   canvas?: any,
 *   onRenamed?: (newName: string) => void,
 *   onRemoved?: (reason: 'deleted' | 'left') => void,
 * }} OpenMenuOptions
 */

let openMenuCleanup = null;

/**
 * Open the board settings dropdown anchored to the given element.
 *
 * @param {OpenMenuOptions} opts
 */
export function openBoardSettingsMenu(opts) {
  closeBoardSettingsMenu();

  const { anchorEl, board, userId, canvas = null, onRenamed, onRemoved } = opts;
  const isOwner = board.owner === userId;

  const menu = document.createElement("div");
  menu.className = "board-settings-menu";
  menu.setAttribute("role", "menu");

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @param {{ danger?: boolean }} [opts]
   */
  const addItem = (label, onClick, { danger = false } = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "board-settings-menu__item" + (danger ? " board-settings-menu__item--danger" : "");
    btn.setAttribute("role", "menuitem");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      closeBoardSettingsMenu();
      onClick();
    });
    menu.appendChild(btn);
  };

  const addDivider = () => {
    const hr = document.createElement("div");
    hr.className = "board-settings-menu__divider";
    menu.appendChild(hr);
  };

  if (isOwner) {
    addItem("Rename", () => openRenameModal(board, onRenamed));
  }
  addItem("Board info", () => openInfoModal(board));
  addItem("Copy link", () => copyBoardLink(board));
  if (canvas) {
    addItem("Export as PNG", () => exportCanvasPng(canvas, board.name));
  }

  addDivider();

  addItem("Leave board", () => openLeaveModal(board, onRemoved), { danger: true });

  if (isOwner) {
    addItem("Delete board", () => openDeleteModal(board, onRemoved), { danger: true });
  }

  document.body.appendChild(menu);
  positionMenu(menu, anchorEl);

  const onDocPointer = (e) => {
    if (menu.contains(e.target) || anchorEl.contains(e.target)) return;
    closeBoardSettingsMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeBoardSettingsMenu();
  };
  const onReflow = () => positionMenu(menu, anchorEl);

  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, true);

  openMenuCleanup = () => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onReflow);
    window.removeEventListener("scroll", onReflow, true);
    menu.remove();
    openMenuCleanup = null;
  };
}

export function closeBoardSettingsMenu() {
  if (openMenuCleanup) openMenuCleanup();
}

/**
 * Open the board settings dropdown anchored to the given element.
 *
 * @param {OpenMenuOptions} opts
 */
export function toggleBoardSettingsMenu(opts) {
  if (openMenuCleanup)
    closeBoardSettingsMenu();
  else
    openBoardSettingsMenu(opts);
}

/**
 * Anchor the menu to the lower-right of `anchorEl`, clamped to the viewport.
 *
 * @param {HTMLElement} menu
 * @param {HTMLElement} anchorEl
 */
function positionMenu(menu, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const margin = 8;

  menu.style.visibility = "hidden";
  menu.style.top = "0px";
  menu.style.left = "0px";
  const menuRect = menu.getBoundingClientRect();

  let top = rect.bottom + 6;
  if (top + menuRect.height + margin > window.innerHeight) {
    top = Math.max(margin, rect.top - menuRect.height - 6);
  }

  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width + margin > window.innerWidth) {
    left = window.innerWidth - menuRect.width - margin;
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = "visible";
}

/* --------------------------- Modal primitives --------------------------- */

/**
 * Build a modal shell. Returns the root plus a helper to close it.
 *
 * @param {string} titleText
 * @returns {{ root: HTMLElement, body: HTMLElement, actions: HTMLElement, close: () => void }}
 */
function createModal(titleText) {
  const root = document.createElement("div");
  root.className = "board-settings-modal-root";

  const scrim = document.createElement("div");
  scrim.className = "board-settings-modal-scrim";
  root.appendChild(scrim);

  const card = document.createElement("div");
  card.className = "board-settings-modal-card hud-glass";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  root.appendChild(card);

  const title = document.createElement("h2");
  title.className = "board-settings-modal-title";
  title.textContent = titleText;
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "board-settings-modal-body";
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "board-settings-modal-actions";
  card.appendChild(actions);

  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const close = () => {
    document.removeEventListener("keydown", onKey);
    root.remove();
  };

  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);
  return { root, body, actions, close };
}

/**
 * @param {HTMLElement} container
 * @param {string} label
 * @param {{ primary?: boolean, danger?: boolean, onClick: () => void | Promise<void> }} opts
 * @returns {HTMLButtonElement}
 */
function addModalButton(container, label, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "board-settings-modal-btn";
  if (opts.primary) btn.classList.add("board-settings-modal-btn--primary");
  if (opts.danger) btn.classList.add("board-settings-modal-btn--danger");
  if (!opts.primary && !opts.danger) btn.classList.add("board-settings-modal-btn--secondary");
  btn.textContent = label;
  btn.addEventListener("click", () => opts.onClick());
  container.appendChild(btn);
  return btn;
}

/* ----------------------------- Actions ----------------------------- */

/**
 * @param {BoardMeta} board
 * @param {((newName: string) => void) | undefined} onRenamed
 */
function openRenameModal(board, onRenamed) {
  const modal = createModal("Rename whiteboard");

  const label = document.createElement("label");
  label.className = "board-settings-modal-label";
  label.textContent = "Name";
  modal.body.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "board-settings-modal-input";
  input.maxLength = 80;
  input.value = board.name ?? "";
  label.htmlFor = "boardRenameInput";
  input.id = "boardRenameInput";
  modal.body.appendChild(input);

  const error = document.createElement("p");
  error.className = "board-settings-modal-error";
  error.setAttribute("aria-live", "polite");
  modal.body.appendChild(error);

  const cancelBtn = addModalButton(modal.actions, "Cancel", { onClick: () => modal.close() });

  const submit = async () => {
    const trimmed = input.value.trim();
    if (!trimmed) {
      error.textContent = "Please enter a name.";
      input.focus();
      return;
    }
    if (trimmed === board.name) {
      modal.close();
      return;
    }
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    error.textContent = "";
    try {
      await renameWhiteboard(board.id, trimmed);
      board.name = trimmed;
      onRenamed?.(trimmed);
      modal.close();
    } catch (err) {
      console.error(err);
      error.textContent = "Could not rename. " + (err?.message ?? "");
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };

  const submitBtn = addModalButton(modal.actions, "Save", { primary: true, onClick: submit });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/**
 * @param {BoardMeta} board
 */
function openInfoModal(board) {
  const modal = createModal("Board info");

  const list = document.createElement("dl");
  list.className = "board-settings-info-list";

  /** @param {string} key @param {string} value */
  const row = (key, value) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  };

  row("Name", board.name ?? "Untitled");
  row("Board ID", board.id);
  row("Owner", board.owner);
  row("Members", String(board.members?.length ?? 0));

  modal.body.appendChild(list);

  addModalButton(modal.actions, "Close", { primary: true, onClick: () => modal.close() });
}

/**
 * @param {BoardMeta} board
 */
async function copyBoardLink(board) {
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}whiteboard.html?board=${encodeURIComponent(board.id)}`;
  try {
    await navigator.clipboard.writeText(url);
    showTransientToast("Link copied");
  } catch (err) {
    console.error(err);
    showTransientToast("Could not copy link");
  }
}

/**
 * Export the fabric canvas contents as a PNG download.
 *
 * @param {any} canvas fabric.Canvas
 * @param {string} boardName
 */
function exportCanvasPng(canvas, boardName) {
  try {
    const dataUrl = canvas.toDataURL({ format: "png", multiplier: 2 });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${sanitizeFilename(boardName)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.error(err);
    showTransientToast("Export failed");
  }
}

/** @param {string} name */
function sanitizeFilename(name) {
  const cleaned = (name ?? "whiteboard").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return cleaned || "whiteboard";
}

/**
 * @param {BoardMeta} board
 * @param {((reason: 'deleted' | 'left') => void) | undefined} onRemoved
 */
function openDeleteModal(board, onRemoved) {
  const modal = createModal("Delete whiteboard?");

  const desc = document.createElement("p");
  desc.className = "board-settings-modal-desc";
  desc.textContent =
    `"${board.name}" and everything on it will be permanently deleted for you and every member. This cannot be undone.`;
  modal.body.appendChild(desc);

  const error = document.createElement("p");
  error.className = "board-settings-modal-error";
  error.setAttribute("aria-live", "polite");
  modal.body.appendChild(error);

  const cancelBtn = addModalButton(modal.actions, "Cancel", { onClick: () => modal.close() });
  const confirmBtn = addModalButton(modal.actions, "Delete", {
    danger: true,
    onClick: async () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await deleteWhiteboard(board.id);
        onRemoved?.("deleted");
        modal.close();
      } catch (err) {
        console.error(err);
        error.textContent = "Could not delete. " + (err?.message ?? "");
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    },
  });
}

/**
 * @param {BoardMeta} board
 * @param {((reason: 'deleted' | 'left') => void) | undefined} onRemoved
 */
function openLeaveModal(board, onRemoved) {
  const modal = createModal("Leave whiteboard?");

  const desc = document.createElement("p");
  desc.className = "board-settings-modal-desc";
  desc.textContent =
    `You will no longer be a member of "${board.name}".`;
  modal.body.appendChild(desc);

  const error = document.createElement("p");
  error.className = "board-settings-modal-error";
  error.setAttribute("aria-live", "polite");
  modal.body.appendChild(error);

  const cancelBtn = addModalButton(modal.actions, "Cancel", { onClick: () => modal.close() });
  const confirmBtn = addModalButton(modal.actions, "Leave", {
    danger: true,
    onClick: async () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await leaveWhiteboard(board.id);
        onRemoved?.("left");
        modal.close();
      } catch (err) {
        console.error(err);
        error.textContent = "Could not leave. " + (err?.message ?? "");
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    },
  });
}

/* ----------------------------- Toast ----------------------------- */

/** @param {string} message */
function showTransientToast(message) {
  const toast = document.createElement("div");
  toast.className = "board-settings-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("board-settings-toast--visible"));
  setTimeout(() => {
    toast.classList.remove("board-settings-toast--visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 600);
  }, 1800);
}
