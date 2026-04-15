import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const PROJECT_ID = 'demo-collaborative-whiteboard';
const BOARD_ID = 'board-1';

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// ---- Helpers ----

const db = (uid) => testEnv.authenticatedContext(uid).firestore();
const anonDb = () => testEnv.unauthenticatedContext().firestore();

async function seedBoard(data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `whiteboards/${BOARD_ID}`), data);
  });
}

async function seedItem(itemId, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), `whiteboards/${BOARD_ID}/items/${itemId}`),
      data,
    );
  });
}

const baseBoard = {
  name: 'Test Board',
  owner: 'alice',
  mods: ['bob'],
  members: ['alice', 'bob', 'charlie'],
  pendingRequests: false,
};

const baseItem = {
  createdBy: 'alice',
  updatedBy: 'alice',
  type: 'rect',
  transform: { x: 0, y: 0 },
  data: { color: 'red' },
  isLocked: false,
};

// ---- Tests ----

describe('users', () => {
  it('unauthenticated user cannot read a user doc', async () => {
    await assertFails(getDoc(doc(anonDb(), 'users/alice')));
  });

  it('user can read and write their own user doc', async () => {
    await assertSucceeds(
      setDoc(doc(db('alice'), 'users/alice'), { name: 'Alice' }),
    );
    await assertSucceeds(getDoc(doc(db('alice'), 'users/alice')));
  });

  it('user cannot read another user doc', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users/alice'), { name: 'Alice' });
    });
    await assertFails(getDoc(doc(db('bob'), 'users/alice')));
  });

  it('user cannot read another user private doc', async () => {
    await assertFails(getDoc(doc(db('bob'), 'users/alice/private/openai')));
  });
});

describe('whiteboards: create', () => {
  it('unauthenticated user cannot create a whiteboard', async () => {
    await assertFails(
      setDoc(doc(anonDb(), 'whiteboards/new'), { ...baseBoard }),
    );
  });

  it('signed-in user can create a board with themselves as owner', async () => {
    await assertSucceeds(
      setDoc(doc(db('alice'), 'whiteboards/new'), {
        ...baseBoard,
        owner: 'alice',
      }),
    );
  });

  it('signed-in user cannot create a board claiming another user as owner', async () => {
    await assertFails(
      setDoc(doc(db('alice'), 'whiteboards/new'), {
        ...baseBoard,
        owner: 'bob',
      }),
    );
  });
});

describe('whiteboards: read', () => {
  it('any signed-in user can read board metadata', async () => {
    await seedBoard(baseBoard);
    await assertSucceeds(
      getDoc(doc(db('stranger'), `whiteboards/${BOARD_ID}`)),
    );
  });

  it('unauthenticated user cannot read board metadata', async () => {
    await seedBoard(baseBoard);
    await assertFails(getDoc(doc(anonDb(), `whiteboards/${BOARD_ID}`)));
  });
});

describe('whiteboards: update', () => {
  it('owner can rename the board', async () => {
    await seedBoard(baseBoard);
    await assertSucceeds(
      updateDoc(doc(db('alice'), `whiteboards/${BOARD_ID}`), {
        name: 'Renamed',
      }),
    );
  });

  it('mod can rename the board', async () => {
    await seedBoard(baseBoard);
    await assertSucceeds(
      updateDoc(doc(db('bob'), `whiteboards/${BOARD_ID}`), {
        name: 'Renamed',
      }),
    );
  });

  it('mod cannot change the owner', async () => {
    await seedBoard(baseBoard);
    await assertFails(
      updateDoc(doc(db('bob'), `whiteboards/${BOARD_ID}`), { owner: 'bob' }),
    );
  });

  it('mod cannot demote another mod', async () => {
    await seedBoard({ ...baseBoard, mods: ['bob', 'dave'] });
    await assertFails(
      updateDoc(doc(db('bob'), `whiteboards/${BOARD_ID}`), { mods: ['bob'] }),
    );
  });

  it('mod can remove themselves from mods', async () => {
    await seedBoard(baseBoard);
    await assertSucceeds(
      updateDoc(doc(db('bob'), `whiteboards/${BOARD_ID}`), { mods: [] }),
    );
  });

  it('regular member cannot update the board', async () => {
    await seedBoard(baseBoard);
    await assertFails(
      updateDoc(doc(db('charlie'), `whiteboards/${BOARD_ID}`), {
        name: 'Renamed',
      }),
    );
  });
});

