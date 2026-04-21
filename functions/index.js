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
      const { whiteboardId, prompt } = req.body || {};

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

      const response = await openai.responses.create({
        model: DEFAULT_MODEL,
        input: prompt
      });

      const answer = getResponseText(response);

      await db.collection(`whiteboards/${whiteboardId}/aiMessages`).add({
        userId: user.uid,
        userPrompt: prompt,
        assistantReply: answer,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ answer });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);