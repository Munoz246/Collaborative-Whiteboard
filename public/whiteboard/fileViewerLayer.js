import {
  getFileDownloadUrl,
} from "./fileContentService.js";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value) || 1));
}

function ensureNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export class FileViewerLayer {
  constructor({ rootEl, store, canvas }) {
    this.rootEl = rootEl;
    this.store = store;
    this.canvas = canvas;
    this.viewerById = new Map();
    this.unsubscribe = null;
    this.canvasDisposers = [];
    this.lastViewportSnapshot = null;
    this._onStoreEvent = this.onStoreEvent.bind(this);
  }

  attach() {
    if (!this.rootEl || !this.store) return;
    const existing = this.store.getAllElements().filter((el) => el.type === "file");
    for (const element of existing) this.upsertViewer(element);
    this.unsubscribe = this.store.subscribe(this._onStoreEvent);
    if (this.canvas) {
      const sync = () => this.syncAllFromCanvasViewport();
      this.canvas.on("after:render", sync);
      this.canvas.on("mouse:wheel", sync);
      this.canvasDisposers.push(() => this.canvas?.off("after:render", sync));
      this.canvasDisposers.push(() => this.canvas?.off("mouse:wheel", sync));
    }
  }

  detach() {
    if (typeof this.unsubscribe === "function") this.unsubscribe();
    this.unsubscribe = null;
    for (const dispose of this.canvasDisposers) dispose();
    this.canvasDisposers = [];
    for (const id of Array.from(this.viewerById.keys())) this.removeViewer(id);
  }

  syncAllFromCanvasViewport() {
    const vpt = Array.isArray(this.canvas?.viewportTransform)
      ? this.canvas.viewportTransform.slice(0, 6)
      : null;
    const prev = this.lastViewportSnapshot;
    const viewportChanged = !!(prev && vpt && prev.some((value, idx) => Math.abs((vpt[idx] || 0) - (value || 0)) > 0.0001));
    if (prev && vpt && !viewportChanged) {
      return;
    }
    this.lastViewportSnapshot = vpt;
    for (const [id, view] of this.viewerById.entries()) {
      const element = this.store.getElement(id);
      if (!element) continue;
      this.updateViewer(view, element, { skipContentRefresh: true });
    }
  }

  onStoreEvent(event) {
    if (!event) return;
    if ((event.kind === "added" || event.kind === "updated") && event.element?.type === "file") {
      this.upsertViewer(event.element);
      return;
    }
    if (event.kind === "removed") this.removeViewer(event.elementId);
    if (event.kind === "cleared") {
      for (const id of event.elementIds || []) this.removeViewer(id);
    }
  }

  upsertViewer(element) {
    if (!element?.id) return;
    let view = this.viewerById.get(element.id);
    if (!view) {
      view = this.createViewer(element);
      this.viewerById.set(element.id, view);
    }
    this.updateViewer(view, element);
  }

  createViewer(element) {
    const shell = document.createElement("section");
    shell.className = "wb-file-viewer overlay-item";
    shell.dataset.elementId = element.id;

    const header = document.createElement("header");
    header.className = "wb-file-viewer__header";
    const title = document.createElement("span");
    title.className = "wb-file-viewer__title";
    const controls = document.createElement("div");
    controls.className = "wb-file-viewer__controls";

    const prevBtn = this.makeButton("Prev");
    const nextBtn = this.makeButton("Next");
    const pageIndicator = document.createElement("span");
    pageIndicator.className = "wb-file-viewer__page";
    const zoomOutBtn = this.makeButton("−");
    const zoomInBtn = this.makeButton("+");
    const zoomResetBtn = this.makeButton("100%");
    const downloadBtn = this.makeButton("Download");
    const minimizeBtn = this.makeButton("Min");
    const closeBtn = this.makeButton("Close");

    controls.append(
      prevBtn,
      pageIndicator,
      nextBtn,
      zoomOutBtn,
      zoomInBtn,
      zoomResetBtn,
      downloadBtn,
      minimizeBtn,
      closeBtn,
    );
    header.append(title, controls);

    const body = document.createElement("div");
    body.className = "wb-file-viewer__body";
    const status = document.createElement("div");
    status.className = "wb-file-viewer__status";
    const content = document.createElement("div");
    content.className = "wb-file-viewer__content";
    body.append(status, content);

    shell.append(header, body);
    this.rootEl.appendChild(shell);

    const view = {
      id: element.id,
      shell,
      title,
      pageIndicator,
      status,
      content,
      buttons: { prevBtn, nextBtn, zoomOutBtn, zoomInBtn, zoomResetBtn, downloadBtn, minimizeBtn, closeBtn },
      pdfDoc: null,
      textLoaded: false,
      contentLoadedForPath: "",
      renderSeq: 0,
      persistTimer: null,
    };

    prevBtn.addEventListener("click", () => this.adjustPage(view, -1));
    nextBtn.addEventListener("click", () => this.adjustPage(view, 1));
    zoomOutBtn.addEventListener("click", () => this.adjustZoom(view, -0.1));
    zoomInBtn.addEventListener("click", () => this.adjustZoom(view, 0.1));
    zoomResetBtn.addEventListener("click", () => this.setViewerState(view, { zoomLevel: 1 }, true));
    downloadBtn.addEventListener("click", () => this.download(view));
    minimizeBtn.addEventListener("click", () => this.toggleMinimize(view));
    closeBtn.addEventListener("click", () => this.closeViewer(view));

    return view;
  }

  makeButton(label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-file-viewer__btn";
    btn.textContent = label;
    return btn;
  }

  updateViewer(view, element, options = {}) {
    const x = ensureNumber(element.position?.x, 0);
    const y = ensureNumber(element.position?.y, 0);
    const w = Math.max(220, ensureNumber(element.size?.w, 420));
    const h = Math.max(220, ensureNumber(element.size?.h, 520));
    const rotation = ensureNumber(element.rotation, 0);
    const zoom = this.canvas?.getZoom ? this.canvas.getZoom() || 1 : 1;
    const vpt = this.canvas?.viewportTransform || [1, 0, 0, 1, 0, 0];
    const projectedLeft = (x * zoom) + (vpt[4] || 0);
    const projectedTop = (y * zoom) + (vpt[5] || 0);
    const projectedWidth = w * zoom;
    const projectedHeight = h * zoom;
    const screenWidth = projectedWidth;
    const screenHeight = projectedHeight;
    const screenLeft = projectedLeft;
    const screenTop = projectedTop;
    view.shell.style.left = `${screenLeft}px`;
    view.shell.style.top = `${screenTop}px`;
    view.shell.style.width = `${screenWidth}px`;
    view.shell.style.height = `${screenHeight}px`;
    view.shell.style.transform = `rotate(${rotation}deg)`;
    view.shell.classList.toggle("is-minimized", !!element.content?.minimized);
    view.title.textContent = element.content?.fileName || "File";

    const totalPages = Math.max(1, ensureNumber(element.content?.totalPages, 1));
    const currentPage = Math.min(totalPages, Math.max(1, ensureNumber(element.content?.currentPage, 1)));
    const zoomLevel = clampZoom(element.content?.zoomLevel ?? 1);
    view.pageIndicator.textContent = `${currentPage}/${totalPages} • ${Math.round(zoomLevel * 100)}%`;

    const viewerKind = element.content?.viewerKind || "unsupported";
    const isPdf = viewerKind === "pdf";
    const canPage = isPdf && !!view.pdfDoc && !element.content?.minimized;
    view.buttons.prevBtn.disabled = !canPage || currentPage <= 1;
    view.buttons.nextBtn.disabled = !canPage || currentPage >= totalPages;
    const disableZoomForPdfIframe = isPdf && !view.pdfDoc;
    view.buttons.zoomOutBtn.disabled = !!element.content?.minimized || disableZoomForPdfIframe;
    view.buttons.zoomInBtn.disabled = !!element.content?.minimized || disableZoomForPdfIframe;
    view.buttons.zoomResetBtn.disabled = !!element.content?.minimized || disableZoomForPdfIframe;
    view.buttons.minimizeBtn.textContent = element.content?.minimized ? "Expand" : "Min";

    if (options.skipContentRefresh) return;
    this.ensureContent(view, element).catch((err) => {
      console.error("File viewer render failed:", err);
      view.status.textContent = err.message || "Could not render file.";
    });
  }

  async ensureContent(view, element) {
    const storagePath = element.content?.storagePath || "";
    if (!storagePath) {
      view.status.textContent = "Missing storage path.";
      return;
    }
    if (element.content?.viewerKind === "unsupported") {
      view.status.textContent = "This file type is not supported in the canvas viewer.";
      view.content.innerHTML = "";
      return;
    }
    if (element.content?.minimized) {
      view.status.textContent = "Viewer minimized.";
      view.content.innerHTML = "";
      return;
    }

    if (element.content?.viewerKind === "text") {
      await this.renderText(view, element);
      return;
    }
    if (element.content?.viewerKind === "pdf") {
      await this.renderPdf(view, element);
      return;
    }
  }

  async renderText(view, element) {
    if (view.contentLoadedForPath === element.content.storagePath && view.textLoaded) return;
    const url = await getFileDownloadUrl(element.content.storagePath);
    view.content.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "wb-file-viewer__frame";
    frame.src = url;
    frame.setAttribute("title", element.content?.fileName || "Text preview");
    frame.addEventListener("load", () => {
      view.status.textContent = "";
    }, { once: true });
    view.content.appendChild(frame);
    view.status.textContent = "Loading preview...";
    view.textLoaded = true;
    view.contentLoadedForPath = element.content.storagePath;
  }

  async renderPdf(view, element) {
    if (view.contentLoadedForPath === element.content.storagePath) return;
    const url = await getFileDownloadUrl(element.content.storagePath);
    view.content.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "wb-file-viewer__frame";
    frame.src = url;
    frame.setAttribute("title", element.content?.fileName || "PDF preview");
    frame.addEventListener("load", () => {
      view.status.textContent = "PDF opened in direct preview mode.";
    }, { once: true });
    view.content.appendChild(frame);
    view.status.textContent = "Opening PDF preview...";
    view.pdfDoc = null;
    view.contentLoadedForPath = element.content.storagePath;
  }

  getElement(view) {
    return this.store.getElement(view.id);
  }

  adjustPage(view, delta) {
    const element = this.getElement(view);
    if (!element) return;
    const total = Math.max(1, ensureNumber(element.content?.totalPages, 1));
    const next = Math.min(total, Math.max(1, ensureNumber(element.content?.currentPage, 1) + delta));
    this.setViewerState(view, { currentPage: next }, true);
  }

  adjustZoom(view, delta) {
    const element = this.getElement(view);
    if (!element) return;
    const next = clampZoom((ensureNumber(element.content?.zoomLevel, 1) || 1) + delta);
    this.setViewerState(view, { zoomLevel: next }, true);
  }

  async download(view) {
    const element = this.getElement(view);
    if (!element?.content?.storagePath) return;
    const url = await getFileDownloadUrl(element.content.storagePath);
    window.open(url, "_blank", "noopener");
  }

  toggleMinimize(view) {
    const element = this.getElement(view);
    if (!element) return;
    this.setViewerState(view, { minimized: !element.content?.minimized }, true);
  }

  closeViewer(view) {
    this.store.deleteElement(view.id);
  }

  setViewerState(view, patch, persist) {
    const element = this.getElement(view);
    if (!element) return;
    this.store.updateElement(
      view.id,
      { content: patch },
      { persist: false },
    );
    if (!persist) return;
    clearTimeout(view.persistTimer);
    view.persistTimer = setTimeout(() => {
      const latest = this.getElement(view);
      if (!latest) return;
      this.store.updateElement(view.id, { content: patch }, { persist: true });
    }, 250);
  }

  removeViewer(id) {
    const view = this.viewerById.get(id);
    if (!view) return;
    clearTimeout(view.persistTimer);
    view.shell.remove();
    this.viewerById.delete(id);
  }
}
