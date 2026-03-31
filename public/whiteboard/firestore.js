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
    // Add new whiteboard with userID as the owner
    const wb = await db.collection("whiteboards").add({
        name: name
    });

    console.log('Whiteboard created:', wb.id);
    
    // Set user as the new whiteboard's owner
    await db.collection('whiteboards').doc(wb.id)
            .collection('members').doc(userID).set(
                { role: 'owner', userID }
            );

    return wb.id;
}

/**
 * Adds a user to the specified whiteboard as a regular member.
 *
 * @param {string} whiteboardID Whiteboard to add the user to
 * @param {string} userID User to add
 * @returns {Promise}
 */
export async function addUserToWhiteboard(whiteboardID, userID) {
    await db.collection('whiteboards').doc(whiteboardID)
            .collection('members').doc(userID).set(
                { role: "member", userID },
                { merge: true }
            );
}

/**
 * Get list of whiteboards available to a certain user.
 *
 * @param {string} userID Which user to find whiteboards for
 * @returns {Promise<{ id: string, name: string }[]>} List of whiteboard IDs and names
 */
export async function getWhiteboards(userID) {
    console.log('Getting joined whiteboards...');

    // Find all "members" collections this user is included in
    const memberships = await db.collectionGroup('members')
        .where('userID', '==', userID)
        .get();
    
    // doc.ref.parent is the "members" collection; .parent is the whiteboard doc
    const boards = await Promise.all(
        memberships.docs.map(async (doc) => {
            const wbSnap = await doc.ref.parent.parent.get();
            return { id: wbSnap.id, name: wbSnap.data()?.name ?? "Untitled" };
        })
    );

    return boards;
}
