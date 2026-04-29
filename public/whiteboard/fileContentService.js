import { getWhiteboardFileDownloadUrl } from "./fileManager.js";

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
let pdfJsLoadingPromise = null;
let pdfJsModule = null;

async function loadPdfJs() {
  if (pdfJsModule) return pdfJsModule;
  if (!pdfJsLoadingPromise) {
    pdfJsLoadingPromise = import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/build/pdf.min.mjs")
      .then((mod) => {
        const resolved = mod?.default ?? mod;
        resolved.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136/build/pdf.worker.min.mjs";
        globalThis.pdfjsLib = resolved;
        pdfJsModule = resolved;
        return resolved;
      });
  }
  return pdfJsLoadingPromise;
}

export async function getFileDownloadUrl(storagePath) {
  if (!storagePath) throw new Error("Missing storage path.");
  return getWhiteboardFileDownloadUrl(storagePath);
}

export async function getTextFilePreview(storagePath) {
  const url = await getFileDownloadUrl(storagePath);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Could not download text file (${res.status}).`);
  }
  const blob = await res.blob();
  const isTruncated = blob.size > MAX_TEXT_PREVIEW_BYTES;
  const previewBlob = isTruncated ? blob.slice(0, MAX_TEXT_PREVIEW_BYTES) : blob;
  const text = await previewBlob.text();
  return {
    text,
    isTruncated,
    originalSize: blob.size,
    previewSize: previewBlob.size,
  };
}

export async function loadPdfDocument(storagePath) {
  const url = await getFileDownloadUrl(storagePath);
  const pdfjsLib = await loadPdfJs();
  let loadingTask;
  try {
    loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: false,
    });
  } catch (err) {
    throw err;
  }
  try {
    return await loadingTask.promise;
  } catch (err) {
    const loadFailed = /load failed/i.test(String(err?.message || ""));
    if (!loadFailed) throw err;
    const retryTask = pdfjsLib.getDocument({
      url,
      withCredentials: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
    });
    try {
      return await retryTask.promise;
    } catch (retryErr) {
      throw retryErr;
    }
  }
}
