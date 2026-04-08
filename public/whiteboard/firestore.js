/**
 * Functions that access/modify data in the Firestore database.
 */

import { currentUser } from "./auth.js";
import { pickRandom } from "./utils.js";

const db = window.firebase.firestore();

/**
 * Create a new whiteboard, setting the creating user as the owner.
 *
 * @param {string} userID The user creating the whiteboard
 * @param {string} name Whiteboard name
 * @returns {Promise<string>} ID of the newly created whiteboard
 */
export async function createWhiteboard(userID, name) {
    // Simultaneously create the whiteboard and set userID as the owner.
    // Note: This approach works best with the Firestore security roles.
    const newWB = db.collection('whiteboards').doc();

    await newWB.set({
        name,
        members: [ userID ],
        moderators: [],
        owner: userID,
        pendingRequests: false
    });
    
    return newWB.id;
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
    await db.collection('whiteboards').doc(whiteboardID).delete();
}

/**
 * Gets a list of whiteboards that the currently signed in user is a member of.
 *
 * @returns {Promise<{ id: string, name: string, members: string[], mods: string[], owner: string }[]>} List of joined whiteboards
 */
export async function getJoinedWhiteboards() {
    console.log('Getting joined whiteboards...');

    const uid = currentUser().uid;
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
        boardIDs.map(id =>
            db.collection('whiteboards').doc(id).collection('join-requests').get()
        )
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
    const whiteboardRef = db.collection('whiteboards').doc(whiteboardID);
    const joinRequestRef = whiteboardRef.collection('join-requests').doc(userID);

    await db.runTransaction(async (transaction) => {
        const joinRequest = await transaction.get(joinRequestRef);

        if (!joinRequest.exists) throw Error('Join request not found');

        transaction.delete(joinRequestRef);
        transaction.update(whiteboardRef, {
            members: window.firebase.firestore.FieldValue.arrayUnion(userID)
        });
    });
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
    await db.collection('whiteboards').doc(whiteboardID).update({
        'members': window.firebase.firestore.FieldValue.arrayUnion(userID)
    });
}

/**
 * Promotes a regular member to a moderator.
 * 
 * @param whiteboardID The whiteboard the user is being promoted on
 * @param userID ID of the member that is being promoted
 */
export async function promoteToMod(whiteboardID, userID) {
    const wb = await getWhiteboardById(whiteboardID);
    if (!wb)
        throw Error(`Failed to retrieve information for whiteboard ${whiteboardID}`);
    if (!wb.members.includes(userID))
        throw Error(`User ${userID} is not a member of whiteboard ${whiteboardID}`);
    if (wb.owner == userID || wb.mods.includes(userID))
        throw Error(`User ${userID} is already privileged in whiteboard ${whiteboardID}`);

    await db.collection('whiteboards').doc(whiteboardID).update({
        mods: [ ...wb.mods, userID ]
    });
}

/**
 * Promotes either a member or a mod to become the owner.
 * 
 * @param {string} whiteboardID The whiteboard the user is being promoted on
 * @param {string} userID ID of the member that will become the owner
 */
export async function transferOwnership(whiteboardID, userID) {
    const wb = await getWhiteboardById(whiteboardID);
    if (!wb)
        throw Error(`Failed to retrieve information for whiteboard ${whiteboardID}`);
    if (!wb.members.includes(userID))
        throw Error(`User ${userID} is not a member of whiteboard ${whiteboardID}`);
    if (userID == wb.owner)
        throw Error(`User ${userID} is already the owner of whiteboard ${whiteboardID}`);

    const payload = {
        owner: userID,
        mods: [ ...wb.mods, wb.owner ] // Demote owner to a moderator
    };

    // If user is a mod, remove them from the mods list
    if (wb.mods.includes(userID)) {
        const index = wb.mods.indexOf(userID);
        payload['mods'].splice(index, 1);
    }

    await db.collection('whiteboards').doc(whiteboardID).update(payload);
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
    const user = currentUser();
    if (!user) throw Error(`User not signed in`);

    const wb = await getWhiteboardById(whiteboardID);
    if (!wb) throw Error(`Failed to retrieve information for whiteboard ${whiteboardID}`);

    const payload = {
        members: wb.members.filter(uid => user.uid) // Remove self from member list
    };

    // Handle case where the user owns the whiteboard
    if (user.uid == wb.owner) {
        if (wb.members.length == 1) {
            // There are no other users to receive ownership; delete the
            // whiteboard instead
            await deleteWhiteboard(whiteboardID);
            return;
        }
        else {
            let newOwner;
            
            if (wb.mods.length != 0) {
                // Pick a random mod
                newOwner = pickRandom(wb.mods);

                // Remove user from mod list
                payload['mods'] = wb.mods.filter(uid => (uid != newOwner));
            }
            else {
                // Pick a random member
                newOwner = pickRandom(payload['members']);
            }

            payload['owner'] = newOwner;
        }
    }
    
    // If user is a mod, remove them from the mod list
    if (wb.mods.includes(user.uid)) {
        payload['mods'] = wb.mods.filter(uid => (uid != user.uid));
    }

    await db.collection('whiteboards').doc(whiteboardID).update(payload);
}
