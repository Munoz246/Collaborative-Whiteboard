/**
 * Bridges ElementStore and Fabric.js: creates, updates, and removes canvas objects.
 *
 * Each store element gets a matching Fabric object tracked in fabricById. When the user drags
 * or resizes on the canvas, object:modified syncs back into the store so logic stays data-driven.
 */

// =============================================================================
// Geometry helpers — pen paths use raw points; we derive width/height for scaling
// =============================================================================

function pointsToPlain(points) {
  return (points || []).map((p) => ({ x: p.x, y: p.y }));
}

function computePolylineIntrinsicSize(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points || []) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { w: 1, h: 1 };

  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return { w, h };
}

// =============================================================================
// Fabric UI — consistent resize/rotate handles across Rect, Circle, Textbox, Polyline
// =============================================================================

function setCommonControls(obj) {
  obj.set({
    hasControls: true,
    hasBorders: true,
    // Rotation handle visible.
    transparentCorners: false,
  });
  // Keep it consistent across object types.
  if (obj.controls) {
    if (obj.controls.mtr) obj.controls.mtr.visible = true;
  }
}

export class FabricRenderer {
  /**
   * @param {fabric.Canvas} canvas
   * @param {any} store
   */
  constructor(canvas, store) {
    // =============================================================================
    // Lifecycle — listen for transforms so the store stays in sync with the canvas
    // =============================================================================
    this.canvas = canvas;
    this.store = store;
    /** @type {Map<string, fabric.Object>} */
    this.fabricById = new Map();
    this._onObjectModified = (evt) => {
      const obj = evt.target;
      if (!obj) return;
      const elementId = obj.__elementId;
      if (!elementId) {
        if (obj.type === "activeSelection" && typeof obj.getObjects === "function") {
          const selectionObjects = obj.getObjects();
          // Keep grouped transforms rigid by applying one shared delta to all children.
          const childSamples = [];
          for (const childObj of selectionObjects) {
            const childId = childObj?.__elementId;
            if (!childId) continue;
            const fabric = globalThis.fabric;
            const matrix = typeof childObj.calcTransformMatrix === "function" ? childObj.calcTransformMatrix() : null;
            const pathOffsetX = childObj?.pathOffset?.x ?? ((childObj?.width ?? 0) / 2);
            const pathOffsetY = childObj?.pathOffset?.y ?? ((childObj?.height ?? 0) / 2);
            const localPoint = fabric?.Point ? new fabric.Point(-pathOffsetX, -pathOffsetY) : null;
            const worldPoint = (matrix && localPoint && fabric?.util?.transformPoint)
              ? fabric.util.transformPoint(localPoint, matrix)
              : null;
            const absoluteOrigin = worldPoint ? { x: worldPoint.x, y: worldPoint.y } : null;
            const storeElement = this.store?.getElement?.(childId);
            const prevPos = storeElement?.position ?? null;
            const computedDelta = (prevPos && absoluteOrigin)
              ? {
                dx: absoluteOrigin.x - (prevPos.x ?? 0),
                dy: absoluteOrigin.y - (prevPos.y ?? 0),
              }
              : null;
            childSamples.push({
              childId,
              prevPos,
              absoluteOrigin,
              computedDelta,
            });
          }
          const deltaSamples = childSamples
            .map((s) => s.computedDelta)
            .filter((d) => d && Number.isFinite(d.dx) && Number.isFinite(d.dy));
          const sharedDelta = deltaSamples.length
            ? {
              dx: deltaSamples.reduce((sum, d) => sum + d.dx, 0) / deltaSamples.length,
              dy: deltaSamples.reduce((sum, d) => sum + d.dy, 0) / deltaSamples.length,
            }
            : null;
          for (const sample of childSamples) {
            const {
              childId,
              prevPos,
              absoluteOrigin,
              computedDelta,
            } = sample;
            const appliedPos = (prevPos && sharedDelta)
              ? {
                x: (prevPos.x ?? 0) + sharedDelta.dx,
                y: (prevPos.y ?? 0) + sharedDelta.dy,
              }
              : absoluteOrigin;
            this.syncElementFromFabricObject(childId, {
              absolutePosition: appliedPos ? { x: appliedPos.x, y: appliedPos.y } : null,
            });
          }
          return;
        }
        return;
      }
      this.syncElementFromFabricObject(elementId);
    };

    // Keep state management synchronized when users transform objects.
    this.canvas.on("object:modified", this._onObjectModified);
  }

