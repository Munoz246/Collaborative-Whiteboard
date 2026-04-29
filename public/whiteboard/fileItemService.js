import { createItem } from "./itemSyncService.js?v=shape-style-v3";

function toViewerKind(fileDoc = {}) {
  const previewKind = String(fileDoc.previewKind || "").toLowerCase();
  if (previewKind === "pdf" || previewKind === "text") return previewKind;
  const ext = String(fileDoc.extension || "").toLowerCase();
  const mime = String(fileDoc.normalizedMimeType || fileDoc.type || "").toLowerCase();
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if (ext === ".txt" || mime.startsWith("text/") || mime === "text/plain") return "text";
  return "unsupported";
}

function getDefaultPlacement(canvas) {
  const width = 420;
  const height = 520;
  if (!canvas) return { x: 120, y: 120, w: width, h: height };
  const zoom = canvas.getZoom ? canvas.getZoom() || 1 : 1;
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const offsetX = -(vpt[4] || 0) / zoom;
  const offsetY = -(vpt[5] || 0) / zoom;
  return {
    x: Math.max(16, offsetX + 60),
    y: Math.max(16, offsetY + 80),
    w: width,
    h: height,
  };
}

export function isViewableFile(fileDoc = {}) {
  return toViewerKind(fileDoc) !== "unsupported";
}

export async function createWhiteboardFileItem({
  boardId,
  userId,
  store,
  canvas,
  fileDoc,
}) {
  if (!boardId || !userId || !store || !fileDoc?.id) {
    throw new Error("Missing required file item creation context.");
  }
  const viewerKind = toViewerKind(fileDoc);
  if (viewerKind === "unsupported") {
    throw new Error("This file type is not supported for canvas viewing yet.");
  }

  const placement = getDefaultPlacement(canvas);
  const element = {
    id: store.createId(),
    type: "file",
    position: { x: placement.x, y: placement.y },
    size: { w: placement.w, h: placement.h },
    rotation: 0,
    isLocked: false,
    style: {},
    content: {
      fileId: fileDoc.id,
      storagePath: fileDoc.storagePath || "",
      fileName: fileDoc.name || "Untitled file",
      mimeType: fileDoc.normalizedMimeType || fileDoc.type || "",
      fileSize: Number(fileDoc.size || 0),
      viewerKind,
      currentPage: 1,
      totalPages: viewerKind === "pdf" ? Number(fileDoc.pageCount || 1) : 1,
      zoomLevel: 1,
      minimized: false,
    },
  };

  store.addElement(element, { persist: false });
  await createItem(boardId, element, userId);
  return element.id;
}
