/**
 * Turns user input (mouse, keyboard, toolbar) into updates on the canvas and ElementStore.
 *
 * WhiteboardModule constructs this after FabricRenderer exists. The controller calls
 * store/renderer methods to create shapes, paths, and text; it also manages zoom, pan,
 * and custom drag-box selection because Fabric’s defaults are adjusted per active tool.
 */
export class InteractionController {
  /**
   * @param {fabric.Canvas} canvas
   * @param {any} store
   * @param {any} renderer
   * @param {any} ui
   */
  constructor(canvas, store, renderer, ui) {
    // =============================================================================
    // Mutable state — tool mode, gestures in progress, zoom limits, listener guards
    // =============================================================================
    this.canvas = canvas;
    this.store = store;
    this.renderer = renderer;
    this.ui = ui;

    this.activeTool = "select";
    this.activeShapeKind = "rectangle";

    this.isPanning = false;
    this.panStartClient = null;
    this.panPrevSkipTargetFind = null;

    this.isDrawingShape = false;
    this.shapeElementId = null;
    this.shapeStart = null;

    this.isDrawingPath = false;
    this.pathElementId = null;
    this.pathPointsAbs = [];
    this.isSpaceHeld = false;

    this.isAreaSelecting = false;
    this.areaSelectStart = null; // world coords {x,y}
    this.areaSelectRect = null; // fabric.Rect overlay

    this.minZoom = 0.2;
    this.maxZoom = 6;

    /** Prevents duplicate listeners if init() is called more than once. */
    this._initialized = false;

    this._onMouseDown = this.onMouseDown.bind(this);
    this._onMouseMove = this.onMouseMove.bind(this);
    this._onMouseUp = this.onMouseUp.bind(this);
    this._onWheel = this.onWheel.bind(this);
    this._onCanvasContextMenu = this.onCanvasContextMenu.bind(this);
    this._onDocumentContextMenu = this.onDocumentContextMenu.bind(this);
    this._onKeyDown = this.onKeyDown.bind(this);
    this._onKeyUp = this.onKeyUp.bind(this);

    // Stable references so init()/destroy() can add/remove the same listeners.
    this._onUiSelectTool = () => this.setTool("select");
    this._onUiShapeTool = () => this.setTool("shape");
    this._onUiPenTool = () => this.setTool("pen");
    this._onUiTextTool = () => this.setTool("text");
    this._onUiShapeRect = () => this.setShapeKind("rectangle");
    this._onUiShapeCircle = () => this.setShapeKind("circle");
    this._onUiClearCanvas = () => this.clearAll();
  }

  // =============================================================================
  // init / destroy — register DOM + Fabric listeners once (guarded by _initialized)
  // =============================================================================

  init() {
    if (this._initialized) {
      console.warn("InteractionController.init() called again; skipping duplicate listeners.");
      return;
    }

    if (this.ui.toolSelectBtn) this.ui.toolSelectBtn.addEventListener("click", this._onUiSelectTool);
    if (this.ui.toolShapeBtn) this.ui.toolShapeBtn.addEventListener("click", this._onUiShapeTool);
    if (this.ui.toolPenBtn) this.ui.toolPenBtn.addEventListener("click", this._onUiPenTool);
    if (this.ui.toolTextBtn) this.ui.toolTextBtn.addEventListener("click", this._onUiTextTool);

    if (this.ui.shapeRectBtn) this.ui.shapeRectBtn.addEventListener("click", this._onUiShapeRect);
    if (this.ui.shapeCircleBtn) this.ui.shapeCircleBtn.addEventListener("click", this._onUiShapeCircle);

    if (this.ui.clearCanvasBtn) this.ui.clearCanvasBtn.addEventListener("click", this._onUiClearCanvas);

    // Prevent context menu so RMB drag works smoothly.
    const canvasEl = this.canvas.getElement();
    canvasEl.addEventListener("contextmenu", this._onCanvasContextMenu, { passive: false });

    // Some browsers/Firebase embedding route contextmenu outside the canvas element.
    // Prevent it when it's on/inside our canvas.
    document.addEventListener("contextmenu", this._onDocumentContextMenu, {
      passive: false,
      capture: true,
    });

    this.canvas.on("mouse:down", this._onMouseDown);
    this.canvas.on("mouse:move", this._onMouseMove);
    this.canvas.on("mouse:up", this._onMouseUp);
    this.canvas.on("mouse:wheel", this._onWheel);

    // Keyboard pan fallback: hold Space and drag with left mouse.
    document.addEventListener("keydown", this._onKeyDown);
    document.addEventListener("keyup", this._onKeyUp);

    // Default tool.
    this.setTool("select");
    this._initialized = true;
  }

