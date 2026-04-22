import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';

// These are hoisted - firestore.js will get the mocked versions when it imports them
vi.mock('../public/whiteboard/auth.js', () => ({ currentUser: vi.fn() }));
vi.mock('../public/whiteboard/utils.js', () => ({ pickRandom: vi.fn() }));

// ---- Shared mock objects (wired up in beforeAll) ----
let mockDocSet, mockDocGet, mockDocUpdate, mockDocDelete;
let mockCollectionGet;
let mockRunTransaction;
let mockArrayUnion, mockServerTimestamp;
let mockSubDocRef, mockSubCollection, mockDocRef, mockAutoDocRef;
let mockCollectionRef, mockDb;

// The imported module and mock fn references
let mod, mockCurrentUser, mockPickRandom;

beforeAll(async () => {
  // Grab references to the mocked functions so tests can configure them
  const authMod = await import('../public/whiteboard/auth.js');
  const utilsMod = await import('../public/whiteboard/utils.js');
  mockCurrentUser = authMod.currentUser;
  mockPickRandom = utilsMod.pickRandom;

  // Create all mock fns
  mockDocSet = vi.fn();
  mockDocGet = vi.fn();
  mockDocUpdate = vi.fn();
  mockDocDelete = vi.fn();
  mockCollectionGet = vi.fn();
  mockRunTransaction = vi.fn();
  mockArrayUnion = vi.fn();
  mockServerTimestamp = vi.fn();

  // Build the Firestore chain mock objects
  mockSubDocRef = {
    id: 'sub-doc-id',
    set: mockDocSet,
    get: mockDocGet,
    delete: mockDocDelete,
  };

  mockSubCollection = {
    doc: vi.fn(),
    get: mockCollectionGet,
  };

  mockDocRef = {
    id: 'test-doc-id',
    set: mockDocSet,
    get: mockDocGet,
    update: mockDocUpdate,
    delete: mockDocDelete,
    collection: vi.fn(),
  };

  // Auto-ID doc ref returned when .doc() is called with no argument (e.g. createWhiteboard)
  mockAutoDocRef = {
    id: 'auto-generated-id',
    set: mockDocSet,
  };

  mockCollectionRef = {
    doc: vi.fn(),
    where: vi.fn(),
    get: mockCollectionGet,
  };

  mockDb = {
    collection: vi.fn(),
    runTransaction: mockRunTransaction,
  };

  // Set up window.firebase BEFORE importing firestore.js so the module-level
  // `const db = window.firebase.firestore()` call resolves to our mock
  window.firebase = {
    firestore: Object.assign(vi.fn(() => mockDb), {
      FieldValue: {
        serverTimestamp: mockServerTimestamp,
        arrayUnion: mockArrayUnion,
      },
    }),
  };

  // Dynamic import — module is evaluated here, after window.firebase is ready
  mod = await import('../public/whiteboard/firestore.js');
});

beforeEach(() => {
  // Reset all mock state and re-apply default implementations
  vi.resetAllMocks();

  // Default resolved values for write operations
  mockDocSet.mockResolvedValue(undefined);
  mockDocUpdate.mockResolvedValue(undefined);
  mockDocDelete.mockResolvedValue(undefined);

  // FieldValue helpers
  mockServerTimestamp.mockReturnValue('SERVER_TIMESTAMP');
  mockArrayUnion.mockImplementation((...args) => ({ _type: 'arrayUnion', elements: args }));

  // Restore Firestore chain routing
  mockDb.collection.mockReturnValue(mockCollectionRef);
  mockCollectionRef.doc.mockImplementation(id => id !== undefined ? mockDocRef : mockAutoDocRef);
  mockCollectionRef.where.mockReturnValue({ get: mockCollectionGet });
  mockDocRef.collection.mockReturnValue(mockSubCollection);
  mockSubCollection.doc.mockReturnValue(mockSubDocRef);
});

// ---- Helpers ----

function makeDocSnap(data, id = 'test-doc-id', exists = true) {
  return { exists, id, data: () => data };
}

function makeCollSnap(docs) {
  return { docs: docs.map(({ id, data }) => ({ id, data: () => data })) };
}

// ---- Tests ----

describe('createWhiteboard', () => {
  it('writes the correct fields to a new document', async () => {
    await mod.createWhiteboard('user-1', 'My Board');
    expect(mockDocSet).toHaveBeenCalledWith({
      name: 'My Board',
      members: ['user-1'],
      mods: [],
      owner: 'user-1'
    });
  });

  it('returns the auto-generated document id', async () => {
    const id = await mod.createWhiteboard('user-1', 'My Board');
    expect(id).toBe('auto-generated-id');
  });
});

describe('getWhiteboardById', () => {
  it('returns the whiteboard data when the document exists', async () => {
    const data = { name: 'Test Board', members: ['u1'], mods: [], owner: 'u1' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(data, 'board-1'));

    const result = await mod.getWhiteboardById('board-1');

    expect(result).toMatchObject({ id: 'board-1', name: 'Test Board', owner: 'u1' });
  });

  it('throws when the document does not exist', async () => {
    mockDocGet.mockResolvedValueOnce(makeDocSnap(null, 'board-1', false));

    await expect(mod.getWhiteboardById('board-1')).rejects.toThrow('Could not find whiteboard board-1');
  });
});

