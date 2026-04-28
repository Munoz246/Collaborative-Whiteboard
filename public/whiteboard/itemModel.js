/**
 * Helpers for translating between local whiteboard elements and Firestore item documents.
 *
 * Local model stays compatible with existing canvas code (`position/size/rotation/style/content`).
 * Firestore model adds shared metadata and a structured type-specific `data` payload.
 */

function stableStringify(value) {
  return JSON.stringify(value ?? null);
}

function isEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

const SHAPE_KINDS = new Set(["rectangle", "circle", "triangle", "rhombus"]);

function isShapeType(type) {
  return SHAPE_KINDS.has(type);
}

function normalizeShapeKind(kind, fallback = "rectangle") {
  if (typeof kind !== "string") return fallback;
  return SHAPE_KINDS.has(kind) ? kind : fallback;
}

function pickTypeData(localItem) {
  if (isShapeType(localItem.type)) {
    const shapeKind = normalizeShapeKind(localItem.content?.shapeKind ?? localItem.type);
    return {
      shape: {
        shapeKind,
        // Keep legacy shapeType for backward compatibility.
        shapeType: shapeKind,
        fill: localItem.style?.fill ?? "rgba(37, 99, 235, 0.35)",
        stroke: localItem.style?.stroke ?? "#2563eb",
        strokeWidth: localItem.style?.strokeWidth ?? 2,
      },
    };
  }

  if (localItem.type === "path") {
    return {
      drawing: {
        color: localItem.style?.stroke ?? "#111827",
        strokeWidth: localItem.style?.strokeWidth ?? 2,
        points: localItem.content?.points ?? [],
        closed: !!localItem.content?.closed,
      },
    };
  }

  if (localItem.type === "text" || localItem.type === "note") {
    return {
      note: {
        text: localItem.content?.text ?? "",
        color: localItem.style?.fill ?? "#111827",
        fontSize: localItem.style?.fontSize ?? 20,
        textAlign: localItem.style?.textAlign ?? "left",
      },
    };
  }

  if (localItem.type === "file") {
    return {
      file: {
        documentId: localItem.content?.documentId ?? "",
        fileName: localItem.content?.fileName ?? "",
        fileType: localItem.content?.fileType ?? "",
      },
    };
  }

  return { other: {} };
}

export function toFirestoreItem(localItem, userId, timestampValue) {
  const now = timestampValue;
  const transform = {
    x: localItem.position?.x ?? 0,
    y: localItem.position?.y ?? 0,
    width: localItem.size?.w ?? 1,
    height: localItem.size?.h ?? 1,
    rotation: localItem.rotation ?? 0,
  };

  const payload = {
    type: localItem.type ?? "rectangle",
    transform,
    isLocked: !!localItem.isLocked,
    data: pickTypeData(localItem),
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    updatedBy: userId,
  };
  return payload;
}

export function fromFirestoreItem(doc) {
  const data = typeof doc.data === "function" ? doc.data() : doc;
  if (!data) return null;

  const transform = data.transform ?? {};
  const shapeData = data.data?.shape;
  const drawingData = data.data?.drawing;
  const noteData = data.data?.note;
  const fileData = data.data?.file;

  let type = data.type ?? "rectangle";
  let style = {};
  let content = {};

  if (shapeData) {
    const resolvedShapeKind = normalizeShapeKind(shapeData.shapeKind ?? shapeData.shapeType ?? data.type);
    type = resolvedShapeKind;
    style = {
      fill: shapeData.fill ?? "rgba(37, 99, 235, 0.35)",
      stroke: shapeData.stroke ?? "#2563eb",
      strokeWidth: shapeData.strokeWidth ?? 2,
    };
    content = { shapeKind: resolvedShapeKind };
  } else if (drawingData) {
    type = "path";
    style = {
      stroke: drawingData.color ?? "#111827",
      strokeWidth: drawingData.strokeWidth ?? 2,
      fill: "",
    };
    content = {
      points: drawingData.points ?? [],
      closed: !!drawingData.closed,
    };
  } else if (noteData) {
    type = "text";
    style = {
      fill: noteData.color ?? "#111827",
      fontSize: noteData.fontSize ?? 20,
      textAlign: noteData.textAlign ?? "left",
    };
    content = { text: noteData.text ?? "" };
  } else if (fileData) {
    // Render files as text placeholders until dedicated file UI is implemented.
    type = "text";
    style = {
      fill: "#111827",
      fontSize: 16,
      textAlign: "left",
    };
    content = { text: fileData.fileName ? `[File] ${fileData.fileName}` : "[File]" };
  } else if (isShapeType(data.type)) {
    const fallbackKind = normalizeShapeKind(data.type);
    type = fallbackKind;
    style = {
      fill: "rgba(37, 99, 235, 0.35)",
      stroke: "#2563eb",
      strokeWidth: 2,
    };
    content = { shapeKind: fallbackKind };
  }

  return {
    id: doc.id ?? data.id,
    type,
    position: { x: transform.x ?? 0, y: transform.y ?? 0 },
    size: { w: transform.width ?? 1, h: transform.height ?? 1 },
    rotation: transform.rotation ?? 0,
    style,
    content,
    isLocked: !!data.isLocked,
    updatedAt: data.updatedAt ?? null,
    updatedBy: data.updatedBy ?? null,
    createdAt: data.createdAt ?? null,
    createdBy: data.createdBy ?? null,
  };
}

export function buildItemPatch(previousItem, nextItem, userId, timestampValue) {
  const prevTransform = {
    x: previousItem.position?.x ?? 0,
    y: previousItem.position?.y ?? 0,
    width: previousItem.size?.w ?? 1,
    height: previousItem.size?.h ?? 1,
    rotation: previousItem.rotation ?? 0,
  };
  const nextTransform = {
    x: nextItem.position?.x ?? 0,
    y: nextItem.position?.y ?? 0,
    width: nextItem.size?.w ?? 1,
    height: nextItem.size?.h ?? 1,
    rotation: nextItem.rotation ?? 0,
  };

  const patch = {};
  if (!isEqual(prevTransform, nextTransform)) patch.transform = nextTransform;
  if (!!previousItem.isLocked !== !!nextItem.isLocked) patch.isLocked = !!nextItem.isLocked;

  const prevData = pickTypeData(previousItem);
  const nextData = pickTypeData(nextItem);
  if (!isEqual(previousItem.type, nextItem.type)) patch.type = nextItem.type;
  if (!isEqual(prevData, nextData)) patch.data = nextData;

  if (Object.keys(patch).length === 0) return null;
  patch.updatedAt = timestampValue;
  patch.updatedBy = userId;
  return patch;
}
