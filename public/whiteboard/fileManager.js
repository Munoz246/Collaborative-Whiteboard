import { currentUser } from "./auth.js";

const db = window.firebase.firestore();
const storage = window.firebase.storage();

const ALLOWED_EXTENSIONS = [".txt", ".pdf", ".doc"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function normalizeMimeType(file) {
  const ext = getExtension(file?.name || "");
  const type = String(file?.type || "").trim().toLowerCase();
  if (type) return type;
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".doc") return "application/msword";
  return "application/octet-stream";
}

function resolvePreviewKind(mimeType, extension) {
  const ext = String(extension || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime.startsWith("text/") || mime === "text/plain" || ext === ".txt") return "text";
  return "unsupported";
}

function filesCollection(boardId) {
  return db.collection("whiteboards").doc(boardId).collection("files");
}

function getExtension(fileName) {
  const lower = String(fileName || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isAllowedFile(file) {
  return ALLOWED_EXTENSIONS.includes(getExtension(file.name));
}

function safeFileName(fileName) {
  return String(fileName || "file")
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(0, 120);
}

export function subscribeToWhiteboardFiles(boardId, onChange, onError) {
  return filesCollection(boardId)
    .orderBy("createdAt", "desc")
    .onSnapshot((snapshot) => {
      const files = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      onChange(files);
    }, onError);
}

export async function uploadWhiteboardFiles(boardId, fileList) {
  const user = currentUser();
  if (!user) throw new Error("You must be signed in.");

  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    if (!isAllowedFile(file)) {
      throw new Error(`Unsupported file type: ${file.name}. Allowed: .txt, .pdf, .doc`);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`${file.name} is too large. Max size is 10 MB.`);
    }

    const cleanName = safeFileName(file.name);
    const fileId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const storagePath = `whiteboards/${boardId}/files/${fileId}-${cleanName}`;

    const storageRef = storage.ref(storagePath);

    const normalizedMimeType = normalizeMimeType(file);
    const extension = getExtension(file.name);
    const previewKind = resolvePreviewKind(normalizedMimeType, extension);
    await storageRef.put(file, {
      contentType: normalizedMimeType,
      customMetadata: {
        boardId,
        uploadedBy: user.uid,
        originalName: file.name,
      },
    });

    await filesCollection(boardId).doc(fileId).set({
      name: file.name,
      storagePath,
      size: file.size,
      type: normalizedMimeType,
      normalizedMimeType,
      extension,
      previewKind,
      uploadedBy: user.uid,
      createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
}

export async function getWhiteboardFileDownloadUrl(storagePath) {
  return storage.ref(storagePath).getDownloadURL();
}

export async function deleteWhiteboardFile(boardId, fileId, storagePath) {
  await storage.ref(storagePath).delete();
  await filesCollection(boardId).doc(fileId).delete();
}