describe('deleteWhiteboard', () => {
  it('deletes the correct document', async () => {
    await mod.deleteWhiteboard('board-1');

    expect(mockCollectionRef.doc).toHaveBeenCalledWith('board-1');
    expect(mockDocDelete).toHaveBeenCalled();
  });
});

describe('getJoinedWhiteboards', () => {
  it('queries whiteboards where the current user is a member', async () => {
    mockCurrentUser.mockReturnValue({ uid: 'user-1' });
    mockCollectionGet.mockResolvedValueOnce(
      makeCollSnap([{ id: 'board-1', data: { name: 'Board 1', members: ['user-1'] } }])
    );

    const result = await mod.getJoinedWhiteboards();

    expect(mockCollectionRef.where).toHaveBeenCalledWith('members', 'array-contains', 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'board-1', name: 'Board 1' });
  });

  it('throws if the user is not signed in', async () => {
    mockCurrentUser.mockReturnValue(null);

    await expect(mod.getJoinedWhiteboards()).rejects.toThrow('User not signed in');
  });
});

describe('requestToJoinWhiteboard', () => {
  it('writes a join request to the correct subcollection', async () => {
    mockCurrentUser.mockReturnValue({ uid: 'user-1' });

    await mod.requestToJoinWhiteboard('board-1');

    expect(mockCollectionRef.doc).toHaveBeenCalledWith('board-1');
    expect(mockSubCollection.doc).toHaveBeenCalledWith('user-1');
    expect(mockDocSet).toHaveBeenCalledWith({
      userID: 'user-1',
      timestamp: 'SERVER_TIMESTAMP',
      whiteboardID: 'board-1',
    });
  });

  it('throws if the user is not signed in', async () => {
    mockCurrentUser.mockReturnValue(null);

    await expect(mod.requestToJoinWhiteboard('board-1')).rejects.toThrow('User is not signed in');
  });
});

describe('getPendingJoinRequests', () => {
  const user = { uid: 'owner-1' };
  const whiteboards = [
    { id: 'board-1', owner: 'owner-1', mods: [], members: ['owner-1', 'user-2'], name: 'Board 1' },
    { id: 'board-2', owner: 'user-2', mods: ['owner-1'], members: ['user-2', 'owner-1'], name: 'Board 2' },
    { id: 'board-3', owner: 'user-2', mods: [], members: ['user-2', 'owner-1'], name: 'Board 3' },
  ];

  it('returns join requests for boards the user owns', async () => {
    mockCurrentUser.mockReturnValue(user);
    mockCollectionGet
      .mockResolvedValueOnce(makeCollSnap([{ id: 'req-1', data: { userID: 'req-1' } }]))
      .mockResolvedValueOnce(makeCollSnap([])); // board-2 (mod)

    const result = await mod.getPendingJoinRequests(whiteboards.slice(0, 2));

    expect(result).toContainEqual({ whiteboardID: 'board-1', userID: 'req-1', whiteboardName: 'Board 1' });
  });

  it('returns join requests for boards the user moderates', async () => {
    mockCurrentUser.mockReturnValue(user);
    mockCollectionGet
      .mockResolvedValueOnce(makeCollSnap([])) // board-1 (owner)
      .mockResolvedValueOnce(makeCollSnap([{ id: 'req-2', data: { userID: 'req-2' } }]));

    const result = await mod.getPendingJoinRequests(whiteboards.slice(0, 2));

    expect(result).toContainEqual({ whiteboardID: 'board-2', userID: 'req-2', whiteboardName: 'Board 2' });
  });

  it('returns an empty array when the user neither owns nor moderates any board', async () => {
    mockCurrentUser.mockReturnValue({ uid: 'regular-member' });

    const result = await mod.getPendingJoinRequests(whiteboards);

    expect(result).toEqual([]);
    expect(mockCollectionGet).not.toHaveBeenCalled();
  });

  it('throws if the user is not signed in', async () => {
    mockCurrentUser.mockReturnValue(null);

    await expect(mod.getPendingJoinRequests(whiteboards)).rejects.toThrow('User is not signed in');
  });
});

describe('acceptJoinRequest', () => {
  it('deletes the join request and adds the user to members inside a transaction', async () => {
    const mockTransaction = {
      get: vi.fn().mockResolvedValue(makeDocSnap({ userID: 'user-2' })),
      delete: vi.fn(),
      update: vi.fn(),
    };
    mockRunTransaction.mockImplementation(fn => fn(mockTransaction));

    await mod.acceptJoinRequest('board-1', 'user-2');

    expect(mockTransaction.delete).toHaveBeenCalled();
    expect(mockTransaction.update).toHaveBeenCalledWith(
      expect.anything(),
      { members: { _type: 'arrayUnion', elements: ['user-2'] } }
    );
  });

  it('throws if the join request does not exist', async () => {
    const mockTransaction = {
      get: vi.fn().mockResolvedValue(makeDocSnap(null, 'x', false)),
      delete: vi.fn(),
      update: vi.fn(),
    };
    mockRunTransaction.mockImplementation(fn => fn(mockTransaction));

    await expect(mod.acceptJoinRequest('board-1', 'user-2')).rejects.toThrow('Join request not found');
  });
});

