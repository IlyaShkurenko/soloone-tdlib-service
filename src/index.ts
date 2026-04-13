import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { customAlphabet } from "nanoid";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createAdapter } from "./adapterFactory.js";

dotenv.config();
const tdlibModuleDir = path.dirname(fileURLToPath(import.meta.url));
for (const candidatePath of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
  path.resolve(tdlibModuleDir, "../.env"),
  path.resolve(tdlibModuleDir, "../../.env"),
]) {
  dotenv.config({ path: candidatePath });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.TDLIB_SERVICE_PORT ?? 4002);
const mode = (process.env.TDLIB_MODE ?? "mock") as "mock" | "real";
const apiId = process.env.TDLIB_API_ID ? Number(process.env.TDLIB_API_ID) : undefined;
const apiHash = process.env.TDLIB_API_HASH;
const tdlibPath = process.env.TDLIB_LIBRARY_PATH;
const tdlibDataDir = process.env.TDLIB_DATA_DIR ?? "./tdlib-data";
const maxGroupMembersRaw = Number(process.env.TDLIB_MAX_GROUP_MEMBERS ?? 20);
const maxGroupMembers =
  Number.isFinite(maxGroupMembersRaw) && maxGroupMembersRaw > 0 ? Math.floor(maxGroupMembersRaw) : 20;
const tdlibApplicationVersion = process.env.TDLIB_APPLICATION_VERSION ?? "11.9";
const tdlibDeviceModel = process.env.TDLIB_DEVICE_MODEL ?? "Telegram Chat Analyzer";
const tdlibSystemVersion = process.env.TDLIB_SYSTEM_VERSION ?? `Node ${process.version} (${process.platform})`;
const tdlibSystemLanguageCode = process.env.TDLIB_SYSTEM_LANGUAGE_CODE ?? "en";

const { adapter } = createAdapter({
  mode,
  apiId,
  apiHash,
  tdlibPath,
  tdlibDataDir,
  maxGroupMembers,
  applicationVersion: tdlibApplicationVersion,
  deviceModel: tdlibDeviceModel,
  systemVersion: tdlibSystemVersion,
  systemLanguageCode: tdlibSystemLanguageCode,
});

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 16);
const sessions = new Set<string>();
const sessionInitLocks = new Map<string, Promise<void>>();

const phoneSchema = z.object({
  phoneNumber: z.string().min(6),
});

const resumeSchema = z.object({
  sessionId: z.string().min(8).max(128),
});

const codeSchema = z.object({
  code: z.string().min(3),
});

const passwordSchema = z.object({
  password: z.string().min(1),
});

const registrationSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().optional().default(""),
});

const idsSchema = z.object({
  ids: z.array(z.number().int()).max(1000),
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode });
});

