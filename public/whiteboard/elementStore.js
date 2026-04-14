/**
 * In-memory model for everything drawn on the whiteboard (shapes, text, pen paths).
 *
 * FabricRenderer and InteractionController read/write this store; it is the single source of
 * truth for positions, sizes, and styles. serialize() / applySerialized() use a simple JSON
 * shape so a future server can save and reload boards without changing the rest of the app.
 */

// =============================================================================
// Small helpers — ids and shallow merges used when patching nested fields
// =============================================================================

function safeRandomUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback: not cryptographically secure, but sufficient for local-only uniqueness.
  return "id-" + Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function deepMergeShallow(base, patch) {
  return { ...(base || {}), ...(patch || {}) };
}

export class ElementStore {
  constructor() {
    /** @type {Map<string, any>} */
    this.elementsById = new Map();
    /** @type {Set<(event: any) => void>} */
    this.subscribers = new Set();
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  emit(event) {
    for (const listener of this.subscribers) listener(event);
  }

  clear(options = {}) {
    const elementIds = Array.from(this.elementsById.keys());
    this.elementsById.clear();
    this.emit({
      kind: "cleared",
      elementIds,
      origin: options.origin ?? "local",
      persist: options.persist ?? true,
    });
  }

  /**
   * @returns {string}
   */
  createId() {
    return safeRandomUUID();
  }

  // =============================================================================
  // CRUD — add, read, patch, delete elements by stable id
  // =============================================================================

  /**
   * Add an element. If `element.id` is missing, one is generated.
   * @param {any} element
   * @returns {any} the stored element reference
   */
  addElement(element, options = {}) {
    const id = element.id || this.createId();
    const stored = {
      id,
      type: element.type,
      position: { x: element.position?.x ?? 0, y: element.position?.y ?? 0 },
      size: { w: element.size?.w ?? 1, h: element.size?.h ?? 1 },
      rotation: element.rotation ?? 0,
      isLocked: !!element.isLocked,
      style: element.style ? { ...element.style } : {},
      content: element.content ? { ...element.content } : {},
    };
    this.elementsById.set(id, stored);
    this.emit({
      kind: "added",
      elementId: id,
      element: stored,
      origin: options.origin ?? "local",
      persist: options.persist ?? true,
    });
    return stored;
  }

  getElement(id) {
    return this.elementsById.get(id);
  }

  /**
   * @param {string} id
   * @param {any} patch
   */
  updateElement(id, patch, options = {}) {
    const current = this.elementsById.get(id);
    if (!current) return;

    const next = {
      ...current,
      type: patch.type ?? current.type,
      rotation: patch.rotation ?? current.rotation,
      isLocked: patch.isLocked ?? current.isLocked,
      position: patch.position ? deepMergeShallow(current.position, patch.position) : current.position,
      size: patch.size ? deepMergeShallow(current.size, patch.size) : current.size,
      style: patch.style ? deepMergeShallow(current.style, patch.style) : current.style,
      content: patch.content ? deepMergeShallow(current.content, patch.content) : current.content,
    };

    this.elementsById.set(id, next);
    this.emit({
      kind: "updated",
      elementId: id,
      element: next,
      previous: current,
      patch,
      origin: options.origin ?? "local",
      persist: options.persist ?? true,
    });
  }

  deleteElement(id, options = {}) {
    const previous = this.elementsById.get(id);
    if (!previous) return;
    this.elementsById.delete(id);
    this.emit({
      kind: "removed",
      elementId: id,
      previous,
      origin: options.origin ?? "local",
      persist: options.persist ?? true,
    });
  }

  /**
   * @param {string[]} ids
   */
  deleteElements(ids, options = {}) {
    for (const id of ids) this.deleteElement(id, options);
  }

  /**
   * @returns {any[]}
   */
  getAllElements() {
    return Array.from(this.elementsById.values());
  }

  // =============================================================================
  // Persistence shape — versioned payload for network or localStorage later
  // =============================================================================

  /**
   * Backend-friendly serialization (future-proofing).
   */
  serialize() {
    return {
      version: 1,
      elements: this.getAllElements(),
    };
  }

  /**
   * Replace the local state with backend-provided serialized elements.
   * @param {any} serialized
   */
  applySerialized(serialized) {
    const nextElements = serialized?.elements;
    if (!Array.isArray(nextElements)) return;

    this.clear({ origin: "remote", persist: false });
    for (const el of nextElements) {
      // Keep provided ids for backend sync.
      this.addElement(el, { origin: "remote", persist: false });
    }
  }

  upsertRemoteElement(element) {
    const existing = this.getElement(element.id);
    if (!existing) {
      this.addElement(element, { origin: "remote", persist: false });
      return;
    }
    this.updateElement(
      element.id,
      {
        type: element.type,
        position: element.position,
        size: element.size,
        rotation: element.rotation,
        style: element.style,
        content: element.content,
        isLocked: element.isLocked,
      },
      { origin: "remote", persist: false },
    );
  }

  removeRemoteElement(id) {
    this.deleteElement(id, { origin: "remote", persist: false });
  }
}
