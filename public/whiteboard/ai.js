import { currentUser } from "./auth.js";

async function post(url, body) {
  const user = currentUser();
  if (!user) throw new Error("Not signed in");

  const token = await user.getIdToken();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");

  return data;
}

export async function saveOpenAiKey(apiKey) {
  return post("/api/saveOpenAiKey", { apiKey });
}

export async function askAI({ whiteboardId, prompt, boardState, files = [] }) {
  return post("/api/askWhiteboardAssistant", {
    whiteboardId,
    prompt,
    boardState,
    files
  });
}

export function addMessage(role, text) {
  const container = document.getElementById("aiMessages");

  const el = document.createElement("div");
  el.className = `ai-message ${role === "user" ? "user" : "bot"}`;
  el.textContent = text;

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

export async function getAiHistory(whiteboardId) {
  return post("/api/getAiHistory", { whiteboardId });
}