  destroy() {
    if (!this._initialized) return;

    if (this.ui.toolSelectBtn) this.ui.toolSelectBtn.removeEventListener("click", this._onUiSelectTool);
    if (this.ui.toolShapeBtn) this.ui.toolShapeBtn.removeEventListener("click", this._onUiShapeTool);
    if (this.ui.toolPenBtn) this.ui.toolPenBtn.removeEventListener("click", this._onUiPenTool);
    if (this.ui.toolTextBtn) this.ui.toolTextBtn.removeEventListener("click", this._onUiTextTool);

    if (this.ui.shapeRectBtn) this.ui.shapeRectBtn.removeEventListener("click", this._onUiShapeRect);
    if (this.ui.shapeCircleBtn) this.ui.shapeCircleBtn.removeEventListener("click", this._onUiShapeCircle);

    if (this.ui.clearCanvasBtn) this.ui.clearCanvasBtn.removeEventListener("click", this._onUiClearCanvas);

    const canvasEl = this.canvas.getElement();
    if (canvasEl) {
      canvasEl.removeEventListener("contextmenu", this._onCanvasContextMenu);
    }

    document.removeEventListener("contextmenu", this._onDocumentContextMenu, true);
    document.removeEventListener("keydown", this._onKeyDown);
    document.removeEventListener("keyup", this._onKeyUp);

    this.canvas.off("mouse:down", this._onMouseDown);
    this.canvas.off("mouse:move", this._onMouseMove);
    this.canvas.off("mouse:up", this._onMouseUp);
    this.canvas.off("mouse:wheel", this._onWheel);

    this._initialized = false;
  }

  // =============================================================================
  // Toolbar a11y, context menu, keyboard — aria-pressed; RMB pan; Space pan; Delete
  // =============================================================================