  /** Detach Fabric listeners before canvas.dispose() (see WhiteboardModule.destroy). */
  destroy() {
    if (this.canvas && this._onObjectModified) {
      this.canvas.off("object:modified", this._onObjectModified);
    }
    this.fabricById.clear();
    this.canvas = null;
    this.store = null;
  }

  getFabricObject(elementId) {
    return this.fabricById.get(elementId);
  }

  // =============================================================================
  // Canvas graph — add/remove/clear; used when tools create elements or clear the board
  // =============================================================================

  /**
   * Create + add a new Fabric object for a store element.
   */
  addElementToCanvas(element, { selectable = false } = {}) {
    const obj = this.createFabricObject(element, selectable && !element.isLocked);
    this.fabricById.set(element.id, obj);
    this.canvas.add(obj);
    this.canvas.requestRenderAll();
    return obj;
  }

  removeElementFromCanvas(elementId) {
    const obj = this.fabricById.get(elementId);
    if (!obj) return;
    this.canvas.remove(obj);
    this.fabricById.delete(elementId);
    this.canvas.requestRenderAll();
  }

  removeByElementId(elementId) {
    this.removeElementFromCanvas(elementId);
  }

  clearCanvas() {
    this.fabricById.clear();
    this.canvas.clear();
    this.canvas.requestRenderAll();
  }

  /**
   * Toggle selection state for all existing objects.
   */
  setAllSelectable(selectable) {
    for (const obj of this.fabricById.values()) {
      const elementId = obj.__elementId;
      const element = this.store.getElement(elementId);
      const canSelect = selectable && !element?.isLocked;
      obj.set({ selectable: canSelect, evented: canSelect });
      // Controls/borders are drawn only when selected; safe to keep enabled.
      obj.setCoords();
    }
    this.canvas.requestRenderAll();
  }

  upsertFromStoreElement(element) {
    const selectable = !this.canvas.skipTargetFind;
    const existing = this.getFabricObject(element.id);
    if (!existing) {
      this.addElementToCanvas(element, { selectable });
      return;
    }
    this.removeElementFromCanvas(element.id);
    this.addElementToCanvas(element, { selectable });
  }

  // =============================================================================
  // Factory — map one store element to the right Fabric class (rectangle, circle, text, path)
  // =============================================================================

  /**
   * @param {any} element
   */
  createFabricObject(element, selectable) {
    const fabric = globalThis.fabric;
    if (!fabric) throw new Error("Fabric.js not loaded (globalThis.fabric is missing).");

    const common = {
      left: element.position.x,
      top: element.position.y,
      angle: element.rotation,
      originX: "left",
      originY: "top",
      selectable,
      evented: selectable,
    };

    let obj;
    if (element.type === "rectangle") {
      obj = new fabric.Rect({
        ...common,
        width: element.size.w,
        height: element.size.h,
        fill: element.style.fill ?? "rgba(37, 99, 235, 0.35)",
        stroke: element.style.stroke ?? "#2563eb",
        strokeWidth: element.style.strokeWidth ?? 2,
      });
      setCommonControls(obj);
    } else if (element.type === "circle") {
      const radius = Math.max(1, (element.size.w ?? 1) / 2);
      obj = new fabric.Circle({
        ...common,
        radius,
        lockUniScaling: true,
        // Ensure sizing uses element.size consistently.
        fill: element.style.fill ?? "rgba(37, 99, 235, 0.35)",
        stroke: element.style.stroke ?? "#2563eb",
        strokeWidth: element.style.strokeWidth ?? 2,
      });
      setCommonControls(obj);
    } else if (element.type === "text") {
      obj = new fabric.Textbox(element.content.text ?? "", {
        ...common,
        width: element.size.w,
        fill: element.style.fill ?? "#111827",
        fontSize: element.style.fontSize ?? 20,
        textAlign: element.style.textAlign ?? "left",
        editable: true,
        // Textbox resizing can be a bit jumpy with scaling, but Fabric handles controls.
        // We'll keep scale enabled and serialize effective size/font later.
      });
      setCommonControls(obj);
    } else if (element.type === "path") {
      const points = (element.content.points || []).map((p) => ({ x: p.x, y: p.y }));
      const intrinsic = computePolylineIntrinsicSize(points);
      const scaleX = element.size.w / intrinsic.w;
      const scaleY = element.size.h / intrinsic.h;

      obj = new fabric.Polyline(points, {
        ...common,
        // Ensure we can move/resize it.
        fill: element.style.fill ?? "",
        stroke: element.style.stroke ?? "#111827",
        strokeWidth: element.style.strokeWidth ?? 2,
        strokeLineCap: "round",
        strokeLineJoin: "round",
        scaleX: Number.isFinite(scaleX) ? scaleX : 1,
        scaleY: Number.isFinite(scaleY) ? scaleY : 1,
        objectCaching: false,
      });
      setCommonControls(obj);
    } else if (element.type === "file") {
      obj = new fabric.Textbox(element.content?.fileName || "File", {
        ...common,
        width: element.size.w || 180,
        fill: "#111827",
        fontSize: 16,
        editable: false,
      });
      setCommonControls(obj);
    } else {
      throw new Error("Unsupported element type: " + element.type);
    }

    obj.__elementId = element.id;
    return obj;
  }

