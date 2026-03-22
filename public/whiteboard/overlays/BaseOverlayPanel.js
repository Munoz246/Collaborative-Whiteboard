export class BaseOverlayPanel {
  /**
   * @param {string} rootId
   * @param {boolean} defaultOpen
   */
  constructor(rootId, defaultOpen = false) {
    this.rootId = rootId;
    this.defaultOpen = defaultOpen;
    this.rootEl = null;
  }

  mount() {
    this.rootEl = document.getElementById(this.rootId);
    if (!this.rootEl) {
      throw new Error(`Missing overlay root: #${this.rootId}`);
    }
    this.setOpen(this.defaultOpen);
  }

  setOpen(isOpen) {
    if (!this.rootEl) return;
    this.rootEl.classList.toggle("is-open", isOpen);
    this.rootEl.classList.toggle("is-closed", !isOpen);
    this.rootEl.setAttribute("aria-hidden", String(!isOpen));
  }

  isOpen() {
    return !!this.rootEl?.classList.contains("is-open");
  }
}
