/**
 * Cloud functions related to whiteboard management.
 */

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { pickRandom } = require("../public/whiteboard/utils");

/**
 * Extracts user credentials from request headers.
 * 
 * @param {import("firebase-functions/v2/https").Request} req
 * @returns {Promise<import("firebase-admin/auth").DecodedIdToken>} User profile of the
 * caller.
 */
async function requireAuth(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    throw new Error("Missing auth token.");
  }
  return admin.auth().verifyIdToken(match[1]);
}

/**
 * Ensures whiteboard name is in a valid form: alpha-numeric with underscores,
 * between 3 and 20 characters in length.
 * 
 * @param {string} name Whiteboard name input.
 * @returns {boolean} True if the username is valid.
 */
function validWhiteboardName(name) {
  return name.length >= 3 && name.length <= 40;
}

exports.createWhiteboard = onRequest(async (req, res) => {
    try {
        // Ensure protocol
        if (req.method !== "POST") {
            res.status(405).json({ error: "POST only" });
            return;
        }

        const user = await requireAuth(req);
        const { name } = req.body || {};

        if (!name) throw new Error("Missing whiteboard name");
        if (!validWhiteboardName(name)) throw new Error("Invalid whiteboard name: must be between 3 and 40 characters");

        const db = admin.firestore();
        const wbRef = db.collection('whiteboards').doc();
        const memberRef = db.doc(`whiteboards/${wbRef.id}/members/${user.uid}`);
        const userRef = db.doc(`users/${user.uid}`);

        await db.runTransaction(async (tx) => {
            const [wbSnap, userSnap] = await Promise.all([
                tx.get(wbRef),
                tx.get(userRef),
            ]);
    
            if (wbSnap.exists) throw new Error("Whiteboard already exists");
            if (!userSnap.exists) throw new Error("Could not find user");
    
            const userData = userSnap.data();

            // Create whiteboard document
            tx.set(wbRef, {
                name,
                owner: user.uid,
                members: [user.uid],
                mods: [],
                createdAt: FieldValue.serverTimestamp()
            });

            // Add whiteboard ID to user's whiteboard list
            tx.update(userRef, {
                joinedWhiteboards: FieldValue.arrayUnion(wbRef.id),
                updatedAt: FieldValue.serverTimestamp(),
            });

            // Create member document
            tx.set(memberRef, {
                username: userData.username,
                role: 'owner'
            })
        });

        res.json({ ok: true, whiteboardID: wbRef.id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

exports.deleteWhiteboard = onRequest(async (req, res) => {
    try {
        // Ensure protocol
        if (req.method !== "POST") {
            res.status(405).json({ error: "POST only" });
            return;
        }

        const user = await requireAuth(req);
        const { whiteboardID } = req.body || {};

        if (!whiteboardID) throw new Error("Missing whiteboardID");

        const db = admin.firestore();
        const wbRef = db.doc(`whiteboards/${whiteboardID}`);
        const wbSnap = await wbRef.get();

        if (!wbSnap.exists) throw new Error("Whiteboard not found");

        const wb = wbSnap.data();

        // Ensure calling user is allowed to delete whiteboard
        if (wb.owner !== user.uid) throw new Error("Only the owner can delete this whiteboard");

        // Delete files
        const storage = admin.storage().bucket();
        const filesSnap = await wbRef.collection('files').get();
        await Promise.all(filesSnap.docs.map(async (doc) => {
            await storage.file(doc.data().storagePath).delete(
                { ignoreNotFound: true }
            );
        }));

        // Remove whiteboard ID from each member's docs
        await Promise.all(wb.members.map(async (uid) => {
            await db.doc(`users/${uid}`).update({
                joinedWhiteboards: FieldValue.arrayRemove(whiteboardID),
                updatedAt: FieldValue.serverTimestamp()
            })
        }));

        // Delete all sub-collection documents (otherwise they become orphaned)
        const subcollections = ["items", "group-chat", "join-requests", "members", 'ai-chat', 'files'];
        await Promise.all(subcollections.map(async (name) => {
            const snap = await wbRef.collection(name).get();
            const batches = [];
            let batch = db.batch();
            let count = 0;
            for (const doc of snap.docs) {
                batch.delete(doc.ref);
                if (++count === 500) {
                    batches.push(batch.commit());
                    batch = db.batch();
                    count = 0;
                }
            }
            if (count > 0) batches.push(batch.commit());
            await Promise.all(batches);
        }));

        // Delete whiteboard
        await wbRef.delete();

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

exports.leaveWhiteboard = onRequest(async (req, res) => {
    try {
        if (req.method !== "POST") {
            res.status(405).json({ error: "POST only" });
            return;
        }

        const user = await requireAuth(req);
        const { whiteboardID } = req.body || {};

        if (!whiteboardID) throw new Error("Missing whiteboardID");

        const db = admin.firestore();
        const wbRef = db.doc(`whiteboards/${whiteboardID}`);
        const memberRef = db.doc(`whiteboards/${whiteboardID}/members/${user.uid}`);
        const userRef = db.doc(`users/${user.uid}`);

        await db.runTransaction(async (tx) => {
            const wbSnap = await tx.get(wbRef);

            if (!wbSnap.exists) throw new Error("Whiteboard not found");

            const wb = wbSnap.data();

            if (!wb.members.includes(user.uid)) throw new Error("You are not a member of this whiteboard");
            
            // If owner leaves, choose new owner first
            if (wb.owner === user.uid) {
                if (wb.members.length === 1) throw new Error("Owner cannot leave as the only member. Delete the whiteboard instead.");
                
                // Pick a random mod if there are any
                if (wb.mods.length > 0) {
                    const newOwner = pickRandom(wb.mods);

                    tx.update(wbRef, {
                        mods: FieldValue.arrayRemove(newOwner),
                        owner: newOwner
                    });

                    tx.update(db.doc(`whiteboards/${whiteboardID}/members/${newOwner}`), {
                        role: 'owner'
                    });
                }
                // Otherwise, pick a random member
                else {
                    const newOwner = pickRandom(wb.members.filter(id => id !== user.uid));

                    tx.update(wbRef, {
                        owner: newOwner
                    });

                    tx.update(db.doc(`whiteboards/${whiteboardID}/members/${newOwner}`), {
                        role: 'owner'
                    });
                }
            }

            // Remove member from whiteboard
            tx.update(wbRef, {
                members: FieldValue.arrayRemove(user.uid),
                mods: FieldValue.arrayRemove(user.uid),
            });

            // Remove whiteboard from user's whiteboard list
            tx.update(userRef, {
                joinedWhiteboards: FieldValue.arrayRemove(whiteboardID),
                updatedAt: FieldValue.serverTimestamp(),
            });

            // Remove member document
            tx.delete(memberRef);
        });

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

exports.addUserToWhiteboard = onRequest(async (req, res) => {
    try {
        // Ensure protocol
        if (req.method !== "POST") {
            res.status(405).json({ error: "POST only" });
            return;
        }

        const user = await requireAuth(req);

        // Verify parameters
        const { whiteboardID, userID } = req.body || {};
        if (!whiteboardID) throw new Error("Missing whiteboardID");
        if (!userID) throw new Error("Missing userID");

        const db = admin.firestore();
        const wbRef = db.doc(`whiteboards/${whiteboardID}`);
        const memberRef = db.doc(`whiteboards/${whiteboardID}/members/${userID}`);
        const userRef = db.doc(`users/${userID}`);

        await db.runTransaction(async (tx) => {
            const [wbSnap, userSnap] = await Promise.all([
                tx.get(wbRef),
                tx.get(userRef),
            ]);
    
            if (!wbSnap.exists) throw new Error("Whiteboard does not exist");
            if (!userSnap.exists) throw new Error("User does not exist");

            const wbData = wbSnap.data();
            const userData = userSnap.data();

            if (wbData.members.includes(userID)) throw new Error("User is already a member of the whiteboard");
    
            // Add user to whiteboard
            tx.update(wbRef, {
                members: FieldValue.arrayUnion(userID)
            });

            // Add whiteboard ID to user's whiteboard list
            tx.update(userRef, {
                joinedWhiteboards: FieldValue.arrayUnion(wbRef.id),
                updatedAt: FieldValue.serverTimestamp(),
            });

            // Add member record
            tx.set(memberRef, {
                username: userData.username,
                role: 'member'
            });
        });

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

exports.setUserRole = onRequest(async (req, res) => {
    try {
        if (req.method !== "POST") {
            res.status(405).json({ error: "POST only" });
            return;
        }

        const user = await requireAuth(req);
        const { whiteboardID, userID, role } = req.body || {};

        if (!whiteboardID) throw new Error("Missing whiteboardID");
        if (!userID) throw new Error("Missing userID");
        if (!['mod', 'member', 'owner'].includes(role)) throw new Error("Invalid role");

        const db = admin.firestore();
        const wbRef = db.doc(`whiteboards/${whiteboardID}`);
        const memberRef = db.doc(`whiteboards/${whiteboardID}/members/${userID}`);

        await db.runTransaction(async (tx) => {
            const [wbSnap, memberSnap] = await Promise.all([
                tx.get(wbRef),
                tx.get(memberRef),
            ]);

            if (!wbSnap.exists) throw new Error("Whiteboard not found");
            if (!memberSnap.exists) throw new Error("User does not have a member document");

            const wb = wbSnap.data();
            if (!wb.members.includes(userID)) throw new Error("User is not a member of this whiteboard")

            // Handle mod self-demotion (if owner wants to self-demote, they 
            // should assign ownership to another member)
            if (user.uid === userID) {
                if (!wb.mods.includes(userID) || role !== 'member') throw new Error("Invalid self-assignment: only moderators can demote themselves to members");

                tx.update(wbRef, {
                    mods: FieldValue.arrayRemove(userID),
                });
                tx.update(memberRef, { role });
            }
            // Only valid for owners demoting moderators
            else if (role === 'member') {
                if (user.uid !== wb.owner) throw new Error("Member can only be assigned by an owner who is demoting a mod");
                if (!wb.mods.includes(userID)) throw new Error("Only moderators can be demoted to members");

                // Remove user from mod list
                tx.update(wbRef, {
                    mods: FieldValue.arrayRemove(userID),
                });
                tx.update(memberRef, { role });
            }
            // For mods/owners promoting members
            else if (role === 'mod') {
                if (user.uid !== wb.owner && !wb.mods.includes(user.uid)) throw new Error("Caller does not have permission to assign mods");
                if (userID === wb.owner || wb.mods.includes(userID)) throw new Error("Promoted member must not be a mod or owner");

                tx.update(wbRef, {
                    mods: FieldValue.arrayUnion(userID),
                });
                tx.update(memberRef, { role });
            }
            // Only the current owner can give this to other users
            else if (role === 'owner') {
                if (user.uid !== wb.owner) throw new Error("Only owner can transfer ownership");

                // Make sure when a mod is promoted to an owner, they are removed
                // from the mods list.
                const newMods = wb.mods.filter(id => id !== userID);
                if (!newMods.includes(user.uid)) newMods.push(user.uid);

                // Promote member to owner
                tx.update(wbRef, { mods: newMods, owner: userID });

                // Update member records
                tx.update(db.doc(`whiteboards/${whiteboardID}/members/${user.uid}`), {
                    role: 'mod'
                });
                tx.update(memberRef, { role });
            }
        });

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