app.post("/sessions", async (_req, res) => {
  try {
    const sessionId = await generateUniqueSessionId();
    await ensureSessionInitialized(sessionId);
    const info = adapter.getSessionInfo(sessionId);
    res.status(201).json(info);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/resume", async (req, res) => {
  try {
    const { sessionId } = resumeSchema.parse(req.body);
    await ensureSessionInitialized(sessionId);
    const info = adapter.getSessionInfo(sessionId);
    res.status(200).json(info);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId", (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const info = adapter.getSessionInfo(sessionId);
    res.json(info);
  } catch (error) {
    handleError(res, error);
  }
});

app.delete("/sessions/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    await adapter.destroySession(sessionId);
    sessions.delete(sessionId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/auth/phone", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const { phoneNumber } = phoneSchema.parse(req.body);
    await adapter.setPhoneNumber(sessionId, phoneNumber);
    const info = adapter.getSessionInfo(sessionId);
    res.json({ ok: true, ...info });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/auth/qr", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    await adapter.startQrAuthentication(sessionId);
    const info = adapter.getSessionInfo(sessionId);
    res.json({ ok: true, ...info });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/auth/code", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const { code } = codeSchema.parse(req.body);
    await adapter.submitCode(sessionId, code);
    const info = adapter.getSessionInfo(sessionId);
    res.json({ ok: true, ...info });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/auth/register", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const { firstName, lastName } = registrationSchema.parse(req.body);
    await adapter.registerUser(sessionId, firstName, lastName);
    const info = adapter.getSessionInfo(sessionId);
    res.json({ ok: true, ...info });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/auth/password", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const { password } = passwordSchema.parse(req.body);
    await adapter.submitPassword(sessionId, password);
    const info = adapter.getSessionInfo(sessionId);
    res.json({ ok: true, ...info });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId/chats", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const limit = Number(req.query.limit ?? 100);
    const chats = await adapter.listChats(sessionId, limit);
    res.json({ chats });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId/chats/:chatId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);

    const chat = await adapter.getChatDetails(sessionId, chatId);
    res.json({ chat });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId/chats/:chatId/history", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);
    const limit = Number(req.query.limit ?? 100);
    const fromMessageId = req.query.fromMessageId ? Number(req.query.fromMessageId) : undefined;

    const messages = await adapter.getChatHistory(sessionId, chatId, limit, fromMessageId);
    res.json({ messages });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/chats/:chatId/read", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);

    await adapter.markChatAsRead(sessionId, chatId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId/chats/:chatId/history-by-date", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);
    const startTs = Number(req.query.startTs);
    const endTs = Number(req.query.endTs);

    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
      throw new Error("startTs and endTs are required");
    }

    const messages = await adapter.getChatHistoryByDate(sessionId, chatId, { startTs, endTs });
    res.json({ messages });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId/chats/:chatId/message-by-date", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);
    const dateTs = Number(req.query.dateTs);

    if (!Number.isFinite(dateTs)) {
      throw new Error("dateTs is required");
    }

    const message = await adapter.getChatMessageByDate(sessionId, chatId, dateTs);
    res.json({ message });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/chats/:chatId/messages/by-ids", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);
    const { ids } = idsSchema.parse(req.body);

    const messages = await adapter.getMessagesByIds(sessionId, chatId, ids);
    res.json({ messages });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/sessions/:sessionId/chats/:chatId/messages", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);
    const chatId = Number(req.params.chatId);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

    if (!text) {
      throw new Error("Message text is required");
    }

    const message = await adapter.sendMessage(sessionId, chatId, text);
    res.json({ message });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/sessions/:sessionId/events", (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSessionExists(sessionId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const unsubscribe = adapter.subscribe(sessionId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
    }, 20_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.listen(port, () => {
  console.log(`tdlib-service listening on :${port} in ${mode} mode`);
});

function assertSessionExists(sessionId: string): void {
  if (!sessions.has(sessionId)) {
    throw new Error(`Unknown session ${sessionId}`);
  }
}

async function generateUniqueSessionId(): Promise<string> {
  let attempts = 0;
  while (attempts < 5) {
    attempts += 1;
    const candidate = nanoid();
    if (!sessions.has(candidate) && !sessionInitLocks.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Failed to generate unique session id");
}

async function ensureSessionInitialized(sessionId: string): Promise<void> {
  if (sessions.has(sessionId)) {
    return;
  }

  const inFlight = sessionInitLocks.get(sessionId);
  if (inFlight) {
    await inFlight;
    return;
  }

  const initializePromise = (async () => {
    await adapter.createSession(sessionId);
    sessions.add(sessionId);
  })();

  sessionInitLocks.set(sessionId, initializePromise);
  try {
    await initializePromise;
  } finally {
    sessionInitLocks.delete(sessionId);
  }
}

function handleError(res: express.Response, error: unknown): void {
  const message = (() => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (error && typeof error === "object") {
      const maybeMessage = "message" in error ? (error as { message?: unknown }).message : undefined;
      if (typeof maybeMessage === "string" && maybeMessage.trim()) {
        return maybeMessage;
      }
      try {
        return JSON.stringify(error);
      } catch {
        return "Unexpected error";
      }
    }
    return "Unexpected error";
  })();
  const status = message.includes("Unknown session") ? 404 : 400;
  res.status(status).json({ error: message });
}
