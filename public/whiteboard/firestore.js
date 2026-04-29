/**
 * Functions that access/modify data in the Firestore database.
 */

const db = window.firebase.firestore();

function currentUser() {
    return window.firebase.auth().currentUser;
}

async function post(path, body) {
    const user = currentUser();
    if (!user) throw new Error("Not signed in");
    const token = await user.getIdToken();
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
}

/**
 * Returns the user document for the given uid, or null if it doesn't exist.
 *
 * @param {string} uid
 * @returns {Promise<{ username: string, joinedWhiteboards: string[], photoURL: string | null } | null>}
 */
export async function getUserProfile(uid) {
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists ? snap.data() : null;
}

/**
 * Create a new whiteboard, setting the creating user as the owner.
 *
 * @param {string} userID The user creating the whiteboard
 * @param {string} name Whiteboard name
 * @returns {Promise<string>} ID of the newly created whiteboard
 */
export async function createWhiteboard(_userID, name) {
    const { whiteboardID } = await post('/api/createWhiteboard', { name });
    return whiteboardID;
}

/**
 * Read a single whiteboard document (e.g. workspace title).
 *
 * @param {string} boardId Firestore document id
 * @returns {Promise<{ id: string, name: string, members: string[], mods: string[], owner: string } | null>}
 */
export async function getWhiteboardById(boardId) {
    const snap = await db.collection("whiteboards").doc(boardId).get();
    if (!snap.exists) throw Error(`Could not find whiteboard ${boardId}`);
    const data = snap.data();
    return { id: snap.id, name: data?.name ?? "Untitled", ...data };
}

/**
 * Deletes a whiteboard. This only works if the current user is the owner.
 *
 * @param {string} whiteboardID Whiteboard to be deleted
 */
export async function deleteWhiteboard(whiteboardID) {
    await post('/api/deleteWhiteboard', { whiteboardID });
}

/**
 * Renames a whiteboard. Permitted for the owner (and moderators, per security rules).
 *
 * @param {string} whiteboardID Whiteboard to rename
 * @param {string} name New name
 */
export async function renameWhiteboard(whiteboardID, name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw Error('Name cannot be empty');
    await db.collection('whiteboards').doc(whiteboardID).update({ name: trimmed });
}

/**
 * Gets a list of whiteboards that the currently signed in user is a member of.
 *
 * @returns {Promise<{ id: string, name: string, members: string[], mods: string[], owner: string }[]>} List of joined whiteboards
 */
export async function getJoinedWhiteboards() {
    console.log('Fetching joined whiteboards...');

    const uid = currentUser()?.uid;
    if (!uid) throw Error('User not signed in');

    const snapshot = await db.collection('whiteboards')
        .where(`members`, 'array-contains', uid)
        .get();

    const whiteboards = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) );

    return whiteboards;
}

/**
 * Submits a join request to the specified whiteboard.
 * 
 * @param {string} whiteboardID ID of the whiteboard the user wants to join
 * @param {string} userID ID of the requesting user
 */
export async function requestToJoinWhiteboard(whiteboardID) {
    const user = currentUser();
    if (!user) throw Error('User is not signed in');

    await db.collection('whiteboards').doc(whiteboardID)
        .collection('join-requests').doc(user.uid).set({
            userID: user.uid,
            timestamp: window.firebase.firestore.FieldValue.serverTimestamp(),
            whiteboardID
        });
}

/**
 * Gets a list of join requests for whiteboards the signed in user either owns,
 * or is moderating.
 *
 * @param {{ id: string, name: string, members: string[], mods: string[], owner: string }[]} whiteboards
 * List of joined whiteboards (can be obtained using `getJoinedWhiteboards()`).
 * @returns {Promise<{ userID: string, whiteboardID: string, whiteboardName: string }[]>}
 * List of join requests on the provided whiteboards that the signed in user can accept.
 */
export async function getPendingJoinRequests(whiteboards) {
    const user = currentUser();
    if (!user) throw Error('User is not signed in');
    
    // Get all whiteboards that the user owns or moderates
    const boardNames = {}
    const boardIDs = []
    for (let i = 0; i < whiteboards.length; i++) {
        const board = whiteboards[i];
        if (user.uid == board.owner || board.mods.includes(user.uid)) {
            boardNames[board.id] = board.name;
            boardIDs.push(board.id);
        }
    }
    
    if (boardIDs.length === 0) return [];

    const snapshots = await Promise.all(
        boardIDs.map(async id => {
            console.log(`Fetching join requests for whiteboard ${id}...`);
            return await db.collection('whiteboards').doc(id).collection('join-requests').get()
        })
    );

    return snapshots.flatMap((snap, i) =>
        snap.docs.map(doc => ({
            whiteboardID: boardIDs[i],
            userID: doc.data().userID,
            whiteboardName: boardNames[boardIDs[i]]
        }))
    );
}

/**
 * Closes the pending join request, and adds the user to the whiteboard as a
 * regular member. If the join request doesn't exist, this operation will fail.
 *
 * @param {string} whiteboardID Whiteboard the join request is part of
 * @param {string} userID User being accepted into the whiteboard
 */
export async function acceptJoinRequest(whiteboardID, userID) {
    const joinRequestRef = db.collection('whiteboards').doc(whiteboardID)
        .collection('join-requests').doc(userID);

    if (!(await joinRequestRef.get()).exists) throw Error('Join request not found');

    await post('/api/addUserToWhiteboard', { whiteboardID, userID });
    await joinRequestRef.delete();
}

/**
 * Denies the join request by removing the request from the join-requests
 * collection.
 * 
 * @param whiteboardID Whiteboard the join request was submitted to
 * @param userID User who's join request is being rejected
 */
export async function rejectJoinRequest(whiteboardID, userID) {
    await db.collection('whiteboards').doc(whiteboardID)
        .collection('join-requests').doc(userID).delete();
}

/**
 * Adds a user to the specified whiteboard as a regular member (Note: if you're
 * accepting a join request, use `acceptJoinRequest()` instead).
 *
 * @param {string} whiteboardID Whiteboard to add the user to
 * @param {string} userID User to add
 * @returns {Promise}
 */
export async function addUserToWhiteboard(whiteboardID, userID) {
    await post('/api/addUserToWhiteboard', { whiteboardID, userID });
}

/**
 * Promotes a regular member to a moderator.
 * 
 * @param whiteboardID The whiteboard the user is being promoted on
 * @param userID ID of the member that is being promoted
 */
export async function promoteToMod(whiteboardID, userID) {
    await post('/api/setUserRole', { whiteboardID, userID, role: 'mod' });
}

/**
 * Promotes either a member or a mod to become the owner.
 * 
 * @param {string} whiteboardID The whiteboard the user is being promoted on
 * @param {string} userID ID of the member that will become the owner
 */
export async function transferOwnership(whiteboardID, userID) {
    await post('/api/setUserRole', { whiteboardID, userID, role: 'owner' });
}

/**
 * Removes currently signed in user from a whiteboard they are a member of.
 * 
 * If they are the owner, ownership will first be transferred to another member.
 * If there are no other members, the whiteboard will be deleted.
 * 
 * @param {string} whiteboardID Whiteboard being left
 */
export async function leaveWhiteboard(whiteboardID) {
    try {
        await post('/api/leaveWhiteboard', { whiteboardID });
    } catch (err) {
        // Backend throws when owner is the last member — delete instead
        if (err.message.includes('only member')) {
            await deleteWhiteboard(whiteboardID);
        } else {
            throw err;
        }
    }
}
