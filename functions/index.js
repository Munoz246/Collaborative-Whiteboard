const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const OpenAI = require("openai");

admin.initializeApp();
const db = admin.firestore();

const KEY_ENCRYPTION_SECRET = defineSecret("KEY_ENCRYPTION_SECRET");
const DEFAULT_MODEL = "gpt-4.1-mini";

async function requireAuth(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    throw new Error("Missing auth token.");
  }
  return admin.auth().verifyIdToken(match[1]);
}

function getEncryptionKey() {
  return crypto
    .createHash("sha256")
    .update(KEY_ENCRYPTION_SECRET.value(), "utf8")
    .digest();
}

function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptText(payload) {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

function getResponseText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  for (const item of response.output || []) {
    for (const part of item.content || []) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return "No response";
}

exports.saveOpenAiKey = onRequest(
  { secrets: [KEY_ENCRYPTION_SECRET] },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "POST only" });
        return;
      }

      const user = await requireAuth(req);
      const apiKey = String(req.body?.apiKey || "").trim();

      if (!apiKey) {
        throw new Error("Missing API key");
      }

      await db.doc(`users/${user.uid}/private/openai`).set(
        {
          encryptedApiKey: encryptText(apiKey),
          last4: apiKey.slice(-4),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      res.json({ ok: true, last4: apiKey.slice(-4) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

exports.askWhiteboardAssistant = onRequest(
  { secrets: [KEY_ENCRYPTION_SECRET] },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "POST only" });
        return;
      }

      const user = await requireAuth(req);
      const { whiteboardId, prompt, files = [], boardState = {} } = req.body || {};

      if (!whiteboardId) {
        throw new Error("Missing whiteboardId");
      }
      if (!prompt) {
        throw new Error("Missing prompt");
      }

      const boardDoc = await db.doc(`whiteboards/${whiteboardId}`).get();

      if (!boardDoc.exists) {
        throw new Error("Whiteboard not found");
      }

      const boardData = boardDoc.data();

      if (!boardData.members?.includes(user.uid)) {
        throw new Error("You are not a member of this whiteboard");
      }

      const keyDoc = await db.doc(`users/${user.uid}/private/openai`).get();
      if (!keyDoc.exists) {
        throw new Error("No API key saved");
      }

      const apiKey = decryptText(keyDoc.data().encryptedApiKey);
      const openai = new OpenAI({ apiKey });

      const safeFiles = Array.isArray(files) ? files : [];

      //debug logging to verify file contents and structure before sending to OpenAI
      console.log("AI request files:", safeFiles.map(f => ({
        name: f?.name,
        type: f?.type,
        textPreview: typeof f?.text === "string"
          ? f.text.slice(0, 50)
          : null
      })));

      const fileTextBlocks = safeFiles
        .filter((file) => file && typeof file.text === "string")
        .map((file, index) => {
          const fileName = typeof file.name === "string" && file.name.trim()
            ? file.name.trim()
            : `file-${index + 1}`;
          const fileType = typeof file.type === "string" && file.type.trim()
            ? file.type.trim()
            : "text/plain";

          return (
            `BEGIN ATTACHED FILE ${index + 1}\n` +
            `Name: ${fileName}\n` +
            `Type: ${fileType}\n` +
            `Contents:\n${file.text.slice(0, 12000)}\n` +
            `END ATTACHED FILE ${index + 1}`
          );
        });
      //file remembering for ai
      for (const file of safeFiles) {
        if (typeof file?.text === "string" && file.text.trim()) {
          await db.collection(`whiteboards/${whiteboardId}/aiFiles`).add({
            name: file.name || "Untitled file",
            type: file.type || "text/plain",
            text: file.text.slice(0, 50000),
            uploadedBy: user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      function shouldUseRememberedFiles(prompt, currentFilesCount) {
        const text = String(prompt || "").toLowerCase();

        if (currentFilesCount > 0) return true;

        return [
          "file",
          "files",
          "document",
          "pdf",
          "doc",
          "attachment",
          "uploaded",
          "upload",
          "from earlier",
          "from before",
          "remember",
        ].some((word) => text.includes(word));
      }

      function scoreRememberedFile(file, prompt) {
        const promptText = String(prompt || "").toLowerCase();
        const fileName = String(file.name || "").toLowerCase();
        const fileType = String(file.type || "").toLowerCase();
        const fileText = String(file.text || "").toLowerCase();

        let score = 0;

        for (const word of promptText.split(/\s+/)) {
          const cleanWord = word.replace(/[^\w]/g, "");
          if (cleanWord.length < 3) continue;

          if (fileName.includes(cleanWord)) score += 5;
          if (fileType.includes(cleanWord)) score += 2;
          if (fileText.includes(cleanWord)) score += 1;
        }

        return score;
      }

      let rememberedFileBlocks = [];

      if (shouldUseRememberedFiles(prompt, safeFiles.length)) {
        const rememberedFilesSnap = await db
          .collection(`whiteboards/${whiteboardId}/aiFiles`)
          .orderBy("createdAt", "desc")
          .limit(20)
          .get();

        const scoredFiles = rememberedFilesSnap.docs
          .map((doc) => doc.data())
          .map((file) => ({
            file,
            score: scoreRememberedFile(file, prompt),
          }))
          .filter((item) => item.score > 0 || safeFiles.length > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);

        rememberedFileBlocks = scoredFiles.map(({ file }, index) => (
          `RELEVANT REMEMBERED FILE ${index + 1}\n` +
          `Name: ${file.name || "Untitled file"}\n` +
          `Type: ${file.type || "text/plain"}\n` +
          `Contents:\n${String(file.text || "").slice(0, 12000)}`
        ));
      }
      //debugging for remembered files in "firebase functions:log"
      console.log("Remembered files sent:", rememberedFileBlocks.length);
      

      //ai calls
      const response = await openai.responses.create({
        model: DEFAULT_MODEL,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You are a helpful assistant for a collaborative whiteboard. " +
                  "When attached files are present, treat them as the highest-priority source for file-related questions. " +
                  "You may also use remembered files from previous messages when relevant. " +
                  "Only  reference the whiteboard when asked" +
                  "Do not confuse whiteboard geometry/state data with attached file contents."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `User prompt:\n${prompt}`
              },
              {
                type: "input_text",
                text: `Attached files count: ${safeFiles.length}`
              },
              ...fileTextBlocks.map((textBlock) => ({
                type: "input_text",
                text: textBlock
              })),
              ...rememberedFileBlocks.map((textBlock) => ({
                type: "input_text",
                text: textBlock
              })),
              {
                type: "input_text",
                text: `Whiteboard state (use only when relevant):\n${JSON.stringify(boardState, null, 2).slice(0, 12000)}`
              }
            ]
          }
        ]
      });

      const answer = getResponseText(response);

      await db.collection(`whiteboards/${whiteboardId}/aiMessages`).add({
        userId: user.uid,
        userPrompt: prompt,
        assistantReply: answer,
        attachedFiles: (Array.isArray(files) ? files : []).map((file) => ({
          name: file?.name || "",
          type: file?.type || "",
          size: typeof file?.text === "string" ? file.text.length : 0,
        })),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ answer });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);
//ai chat history
exports.getAiHistory = onRequest(
  { secrets: [KEY_ENCRYPTION_SECRET] },
  async (req, res) => {
    try {
      const user = await requireAuth(req);
      const { whiteboardId } = req.body || {};

      if (!whiteboardId) {
        throw new Error("Missing whiteboardId");
      }

      const boardDoc = await db.doc(`whiteboards/${whiteboardId}`).get();

      if (!boardDoc.exists) {
        throw new Error("Whiteboard not found");
      }

      const boardData = boardDoc.data();

      if (!boardData.members?.includes(user.uid)) {
        throw new Error("You are not a member of this whiteboard");
      }

      const snap = await db
        .collection(`whiteboards/${whiteboardId}/aiMessages`)
        .orderBy("createdAt", "asc")
        .limit(50)
        .get();

      res.json({
        messages: snap.docs.map((doc) => doc.data())
      });

    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);