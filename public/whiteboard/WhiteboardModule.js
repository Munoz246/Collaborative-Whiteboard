import { ElementStore } from "./elementStore.js";
import { FabricRenderer } from "./fabricRenderer.js";
import { InteractionController } from "./interactionController.js";

export class WhiteboardModule {
  /**
   * @param {object} config
   * @param {HTMLCanvasElement} config.canvasEl
   * @param {object} [config.ui]
   */
  constructor({ canvasEl, ui = {} }) {
    this.canvasEl = canvasEl;
    this.ui = ui;

    this.canvas = null;
    this.store = null;
    this.renderer = null;
    this.controller = null;
    this.resizeObserver = null;
    this.isInitialized = false;

    this._onWindowResize = this.resize.bind(this);
  }

  init() {
    const fabric = globalThis.fabric;
    if (!fabric || !fabric.Canvas) {
      throw new Error(
        "Fabric.js did not load. Check CDN access or network permissions (globalThis.fabric is missing).",
      );
    }
    if (!this.canvasEl) throw new Error("Missing canvas element for WhiteboardModule.");

    this.canvas = new fabric.Canvas(this.canvasEl, {
      preserveObjectStacking: true,
      selection: true,
      stopContextMenu: true,
    });

    this.store = new ElementStore();
    this.renderer = new FabricRenderer(this.canvas, this.store);
    this.controller = new InteractionController(this.canvas, this.store, this.renderer, this.ui);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvasEl);
    window.addEventListener("resize", this._onWindowResize);

    this.controller.init();
    this.isInitialized = true;
  }

  resize() {
    if (!this.canvas || !this.canvasEl) return;

    const prevVpt = this.canvas.viewportTransform ? [...this.canvas.viewportTransform] : [1, 0, 0, 1, 0, 0];
    const hostEl = this.canvasEl.parentElement;

    const desiredW = Math.max(1, Math.floor(window.innerWidth));
    const desiredH = Math.max(1, Math.floor(window.innerHeight));

    if (hostEl) {
      hostEl.style.width = `${desiredW}px`;
      hostEl.style.height = `${desiredH}px`;
    }

    this.canvasEl.style.width = `${desiredW}px`;
    this.canvasEl.style.height = `${desiredH}px`;
    this.canvasEl.style.flex = "0 0 auto";

    this.canvas.setDimensions({ width: desiredW, height: desiredH }, { cssOnly: false, backstoreOnly: false });
    this.canvas.setViewportTransform(prevVpt);
    this.canvas.calcOffset();
    this.canvas.requestRenderAll();
  }

  destroy() {
    if (!this.isInitialized) return;

    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this._onWindowResize);
    this.controller?.destroy?.();
    this.renderer?.destroy?.();
    this.canvas?.dispose?.();

    this.resizeObserver = null;
    this.controller = null;
    this.renderer = null;
    this.store = null;
    this.canvas = null;
    this.isInitialized = false;
  }
}