describe('whiteboards: delete', () => {
  it('owner can delete the board', async () => {
    await seedBoard(baseBoard);
    await assertSucceeds(
      deleteDoc(doc(db('alice'), `whiteboards/${BOARD_ID}`)),
    );
  });

  it('mod cannot delete the board', async () => {
    await seedBoard(baseBoard);
    await assertFails(deleteDoc(doc(db('bob'), `whiteboards/${BOARD_ID}`)));
  });
});

describe('items subcollection', () => {
  beforeEach(async () => {
    await seedBoard(baseBoard);
  });

  it('member can read items', async () => {
    await seedItem('item-1', baseItem);
    await assertSucceeds(
      getDoc(doc(db('charlie'), `whiteboards/${BOARD_ID}/items/item-1`)),
    );
  });

  it('non-member cannot read items', async () => {
    await seedItem('item-1', baseItem);
    await assertFails(
      getDoc(doc(db('stranger'), `whiteboards/${BOARD_ID}/items/item-1`)),
    );
  });

  it('member can create a well-formed item as themselves', async () => {
    await assertSucceeds(
      setDoc(
        doc(db('charlie'), `whiteboards/${BOARD_ID}/items/new-item`),
        { ...baseItem, createdBy: 'charlie', updatedBy: 'charlie' },
      ),
    );
  });

  it('member cannot create an item with a forged createdBy', async () => {
    await assertFails(
      setDoc(
        doc(db('charlie'), `whiteboards/${BOARD_ID}/items/new-item`),
        { ...baseItem, createdBy: 'alice', updatedBy: 'charlie' },
      ),
    );
  });

  it('non-member cannot create an item', async () => {
    await assertFails(
      setDoc(
        doc(db('stranger'), `whiteboards/${BOARD_ID}/items/new-item`),
        { ...baseItem, createdBy: 'stranger', updatedBy: 'stranger' },
      ),
    );
  });

  it('locked item cannot be updated by a non-locker member', async () => {
    await seedItem('locked-item', {
      ...baseItem,
      updatedBy: 'alice',
      isLocked: true,
    });
    await assertFails(
      updateDoc(
        doc(db('charlie'), `whiteboards/${BOARD_ID}/items/locked-item`),
        { updatedBy: 'charlie' },
      ),
    );
  });

  it('owner can update a locked item regardless of locker', async () => {
    await seedItem('locked-item', {
      ...baseItem,
      updatedBy: 'charlie',
      isLocked: true,
    });
    await assertSucceeds(
      updateDoc(
        doc(db('alice'), `whiteboards/${BOARD_ID}/items/locked-item`),
        { updatedBy: 'alice' },
      ),
    );
  });
});

describe('join-requests', () => {
  beforeEach(async () => {
    await seedBoard(baseBoard);
  });

  it('user can create a join request for themselves', async () => {
    await assertSucceeds(
      setDoc(
        doc(db('stranger'), `whiteboards/${BOARD_ID}/join-requests/stranger`),
        { userID: 'stranger', whiteboardID: BOARD_ID },
      ),
    );
  });

  it('user cannot create a join request as someone else', async () => {
    await assertFails(
      setDoc(
        doc(db('stranger'), `whiteboards/${BOARD_ID}/join-requests/other`),
        { userID: 'other', whiteboardID: BOARD_ID },
      ),
    );
  });

  it('owner can delete any join request', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(
          ctx.firestore(),
          `whiteboards/${BOARD_ID}/join-requests/stranger`,
        ),
        { userID: 'stranger' },
      );
    });
    await assertSucceeds(
      deleteDoc(
        doc(db('alice'), `whiteboards/${BOARD_ID}/join-requests/stranger`),
      ),
    );
  });
});

describe('default deny', () => {
  it('unmatched top-level path is denied', async () => {
    await assertFails(
      setDoc(doc(db('alice'), 'randomCollection/doc1'), { foo: 'bar' }),
    );
  });
});
