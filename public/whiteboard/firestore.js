/**
 * Functions that access/modify data in the Firestore database.
 */

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
        owner: userID
    });
    
    return newWB.id;
}

/**
 * Adds a user to the specified whiteboard as a regular member.
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
 * Get list of whiteboards available to a certain user.
 *
 * @param {string} userID Which user to find whiteboards for
 * @returns {Promise<{ id: string, name: string, members: { [userId: string]: 'member' | 'mod' | 'owner' } }[]>} List of joined whiteboards
 */
export async function getWhiteboards(userID) {
    console.log('Getting joined whiteboards...');

    const snapshot = await db.collection('whiteboards')
        .where(`members`, 'array-contains', userID)
        .get();

    const whiteboards = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) );

    return whiteboards;
}

/**
 * Read a single whiteboard document (e.g. workspace title).
 *
 * @param {string} boardId Firestore document id
 * @returns {Promise<{ id: string, name: string } | null>}
 */
export async function getWhiteboardById(boardId) {
    const snap = await db.collection("whiteboards").doc(boardId).get();
    if (!snap.exists) return null;
    return { id: snap.id, name: snap.data()?.name ?? "Untitled" };
}
