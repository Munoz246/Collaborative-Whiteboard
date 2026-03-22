/**
 * Controls one overlay panel in the HUD (toolbar dock or floating sidebar).
 *
 * OverlayManager constructs several BaseOverlayPanel instances keyed by overlay name. Each panel
 * wraps a DOM root (by id); setOpen toggles CSS classes and aria-hidden for accessibility.
 */
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

  // =============================================================================
  // Mount — resolve the element from the page; apply initial open/closed state
  // =============================================================================

  mount() {
    this.rootEl = document.getElementById(this.rootId);
    if (!this.rootEl) {
      throw new Error(`Missing overlay root: #${this.rootId}`);
    }
    this.setOpen(this.defaultOpen);
  }

  // =============================================================================
  // Visibility — CSS classes drive layout; screen readers use aria-hidden
  // =============================================================================

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
