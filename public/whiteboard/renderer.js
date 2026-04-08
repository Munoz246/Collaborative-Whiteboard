/**
 * Functions that handle HTML rendering tasks.
 */

import { currentUser } from "./auth.js";
import { getJoinedWhiteboards } from "./firestore.js";

/**
 * Fetches all whiteboards the current user can access, and updates the
 * whiteboards panel.
 * 
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }[]} whiteboardList
 * Whiteboard to render (obtained from `getJoinedWhiteboards()`)
 */
export async function refreshWhiteboardList(whiteboardList) {
    const list = document.getElementById("joinedBoardsList");

    // Remove current list content
    list.innerHTML = "";

    // Show message if there are no whiteboards
    if (whiteboardList.length === 0) {
        const empty = document.createElement("li");
        // empty.className = "hud-placeholder-row";
        empty.textContent = "No whiteboards yet.";
        list.appendChild(empty);
        return;
    }

    // Add an entry for each whiteboard
    for (const board of whiteboardList) {
        const item = document.createElement("a");
        item.dataset.boardId = board.id;
        item.href = `whiteboard.html?board=${encodeURIComponent(board.id)}`;
        item.textContent = board.name;
        list.appendChild(item);
    }
}
