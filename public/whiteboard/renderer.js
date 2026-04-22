/**
 * Functions that handle HTML rendering tasks.
 */

import { currentUser } from "./auth.js";
import { getJoinedWhiteboards } from "./firestore.js";
import { toggleBoardSettingsMenu } from "./boardSettingsMenu.js";

/**
 * Fetches all whiteboards the current user can access, and updates the
 * whiteboards panel.
 *
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }[]} whiteboardList
 * Whiteboard to render (obtained from `getJoinedWhiteboards()`)
 */
export async function refreshWhiteboardList(whiteboardList) {
    const list = document.getElementById("joinedBoardsList");
    if (!list) return;
    const uid = currentUser()?.uid ?? "";

    list.innerHTML = "";

    if (whiteboardList.length === 0) {
        const empty = document.createElement("li");
        empty.textContent = "No whiteboards yet.";
        list.appendChild(empty);
        return;
    }

    const currentBoardId = new URLSearchParams(window.location.search).get("board") ?? "";

    for (const board of whiteboardList) {
        const li = document.createElement("li");

        const row = document.createElement("div");
        row.className = "hud-board-row";

        const link = document.createElement("a");
        link.dataset.boardId = board.id;
        link.href = `whiteboard.html?board=${encodeURIComponent(board.id)}`;
        link.textContent = board.name;
        row.appendChild(link);

        const settingsBtn = createSettingsTrigger();
        settingsBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleBoardSettingsMenu({
                anchorEl: settingsBtn,
                board,
                userId: uid,
                onRenamed: () => {
                    link.textContent = board.name;
                },
                onRemoved: () => {
                    li.remove();
                    if (board.id === currentBoardId) {
                        window.location.replace("index.html");
                        return;
                    }
                    getJoinedWhiteboards().then(refreshWhiteboardList).catch(console.error);
                },
            });
        });
        row.appendChild(settingsBtn);

        li.appendChild(row);
        list.appendChild(li);
    }
}

/**
 * Create a compact kebab-style trigger button for the board settings menu.
 *
 * @returns {HTMLButtonElement}
 */
function createSettingsTrigger() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "board-settings-trigger";
    btn.setAttribute("aria-label", "Whiteboard settings");
    btn.setAttribute("aria-haspopup", "menu");
    btn.title = "Whiteboard settings";
    btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>' +
        '</svg>';
    return btn;
}