  // =============================================================================
  // Store sync — after drag/resize, write Fabric’s geometry back into ElementStore
  // =============================================================================

  /**
   * Update the store element to match the current Fabric object transform.
   */
  syncElementFromFabricObject(elementId, options = {}) {
    const obj = this.fabricById.get(elementId);
    if (!obj) return;

    const element = this.store.getElement(elementId);
    if (!element) return;
    if (element.isLocked) {
      // Locked items should never be transformed locally.
      obj.set({
        left: element.position?.x ?? obj.left ?? 0,
        top: element.position?.y ?? obj.top ?? 0,
        angle: element.rotation ?? obj.angle ?? 0,
      });
      obj.setCoords();
      this.canvas.requestRenderAll();
      return;
    }

    const nextRotation = obj.angle ?? 0;
    const nextPos = options.absolutePosition
      ? { x: options.absolutePosition.x, y: options.absolutePosition.y }
      : { x: obj.left ?? 0, y: obj.top ?? 0 };
    let nextSize = { w: obj.getScaledWidth(), h: obj.getScaledHeight() };

    const nextStyle = { ...(element.style || {}) };
    const nextContent = { ...(element.content || {}) };

    if (element.type === "rectangle") {
      nextStyle.fill = obj.fill;
      nextStyle.stroke = obj.stroke;
      nextStyle.strokeWidth = obj.strokeWidth;
      // Persist geometry-only dimensions so pure drag operations don't inflate
      // size from stroke-inclusive bounds on repeated group updates.
      const geomW = (obj.width ?? 1) * (obj.scaleX ?? 1);
      const geomH = (obj.height ?? 1) * (obj.scaleY ?? 1);
      nextSize = { w: Math.max(1, geomW), h: Math.max(1, geomH) };
      // Normalize scale so the stored size matches shape geometry.
      obj.set({
        width: nextSize.w,
        height: nextSize.h,
        scaleX: 1,
        scaleY: 1,
      });
      obj.setCoords();
    } else if (element.type === "circle") {
      nextStyle.fill = obj.fill;
      nextStyle.stroke = obj.stroke;
      nextStyle.strokeWidth = obj.strokeWidth;
      const diameter = Math.max(1, (obj.radius ?? 1) * 2 * (obj.scaleX ?? 1));
      nextSize = { w: diameter, h: diameter };
      obj.set({
        radius: diameter / 2,
        scaleX: 1,
        scaleY: 1,
      });
      obj.setCoords();
    } else if (element.type === "text") {
      nextContent.text = obj.text ?? "";
      nextStyle.fill = obj.fill;
      nextStyle.fontSize = (obj.fontSize ?? 20) * (obj.scaleY ?? 1);
      nextStyle.textAlign = obj.textAlign;

      // Normalize scaling into fontSize/width where feasible.
      obj.set({
        fontSize: nextStyle.fontSize,
        width: nextSize.w,
        scaleX: 1,
        scaleY: 1,
      });
      obj.setCoords();
      // Normalizing scale/fontSize can change measured height due to wrapping.
      nextSize = { w: obj.getScaledWidth(), h: obj.getScaledHeight() };
    } else if (element.type === "path") {
      nextContent.points = pointsToPlain(obj.points);
      nextContent.closed = false;
      nextStyle.stroke = obj.stroke;
      nextStyle.strokeWidth = obj.strokeWidth;
      nextStyle.fill = obj.fill;
      // For pen paths, use geometry-only dimensions (width/height * scale),
      // not getScaledWidth/getScaledHeight, because those include stroke width.
      // Including stroke width causes additive growth on every move-sync cycle.
      const geomW = (obj.width ?? 1) * (obj.scaleX ?? 1);
      const geomH = (obj.height ?? 1) * (obj.scaleY ?? 1);
      nextSize = {
        w: Math.max(1, geomW),
        h: Math.max(1, geomH),
      };
    }

    this.store.updateElement(elementId, {
      rotation: nextRotation,
      position: nextPos,
      size: nextSize,
      style: nextStyle,
      content: nextContent,
    });
  }
}
