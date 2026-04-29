/**
 * Shared notification panel — shows pending join requests across all whiteboards
 * the signed-in user owns or moderates. Used by both the dashboard and the
 * whiteboard pages.
 *
 * Expects the following elements in the DOM:
 *   #notifBtn    — the bell button that toggles the panel
 *   #notifBadge  — badge count on the button
 *   #notifPanel  — the dropdown panel
 *   #notifList   — <ul> inside the panel
 *   #notifEmpty  — empty-state paragraph inside the panel
 */

import { getJoinedWhiteboards, getPendingJoinRequests, acceptJoinRequest, rejectJoinRequest } from './firestore.js';

/** @type {HTMLElement | null} */
let notifPanel = null;

/**
 * Clears and populates the notification content list, and updates the alert
 * badge on the notification button.
 * 
 * @param {{ userID: string, username: string, whiteboardID: string, whiteboardName: string }[]} pendingRequests
 */
function renderNotifications(pendingRequests) {
    const badge = document.getElementById('notifBadge');
    const list  = document.getElementById('notifList');
    const empty = document.getElementById('notifEmpty');
    if (!badge || !list || !empty) return;

    list.innerHTML = '';

    if (pendingRequests.length === 0) {
        badge.hidden = true;
        empty.hidden = false;
        return;
    }

    badge.textContent = String(pendingRequests.length);
    badge.hidden = false;
    empty.hidden = true;

    for (const req of pendingRequests) {
        const li = document.createElement('li');
        li.className = 'notif-item';

        const info = document.createElement('div');
        info.className = 'notif-item-info';

        const board = document.createElement('span');
        board.className = 'notif-item-board';
        board.textContent = req.whiteboardName;

        const user = document.createElement('span');
        user.className = 'notif-item-user';
        user.textContent = req.username.slice(0, 10) + (req.username.length > 10 ? '\u2026' : '');

        info.append(board, user);

        const actions = document.createElement('div');
        actions.className = 'notif-item-actions';

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'notif-btn notif-btn--accept';
        acceptBtn.textContent = 'Accept';

        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'notif-btn notif-btn--reject';
        rejectBtn.textContent = 'Reject';

        acceptBtn.addEventListener('click', async () => {
            acceptBtn.disabled = true;
            rejectBtn.disabled = true;
            try {
                await acceptJoinRequest(req.whiteboardID, req.userID);
                await refreshNotifications();
            } catch (err) {
                console.error(err);
                acceptBtn.disabled = false;
                rejectBtn.disabled = false;
            }
        });

        rejectBtn.addEventListener('click', async () => {
            acceptBtn.disabled = true;
            rejectBtn.disabled = true;
            try {
                await rejectJoinRequest(req.whiteboardID, req.userID);
                await refreshNotifications();
            } catch (err) {
                console.error(err);
                acceptBtn.disabled = false;
                rejectBtn.disabled = false;
            }
        });

        actions.append(acceptBtn, rejectBtn);
        li.append(info, actions);
        list.appendChild(li);
    }
}

/**
 * Fetches a list of notifications and repopulates the notification list.
 */
export async function refreshNotifications() {
    const whiteboards = await getJoinedWhiteboards();
    const requests = await getPendingJoinRequests(whiteboards);
    renderNotifications(requests);
}

/**
 * Connects panels and buttons from the HTML page, and fetches notifications.
 * 
 * For the sake of efficiency, since `getJoinedWhitebaords()` is usually already
 * called during initialization, this expects that list to be provided.
 * 
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }[]} whiteboardList
 */
export async function initNotifications(whiteboardList) {
    const btn = document.getElementById('notifBtn');
    notifPanel = document.getElementById('notifPanel');
    if (!btn || !notifPanel) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        notifPanel.hidden = !notifPanel.hidden;
    });

    document.addEventListener('click', (e) => {
        if (!notifPanel || notifPanel.hidden) return;
        if (!notifPanel.contains(/** @type {Node} */ (e.target)) && e.target !== btn) {
            notifPanel.hidden = true;
        }
    });

    const requests = await getPendingJoinRequests(whiteboardList);
    renderNotifications(requests);
}