describe('rejectJoinRequest', () => {
  it('deletes the join request document', async () => {
    await mod.rejectJoinRequest('board-1', 'user-2');

    expect(mockSubCollection.doc).toHaveBeenCalledWith('user-2');
    expect(mockDocDelete).toHaveBeenCalled();
  });
});

describe('addUserToWhiteboard', () => {
  it('updates the members field with arrayUnion', async () => {
    await mod.addUserToWhiteboard('board-1', 'user-2');

    expect(mockDocUpdate).toHaveBeenCalledWith({
      members: { _type: 'arrayUnion', elements: ['user-2'] },
    });
  });
});

describe('promoteToMod', () => {
  it('adds the user to the mods array', async () => {
    const board = { name: 'B', members: ['owner', 'user-2'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await mod.promoteToMod('board-1', 'user-2');

    expect(mockDocUpdate).toHaveBeenCalledWith({ mods: ['user-2'] });
  });

  it('throws if the user is not a member', async () => {
    const board = { name: 'B', members: ['owner'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await expect(mod.promoteToMod('board-1', 'outsider')).rejects.toThrow('not a member');
  });

  it('throws if the user is already a mod', async () => {
    const board = { name: 'B', members: ['owner', 'mod-1'], mods: ['mod-1'], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await expect(mod.promoteToMod('board-1', 'mod-1')).rejects.toThrow('already privileged');
  });

  it('throws if the user is the owner', async () => {
    const board = { name: 'B', members: ['owner'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await expect(mod.promoteToMod('board-1', 'owner')).rejects.toThrow('already privileged');
  });
});

describe('transferOwnership', () => {
  it('sets the new owner and demotes the old owner to a mod', async () => {
    const board = { name: 'B', members: ['owner', 'user-2'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await mod.transferOwnership('board-1', 'user-2');

    expect(mockDocUpdate).toHaveBeenCalledWith({ owner: 'user-2', mods: ['owner'] });
  });

  it('removes the new owner from the mods list if they were already a mod', async () => {
    const board = { name: 'B', members: ['owner', 'mod-1'], mods: ['mod-1'], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await mod.transferOwnership('board-1', 'mod-1');

    // mod-1 leaves mods, owner joins mods
    expect(mockDocUpdate).toHaveBeenCalledWith({ owner: 'mod-1', mods: ['owner'] });
  });

  it('throws if the user is not a member', async () => {
    const board = { name: 'B', members: ['owner'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await expect(mod.transferOwnership('board-1', 'outsider')).rejects.toThrow('not a member');
  });

  it('throws if the user is already the owner', async () => {
    const board = { name: 'B', members: ['owner'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));

    await expect(mod.transferOwnership('board-1', 'owner')).rejects.toThrow('already the owner');
  });
});

describe('leaveWhiteboard', () => {
  it('throws if the user is not signed in', async () => {
    mockCurrentUser.mockReturnValue(null);

    await expect(mod.leaveWhiteboard('board-1')).rejects.toThrow('User not signed in');
  });

  it('deletes the whiteboard when the leaving user is the only member', async () => {
    mockCurrentUser.mockReturnValue({ uid: 'owner' });
    mockDocGet.mockResolvedValueOnce(makeDocSnap({
      name: 'B',
      members: ['owner'],
      mods: [],
      owner: 'owner'
    }, 'board-1'));

    await mod.leaveWhiteboard('board-1');

    expect(mockDocUpdate).not.toHaveBeenCalled();
    expect(mockDocDelete).toHaveBeenCalled();
  });

  it('transfers ownership to a random mod when the owner leaves and mods exist', async () => {
    mockCurrentUser.mockReturnValue({ uid: 'owner' });
    const board = { name: 'B', members: ['owner', 'mod-1', 'user-2'], mods: ['mod-1'], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));
    mockPickRandom.mockReturnValue('mod-1');

    await mod.leaveWhiteboard('board-1');

    expect(mockDocUpdate).toHaveBeenCalledWith({
      members: ['mod-1', 'user-2'],
      owner: 'mod-1',
      mods: [],
    });

  });

  it('transfers ownership to a random member when the owner leaves with no mods', async () => {
    mockCurrentUser.mockReturnValue({ uid: 'owner' });
    const board = { name: 'B', members: ['owner', 'user-2'], mods: [], owner: 'owner' };
    mockDocGet.mockResolvedValueOnce(makeDocSnap(board, 'board-1'));
    mockPickRandom.mockReturnValue('user-2');

    await mod.leaveWhiteboard('board-1');

    expect(mockDocUpdate).toHaveBeenCalledWith({
      members: ['user-2'],
      owner: 'user-2'
    });
  });
});