  /**
   * @param {HTMLElement | null | undefined} el
   * @param {boolean} pressed
   */
  _setAriaPressed(el, pressed) {
    if (el && typeof el.setAttribute === "function") {
      el.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  }

  onCanvasContextMenu(e) {
    e.preventDefault();
  }

  onDocumentContextMenu(e) {
    const canvasEl = this.canvas.getElement();
    const target = e.target;
    if (target && canvasEl && (target === canvasEl || canvasEl.contains(target))) {
      e.preventDefault();
    }
  }

  onKeyDown(e) {
    const activeObj = this.canvas.getActiveObject();
    const editingFabricText = !!(activeObj && activeObj.isEditing);
    const domTarget = e.target;
    const editingDomInput =
      domTarget instanceof HTMLElement &&
      (domTarget.tagName === "INPUT" || domTarget.tagName === "TEXTAREA" || domTarget.isContentEditable);

    if (e.code === "Space") {
      // Do not hijack Space while text editing.
      if (editingFabricText || editingDomInput) return;

      this.isSpaceHeld = true;
      e.preventDefault();
      return;
    }

    if (e.code === "Delete" || e.code === "Backspace") {
      // Let text input/backspace work naturally while editing.
      if (editingFabricText || editingDomInput) return;

      const deletedAny = this.deleteSelectedElements();
      if (deletedAny) {
        e.preventDefault();
      }
    }
  }

  onKeyUp(e) {
    if (e.code === "Space") {
      this.isSpaceHeld = false;
    }
  }

  // =============================================================================
  // Toolbar + tool mode — sync HTML controls with Fabric (selectable vs drawing modes)
  // =============================================================================

  setShapeKind(kind) {
    this.activeShapeKind = kind;
    if (this.ui.shapeRectBtn) {
      this.ui.shapeRectBtn.classList.toggle("active", kind === "rectangle");
      this._setAriaPressed(this.ui.shapeRectBtn, kind === "rectangle");
    }
    if (this.ui.shapeCircleBtn) {
      this.ui.shapeCircleBtn.classList.toggle("active", kind === "circle");
      this._setAriaPressed(this.ui.shapeCircleBtn, kind === "circle");
    }
  }

  setTool(tool) {
    this.activeTool = tool;

    const selectable = tool === "select";
    // Disable Fabric's built-in drag selection rectangle; we implement our own
    // box selection in select mode.
    this.canvas.selection = false;
    // When we are drawing/placing, Fabric should not try to hit-test objects.
    // This avoids interaction fights between tools and selection.
    this.canvas.skipTargetFind = !selectable;

    this.renderer.setAllSelectable(selectable);

    if (this.ui.toolSelectBtn) {
      this.ui.toolSelectBtn.classList.toggle("active", tool === "select");
      this._setAriaPressed(this.ui.toolSelectBtn, tool === "select");
    }
    if (this.ui.toolShapeBtn) {
      this.ui.toolShapeBtn.classList.toggle("active", tool === "shape");
      this._setAriaPressed(this.ui.toolShapeBtn, tool === "shape");
    }
    if (this.ui.toolPenBtn) {
      this.ui.toolPenBtn.classList.toggle("active", tool === "pen");
      this._setAriaPressed(this.ui.toolPenBtn, tool === "pen");
    }
    if (this.ui.toolTextBtn) {
      this.ui.toolTextBtn.classList.toggle("active", tool === "text");
      this._setAriaPressed(this.ui.toolTextBtn, tool === "text");
    }

    const shapeSubtoolbar = this.ui.shapeSubtoolbarEl;
    if (shapeSubtoolbar && this.ui.shapeRectBtn && this.ui.shapeCircleBtn) {
      shapeSubtoolbar.style.display = tool === "shape" ? "inline-flex" : "none";
    }

    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  clearAll() {
    this.store.clear();
    this.renderer.clearCanvas();
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();

    if (this.areaSelectRect) {
      this.canvas.remove(this.areaSelectRect);
      this.areaSelectRect = null;
    }
    this.isAreaSelecting = false;
    this.areaSelectStart = null;

    this.isDrawingShape = false;
    this.shapeElementId = null;
    this.isDrawingPath = false;
    this.pathElementId = null;
    this.pathPointsAbs = [];
  }

  deleteSelectedElements() {
    const active = this.canvas.getActiveObject();
    if (!active) return false;

    const selectedObjects =
      active.type === "activeSelection" && typeof active.getObjects === "function"
        ? active.getObjects()
        : [active];

    const elementIds = selectedObjects
      .map((obj) => obj?.__elementId)
      .filter((id) => typeof id === "string");

    if (elementIds.length === 0) return false;

    for (const id of elementIds) {
      this.store.deleteElement(id);
      this.renderer.removeElementFromCanvas(id);
    }

    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    return true;
  }

  // =============================================================================
  // Wheel zoom — scale around cursor; skip while editing inline text on the canvas
  // =============================================================================

  onWheel(opt) {
    // Ignore wheel when editing text.
    const active = this.canvas.getActiveObject();
    if (active && active.isEditing) return;

    const e = opt.e;
    if (!e) return;

    // Zoom around the cursor in viewport pixels (not world coords),
    // otherwise zoom center appears offset.
    const fabric = globalThis.fabric;
    const upperEl = this.canvas.upperCanvasEl || this.canvas.getElement();
    const rect = upperEl.getBoundingClientRect();
    const zoomPoint = new fabric.Point(e.clientX - rect.left, e.clientY - rect.top);
    const currentZoom = this.canvas.getZoom();
    const zoomFactor = Math.pow(0.999, e.deltaY);
    let nextZoom = currentZoom * zoomFactor;

    nextZoom = Math.min(this.maxZoom, Math.max(this.minZoom, nextZoom));
    if (nextZoom === currentZoom) return;

    this.canvas.zoomToPoint(zoomPoint, nextZoom);
    e.preventDefault();
    e.stopPropagation();
  }

  // =============================================================================
  // Pointer routing — dispatch to pan, selection box, or active draw tool
  // =============================================================================

  onMouseDown(opt) {
    const e = opt.e;
    if (!e) return;

    // Normalize which mouse button fired: Fabric and browsers disagree on `button` vs `which`,
    // so we prefer the `buttons` bitmask when present, then fall back for older quirks.
    const which = e.which ?? null; // 1 left, 2 middle, 3 right (typical)
    const button = opt.button ?? e.button;
    const buttonsMask = typeof e.buttons === "number" ? e.buttons : 0; // 1 left, 2 right, 4 middle
    const buttonKind = (() => {
      // Prefer the bitmask because `which`/`button` are inconsistent in this environment.
      if ((buttonsMask & 4) === 4) return "middle";
      if ((buttonsMask & 2) === 2) return "right";
      if ((buttonsMask & 1) === 1) return "left";

      // Fallbacks (we saw Fabric reporting button=1 for left in this environment).
      if (which === 1) return "left";
      if (which === 3) return "right";
      if (which === 2) return "middle";
      if (button === 0) return "left";
      if (button === 1) return "left";
      if (button === 2) return "right";
      return "other";
    })();

    // Pan: Space+LMB is primary. Keep RMB as secondary fallback.
    if (buttonKind === "right" || (buttonKind === "left" && this.isSpaceHeld)) {
      e.preventDefault?.();
      this.beginPan(e);
      return;
    }

    // Only handle tools on left click.
    if (buttonKind !== "left") return;

    // If we are panning, ignore other tool interactions.
    if (this.isPanning) return;

    const pointer = this.canvas.getPointer(e);

    if (this.activeTool === "select") {
      // If the click is on empty space, start drag-box selection.
      const target = opt.target ?? this.canvas.findTarget?.(e);
      if (target && target.selectable) {
        this.canvas.setActiveObject(target);
        this.canvas.requestRenderAll();
      } else {
        this.beginAreaSelection(pointer);
      }
      return;
    }

    if (this.activeTool === "shape") {
      this.beginShape(pointer);
    } else if (this.activeTool === "pen") {
      this.beginPath(pointer);
    } else if (this.activeTool === "text") {
      this.placeText(pointer);
    }
  }

  onMouseMove(opt) {
    const e = opt.e;
    if (!e) return;

    if (this.isPanning) {
      this.updatePan(e);
      return;
    }

    if (this.isAreaSelecting) {
      this.updateAreaSelection(this.canvas.getPointer(e));
      return;
    }

    if (this.isDrawingShape) {
      this.updateShape(this.canvas.getPointer(e));
    } else if (this.isDrawingPath) {
      this.updatePath(this.canvas.getPointer(e));
    }
  }

  onMouseUp(opt) {
    const e = opt.e;
    if (!e) return;

    // Same button detection strategy as onMouseDown (keep pan / drag-release behavior consistent).
    const which = e.which ?? null;
    const button = opt.button ?? e.button;
    const buttonsMask = typeof e.buttons === "number" ? e.buttons : 0;
    const buttonKind = (() => {
      if ((buttonsMask & 4) === 4) return "middle";
      if ((buttonsMask & 2) === 2) return "right";
      if ((buttonsMask & 1) === 1) return "left";

      if (which === 1) return "left";
      if (which === 3) return "right";
      if (which === 2) return "middle";
      if (button === 0) return "left";
      if (button === 1) return "left";
      if (button === 2) return "right";
      return "other";
    })();

    if ((buttonKind === "right" || buttonKind === "left") && this.isPanning) {
      this.endPan();
      return;
    }

    if (this.isAreaSelecting && buttonKind === "left") {
      this.finishAreaSelection();
      return;
    }

    if (this.isDrawingShape) {
      this.finishShape();
    }
    if (this.isDrawingPath) {
      this.finishPath();
    }
  }

  // =============================================================================
  // Drag-box selection — custom marquee in select mode; builds ActiveSelection when needed
  // =============================================================================

  beginAreaSelection(pointer) {
    const fabric = globalThis.fabric;
    if (!fabric?.Rect) return;

    this.isAreaSelecting = true;
    this.areaSelectStart = { x: pointer.x, y: pointer.y };

    this.canvas.skipTargetFind = true;
    this.canvas.selection = false;
    this.canvas.discardActiveObject();

    this.areaSelectRect = new fabric.Rect({
      left: pointer.x,
      top: pointer.y,
      width: 1,
      height: 1,
      fill: "rgba(0, 0, 0, 0.06)",
      stroke: "#ef4444",
      strokeWidth: 2,
      strokeDashArray: [6, 4],
      selectable: false,
      evented: false,
      hasControls: false,
      hasBorders: false,
      excludeFromExport: true,
    });

    this.canvas.add(this.areaSelectRect);
    this.canvas.requestRenderAll();
  }

  updateAreaSelection(pointer) {
    if (!this.isAreaSelecting || !this.areaSelectStart || !this.areaSelectRect) return;

    const x1 = this.areaSelectStart.x;
    const y1 = this.areaSelectStart.y;
    const x2 = pointer.x;
    const y2 = pointer.y;

    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.max(0, Math.abs(x2 - x1));
    const h = Math.max(0, Math.abs(y2 - y1));

    this.areaSelectRect.set({ left, top, width: w, height: h });
    this.areaSelectRect.setCoords();
    this.canvas.requestRenderAll();
  }

  finishAreaSelection() {
    if (!this.areaSelectRect || !this.areaSelectStart) return;

    const x1 = this.areaSelectStart.x;
    const y1 = this.areaSelectStart.y;
    const x2 = this.areaSelectRect.left ?? x1;
    const y2 = this.areaSelectRect.top ?? y1;
    const w = this.areaSelectRect.width ?? 0;
    const h = this.areaSelectRect.height ?? 0;

    const selLeft = Math.min(x1, x2);
    const selTop = Math.min(y1, y2);
    const selRight = selLeft + w;
    const selBottom = selTop + h;

    const candidates = this.canvas
      .getObjects()
      .filter((obj) => obj !== this.areaSelectRect && obj.selectable);

    const selected = [];
    for (const obj of candidates) {
      const b = obj.getBoundingRect?.(true, true);
      if (!b) continue;

      const objLeft = b.left;
      const objTop = b.top;
      const objRight = b.left + b.width;
      const objBottom = b.top + b.height;

      const intersects = !(objLeft > selRight || objRight < selLeft || objTop > selBottom || objBottom < selTop);
      if (intersects) selected.push(obj);
    }

    this.canvas.remove(this.areaSelectRect);
    this.areaSelectRect = null;

    this.isAreaSelecting = false;
    this.areaSelectStart = null;

    // Restore selection behavior for select tool.
    this.canvas.skipTargetFind = false;
    this.canvas.selection = false;

    if (selected.length === 1) {
      this.canvas.setActiveObject(selected[0]);
    } else if (selected.length > 1) {
      const fabric = globalThis.fabric;
      if (!fabric?.ActiveSelection) return;
      this.canvas.setActiveObject(new fabric.ActiveSelection(selected, { canvas: this.canvas }));
    } else {
      this.canvas.discardActiveObject();
    }

    this.canvas.requestRenderAll();
  }

  // =============================================================================
  // Pan — right-drag or Space + left-drag; adjusts viewportTransform, not object positions
  // =============================================================================

  beginPan(e) {
    this.isPanning = true;
    this.panStartClient = { x: e.clientX, y: e.clientY };
    this.panPrevSkipTargetFind = this.canvas.skipTargetFind;

    this.canvas.skipTargetFind = true;
    this.canvas.selection = false;
    this.canvas.defaultCursor = "grabbing";

    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  updatePan(e) {
    if (!this.panStartClient) return;
    const vpt = this.canvas.viewportTransform;
    if (!vpt) return;

    const dx = e.clientX - this.panStartClient.x;
    const dy = e.clientY - this.panStartClient.y;

    // viewport translation happens in world units; adjust by zoom.
    const zoom = this.canvas.getZoom() || 1;
    vpt[4] += dx / zoom;
    vpt[5] += dy / zoom;

    this.panStartClient = { x: e.clientX, y: e.clientY };
    this.canvas.requestRenderAll();
  }

  endPan() {
    this.isPanning = false;
    this.panStartClient = null;

    // Restore tool selection behavior.
    const selectable = this.activeTool === "select";
    this.canvas.selection = false;
    this.canvas.skipTargetFind = !selectable;
    this.renderer.setAllSelectable(selectable);

    this.canvas.defaultCursor = "default";
    this.canvas.requestRenderAll();
  }

  // =============================================================================
  // Shape tool — live rectangle/circle while dragging; tiny drags are discarded on release
  // =============================================================================

  beginShape(pointer) {
    this.isDrawingShape = true;
    this.shapeStart = { x: pointer.x, y: pointer.y };

    const type = this.activeShapeKind; // "rectangle" | "circle"
    const element = this.store.addElement({
      id: this.store.createId(),
      type,
      position: { x: pointer.x, y: pointer.y },
      size: { w: 1, h: 1 },
      rotation: 0,
      style: {
        fill: "rgba(37, 99, 235, 0.85)",
        stroke: "#ef4444",
        strokeWidth: 4,
      },
      content: {},
    });

    const selectable = false; // while drawing, we don't want selection fighting controls
    this.renderer.addElementToCanvas(element, { selectable });

    this.shapeElementId = element.id;
  }

  updateShape(pointer) {
    const elementId = this.shapeElementId;
    const start = this.shapeStart;
    if (!elementId || !start) return;

    const obj = this.renderer.getFabricObject(elementId);
    if (!obj) return;

    const x1 = start.x;
    const y1 = start.y;
    const x2 = pointer.x;
    const y2 = pointer.y;

    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.max(1, Math.abs(x2 - x1));
    const h = Math.max(1, Math.abs(y2 - y1));

    if (this.activeShapeKind === "rectangle") {
      obj.set({ left, top, width: w, height: h });
      obj.setCoords();
    } else {
      const d = Math.max(w, h);
      const radius = Math.max(1, d / 2);
      obj.set({ left, top, radius, scaleX: 1, scaleY: 1 });
      obj.setCoords();
    }

    this.canvas.requestRenderAll();
  }

  finishShape() {
    const elementId = this.shapeElementId;
    if (!elementId) return;

    this.isDrawingShape = false;
    this.shapeStart = null;

    const obj = this.renderer.getFabricObject(elementId);
    if (!obj) return;

    const w = obj.getScaledWidth();
    const h = obj.getScaledHeight();
    // If the drag was too small, treat it as a click and remove the object.
    if (w < 5 || h < 5) {
      this.store.deleteElement(elementId);
      this.renderer.removeElementFromCanvas(elementId);
      this.shapeElementId = null;
      return;
    }

    this.renderer.syncElementFromFabricObject(elementId);
    this.shapeElementId = null;
    this.canvas.requestRenderAll();
  }

  // =============================================================================
  // Pen tool — freehand polyline in world space; points stored relative to stroke bbox
  // =============================================================================

  beginPath(pointer) {
    this.isDrawingPath = true;
    this.pathPointsAbs = [{ x: pointer.x, y: pointer.y }];

    const element = this.store.addElement({
      id: this.store.createId(),
      type: "path",
      position: { x: pointer.x, y: pointer.y },
      size: { w: 1, h: 1 },
      rotation: 0,
      style: {
        stroke: "#111827",
        strokeWidth: 2,
        fill: "",
      },
      content: {
        points: [{ x: 0, y: 0 }],
        closed: false,
      },
    });

    // We'll update left/top + points as the stroke grows so coordinates stay stable.
    const selectable = false;
    const obj = this.renderer.addElementToCanvas(element, { selectable });
    if (!obj) return;

    this.pathElementId = element.id;
  }

  updatePath(pointer) {
    const elementId = this.pathElementId;
    if (!elementId) return;

    const obj = this.renderer.getFabricObject(elementId);
    if (!obj) return;

    // Reduce point density.
    const last = this.pathPointsAbs[this.pathPointsAbs.length - 1];
    const dx = pointer.x - last.x;
    const dy = pointer.y - last.y;
    if (dx * dx + dy * dy < 4) return;

    this.pathPointsAbs.push({ x: pointer.x, y: pointer.y });

    let minX = Infinity;
    let minY = Infinity;
    for (const p of this.pathPointsAbs) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }

    const relPoints = this.pathPointsAbs.map((p) => ({ x: p.x - minX, y: p.y - minY }));
    obj.set({ left: minX, top: minY, points: relPoints });
    obj.setCoords();
    this.canvas.requestRenderAll();
  }

  finishPath() {
    const elementId = this.pathElementId;
    if (!elementId) return;

    this.isDrawingPath = false;
    this.pathElementId = null;

    // Decide whether the stroke was "real" based on pointer travel distance.
    // Using Fabric bounds (getScaledWidth/Height) is unreliable for polylines while points
    // are being updated during the drag.
    let strokeLen = 0;
    for (let i = 1; i < this.pathPointsAbs.length; i++) {
      const a = this.pathPointsAbs[i - 1];
      const b = this.pathPointsAbs[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      strokeLen += Math.sqrt(dx * dx + dy * dy);
    }

    const obj = this.renderer.getFabricObject(elementId);
    if (!obj) return;
    this.refreshPolylineGeometry(obj);
    obj.setCoords();

    const boundsW = obj.getScaledWidth();
    const boundsH = obj.getScaledHeight();
    // Local-only heuristic: require some minimal stroke travel.
    if (this.pathPointsAbs.length < 2 || strokeLen < 5) {
      // Too small stroke.
      this.store.deleteElement(elementId);
      this.renderer.removeElementFromCanvas(elementId);
      this.pathPointsAbs = [];
      return;
    }

    this.renderer.syncElementFromFabricObject(elementId);
    this.pathPointsAbs = [];
    this.canvas.requestRenderAll();
  }

  // =============================================================================
  // Polyline + text helpers — refresh Fabric geometry; place editable Textbox from tool
  // =============================================================================

  /**
   * Fabric polyline can keep stale internal dimensions after points mutation.
   * Force a geometry refresh so selection handles use the real stroke bounds.
   */
  refreshPolylineGeometry(obj) {
    if (!obj) return;
    const prevLeft = obj.left;
    const prevTop = obj.top;

    if (typeof obj._calcDimensions === "function") {
      obj._calcDimensions();
    }
    if (typeof obj._setPositionDimensions === "function") {
      obj._setPositionDimensions({});
    }
    if (typeof prevLeft === "number" && typeof prevTop === "number") {
      obj.set({ left: prevLeft, top: prevTop });
    }
    obj.dirty = true;
  }

  placeText(pointer) {
    const element = this.store.addElement({
      id: this.store.createId(),
      type: "text",
      position: { x: pointer.x, y: pointer.y },
      size: { w: 220, h: 40 },
      rotation: 0,
      style: {
        fill: "#111827",
        fontSize: 20,
        textAlign: "left",
      },
      content: {
        text: "Double-click to edit",
      },
    });

    const selectable = true; // needed for editing/controls
    const textbox = this.renderer.addElementToCanvas(element, { selectable });
    textbox.enterEditing();
    textbox.selectAll();

    // When the user finishes editing, sync back into structured state.
    const elementId = element.id;
    textbox.on("editing:exited", () => {
      this.renderer.syncElementFromFabricObject(elementId);
      const live = this.store.getElement(elementId);
      if (!live || (live.content?.text ?? "").trim() === "") {
        this.store.deleteElement(elementId);
        this.renderer.removeElementFromCanvas(elementId);
      }
      // Respect current tool selection behavior after editing.
      const selectableAfter = this.activeTool === "select";
      this.renderer.setAllSelectable(selectableAfter);
      this.canvas.requestRenderAll();
    });

    this.canvas.setActiveObject(textbox);
    this.canvas.requestRenderAll();
  }
}

