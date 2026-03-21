import { ElementStore } from "./elementStore.js";
import { FabricRenderer } from "./fabricRenderer.js";
import { InteractionController } from "./interactionController.js";

async function init() {
  const fabric = globalThis.fabric;
  if (!fabric || !fabric.Canvas) {
    throw new Error(
      "Fabric.js did not load. Check CDN access or network permissions (globalThis.fabric is missing).",
    );
  }

  const canvasEl = document.getElementById("whiteboardCanvas");
  if (!canvasEl) throw new Error("Missing canvas element #whiteboardCanvas");

  // Create Fabric canvas. We keep `preserveObjectStacking` so z-order behaves naturally.
  const canvas = new fabric.Canvas(canvasEl, {
    preserveObjectStacking: true,
    selection: true,
    stopContextMenu: true,
  });

  const store = new ElementStore();
  const renderer = new FabricRenderer(canvas, store);
  const controller = new InteractionController(canvas, store, renderer, {
    toolSelectBtn: document.getElementById("toolSelectBtn"),
    toolShapeBtn: document.getElementById("toolShapeBtn"),
    toolPenBtn: document.getElementById("toolPenBtn"),
    toolTextBtn: document.getElementById("toolTextBtn"),
    shapeRectBtn: document.getElementById("shapeRectBtn"),
    shapeCircleBtn: document.getElementById("shapeCircleBtn"),
    clearCanvasBtn: document.getElementById("clearCanvasBtn"),
  });

  const resize = () => {
    const prevVpt = canvas.viewportTransform ? [...canvas.viewportTransform] : [1, 0, 0, 1, 0, 0];
    const hostEl = canvasEl.parentElement;
    const toolbarEl = document.querySelector(".whiteboard-toolbar-bar");
    const toolbarRect = toolbarEl?.getBoundingClientRect?.();

    const desiredW = Math.max(1, Math.floor(window.innerWidth));
    const desiredH = Math.max(1, Math.floor(window.innerHeight - (toolbarRect?.height ?? 0)));
    const finalW = desiredW;
    const finalH = desiredH;
    if (hostEl) {
      hostEl.style.width = `${finalW}px`;
      hostEl.style.height = `${finalH}px`;
    }
    canvasEl.style.width = `${finalW}px`;
    canvasEl.style.height = `${finalH}px`;
    canvasEl.style.flex = "0 0 auto";

    canvas.setDimensions({ width: finalW, height: finalH }, { cssOnly: false, backstoreOnly: false });
    canvas.setViewportTransform(prevVpt);
    canvas.calcOffset();
    canvas.requestRenderAll();
  };

  resize();
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasEl);

  controller.init();
}

init().catch((err) => {
  console.error(err);
  alert("Failed to initialize whiteboard: " + err.message);
});

