export class OverlayManager {
  /**
   * @param {Record<string, { mount: Function, setOpen: Function, isOpen: Function }>} modules
   */
  constructor(modules) {
    this.modules = modules;
    this.toggles = [];
  }

  mount() {
    for (const module of Object.values(this.modules)) {
      module.mount();
    }

    const toggleButtons = document.querySelectorAll("[data-overlay-target]");
    for (const btn of toggleButtons) {
      const handler = () => {
        const target = btn.dataset.overlayTarget;
        if (!target || !this.modules[target]) return;
        const panel = this.modules[target];
        panel.setOpen(!panel.isOpen());
      };
      btn.addEventListener("click", handler);
      this.toggles.push({ btn, handler });
    }

    const closeButtons = document.querySelectorAll("[data-overlay-close]");
    for (const btn of closeButtons) {
      const handler = () => {
        const target = btn.dataset.overlayClose;
        if (!target || !this.modules[target]) return;
        this.modules[target].setOpen(false);
      };
      btn.addEventListener("click", handler);
      this.toggles.push({ btn, handler });
    }
  }

  destroy() {
    for (const { btn, handler } of this.toggles) {
      btn.removeEventListener("click", handler);
    }
    this.toggles = [];
  }
}
