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
  }

  clear() {
    this.elementsById.clear();
  }

  /**
   * @returns {string}
   */
  createId() {
    return safeRandomUUID();
  }

  /**
   * Add an element. If `element.id` is missing, one is generated.
   * @param {any} element
   * @returns {any} the stored element reference
   */
  addElement(element) {
    const id = element.id || this.createId();
    const stored = {
      id,
      type: element.type,
      position: { x: element.position?.x ?? 0, y: element.position?.y ?? 0 },
      size: { w: element.size?.w ?? 1, h: element.size?.h ?? 1 },
      rotation: element.rotation ?? 0,
      style: element.style ? { ...element.style } : {},
      content: element.content ? { ...element.content } : {},
    };
    this.elementsById.set(id, stored);
    return stored;
  }

  getElement(id) {
    return this.elementsById.get(id);
  }

  /**
   * @param {string} id
   * @param {any} patch
   */
  updateElement(id, patch) {
    const current = this.elementsById.get(id);
    if (!current) return;

    const next = {
      ...current,
      type: patch.type ?? current.type,
      rotation: patch.rotation ?? current.rotation,
      position: patch.position ? deepMergeShallow(current.position, patch.position) : current.position,
      size: patch.size ? deepMergeShallow(current.size, patch.size) : current.size,
      style: patch.style ? deepMergeShallow(current.style, patch.style) : current.style,
      content: patch.content ? deepMergeShallow(current.content, patch.content) : current.content,
    };

    this.elementsById.set(id, next);
  }

  deleteElement(id) {
    this.elementsById.delete(id);
  }

  /**
   * @param {string[]} ids
   */
  deleteElements(ids) {
    for (const id of ids) this.elementsById.delete(id);
  }

  /**
   * @returns {any[]}
   */
  getAllElements() {
    return Array.from(this.elementsById.values());
  }

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

    this.clear();
    for (const el of nextElements) {
      // Keep provided ids for backend sync.
      this.addElement(el);
    }
  }
}

