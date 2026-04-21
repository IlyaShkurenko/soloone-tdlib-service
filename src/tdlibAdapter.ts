import fs from "node:fs";
import path from "node:path";

import { SessionEventBus } from "./eventBus.js";
import type {
  AuthState,
  ChatDetails,
  ChatMessage,
  ChatSummary,
  HistoryRange,
  TdlibEvent,
  TelegramAdapter,
  TelegramSessionInfo,
} from "./types.js";

type RawTdClient = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  invoke: (query: Record<string, unknown>) => Promise<any>;
  on: (event: "update" | "error", listener: (...args: any[]) => void) => void;
};

interface TdlibSession {
  info: TelegramSessionInfo;
  client: RawTdClient;
  myUserId?: number;
  chatsCache: Map<number, ChatSummary>;
  groupMemberCountCache: Map<string, number>;
}

type TdChatListType = "chatListMain" | "chatListArchive";

interface TdlibRuntimeConfig {
  apiId: number;
  apiHash: string;
  dataDir: string;
  tdlibPath?: string;
  maxGroupMembers?: number;
  applicationVersion?: string;
  deviceModel?: string;
  systemVersion?: string;
  systemLanguageCode?: string;
}

let tdlConfiguredOnce = false;
let tdlConfiguredTdjsonPath: string | undefined;

export class TdlibTelegramAdapter implements TelegramAdapter {
  private readonly sessions = new Map<string, TdlibSession>();

  constructor(
    private readonly bus: SessionEventBus,
    private readonly config: TdlibRuntimeConfig,
  ) {}

  async createSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      return;
    }

    const client = await this.buildClient(sessionId);
    const session: TdlibSession = {
      info: {
        sessionId,
        authState: "wait_phone_number",
        createdAt: Date.now(),
      },
      client,
      chatsCache: new Map(),
      groupMemberCountCache: new Map(),
    };
    this.sessions.set(sessionId, session);

    client.on("update", (update: any) => {
      void this.handleUpdate(sessionId, update);
    });

    client.on("error", (error: Error) => {
      this.emit(sessionId, "errors", { message: error.message });
    });

    try {
      await client.connect();
      const authStateRaw = await this.invokeWithTimeout<any>(
        session,
        {
          _: "getAuthorizationState",
        },
        4_000,
      );
      const authState = this.mapAuthState(authStateRaw);
      session.info.authState = authState;
      if (authState === "wait_other_device_confirmation") {
        session.info.qrLink = String(authStateRaw?.link ?? "");
      } else if (authState === "ready") {
        await this.syncOwnProfile(session);
      } else {
        session.info.phone = undefined;
      }
    } catch (error) {
      this.sessions.delete(sessionId);
      throw this.formatTdlibLoadError(error);
    }
    this.emit(sessionId, "auth_state", {
      authState: session.info.authState,
      qrLink: session.info.qrLink,
    });
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    await session.client.close();
    this.sessions.delete(sessionId);
    this.bus.clear(sessionId);
  }

  getSessionInfo(sessionId: string): TelegramSessionInfo {
    return this.mustGetSession(sessionId).info;
  }

  async setPhoneNumber(sessionId: string, phoneNumber: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    await session.client.invoke({
      _: "setAuthenticationPhoneNumber",
      phone_number: phoneNumber,
      settings: {
        _: "phoneNumberAuthenticationSettings",
        allow_flash_call: false,
        allow_missed_call: false,
        is_current_phone_number: false,
      },
    });
    await this.refreshAuthorizationState(sessionId, session);
  }

  async startQrAuthentication(sessionId: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    await session.client.invoke({
      _: "requestQrCodeAuthentication",
      other_user_ids: [],
    });
    session.info.authState = "wait_other_device_confirmation";
    this.emit(sessionId, "auth_state", {
      authState: session.info.authState,
      qrLink: session.info.qrLink,
    });
  }

  async submitCode(sessionId: string, code: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    await session.client.invoke({
      _: "checkAuthenticationCode",
      code,
    });
    await this.refreshAuthorizationState(sessionId, session);
  }

  async registerUser(sessionId: string, firstName: string, lastName?: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    await session.client.invoke({
      _: "registerUser",
      first_name: firstName,
      last_name: lastName?.trim() || "",
      accept_terms_of_service: true,
    });
    await this.refreshAuthorizationState(sessionId, session);
  }

  async submitPassword(sessionId: string, password: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    await session.client.invoke({
      _: "checkAuthenticationPassword",
      password,
    });
    await this.refreshAuthorizationState(sessionId, session);
  }

  async listChats(sessionId: string, limit = 100): Promise<ChatSummary[]> {
    const session = this.mustGetSession(sessionId);
    const requestedLimit = Math.min(Math.max(limit * 3, 200), 1000);
    const cachedChatsAtStart = [...session.chatsCache.values()]
      .filter((chat) => this.isChatAllowed(chat))
      .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
    const allChatIds = new Set<number>();
    const startedAt = Date.now();
    for (const listType of ["chatListMain", "chatListArchive"] as TdChatListType[]) {
      await this.preloadChats(session, listType, 2);
      try {
        const result = await this.invokeWithTimeout<{ chat_ids?: number[] }>(
          session,
          {
            _: "getChats",
            chat_list: {
              _: listType,
            },
            limit: requestedLimit,
          },
          8_000,
        );

        const chatIds = (result?.chat_ids ?? []) as number[];
        for (const chatId of chatIds) {
          allChatIds.add(chatId);
        }
      } catch {
        continue;
      }
    }
    const chatIds = [...allChatIds];
    if (chatIds.length === 0) {
      const fallback = cachedChatsAtStart.slice(0, limit);
      this.emit(sessionId, "chats_updated", { chats: fallback });
      return fallback;
    }

    const chats: ChatSummary[] = [];
    const chunkSize = 20;
    const target = Math.max(limit * 2, limit);

    for (let index = 0; index < chatIds.length; index += chunkSize) {
      if (Date.now() - startedAt > 20_000) {
        break;
      }
      const chunk = chatIds.slice(index, index + chunkSize);
      const mappedChunk = await Promise.all(
        chunk.map(async (chatId) => {
          try {
            const chat = await this.invokeWithTimeout(
              session,
              {
                _: "getChat",
                chat_id: chatId,
              },
              3_000,
            );
            const mapped = this.mapChat(chat);
            if (mapped.chatKind === "private") {
              await this.enrichPrivateChat(session, chat, mapped);
            }
            if (mapped.chatKind === "group") {
              mapped.memberCount = await this.resolveGroupMemberCount(session, chat);
            }
            return mapped;
          } catch {
            return null;
          }
        }),
      );

      for (const mapped of mappedChunk) {
        if (!mapped || !this.isChatAllowed(mapped)) {
          if (mapped) {
            session.chatsCache.delete(mapped.id);
          }
          continue;
        }
        session.chatsCache.set(mapped.id, mapped);
        chats.push(mapped);
      }

      if (chats.length >= target) {
        break;
      }
    }

    const fromCache = [...session.chatsCache.values()]
      .filter((chat) => this.isChatAllowed(chat))
      .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0))
      .slice(0, limit);
    const sorted =
      fromCache.length > 0
        ? fromCache
        : chats.sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0)).slice(0, limit);

    this.emit(sessionId, "chats_updated", { chats: sorted });
    return sorted;
  }

  async getChatDetails(sessionId: string, chatId: number): Promise<ChatDetails> {
    const session = this.mustGetSession(sessionId);
    const chat = await this.invokeWithTimeout<any>(
      session,
      {
        _: "getChat",
        chat_id: chatId,
      },
      4_000,
    );

    const mapped = this.mapChat(chat);
    const details: ChatDetails = {
      ...mapped,
    };

    if (mapped.chatKind === "private") {
      const privateUserId = this.extractPrivateUserId(chat);
      if (privateUserId) {
        details.userId = privateUserId;

        try {
          const user = await this.invokeWithTimeout<any>(
            session,
            {
              _: "getUser",
              user_id: privateUserId,
            },
            4_000,
          );

          details.isBot = this.isTelegramBotUser(user);

          const phone = typeof user?.phone_number === "string" ? user.phone_number.trim() : "";
          if (phone) {
            details.phone = phone;
          }

          const username = this.extractUsername(user);
          if (username) {
            details.username = username;
          }
        } catch {
          // Best-effort only. Chat is still usable without extra user details.
        }
      }
    }

    return details;
  }

  async getChatHistory(
    sessionId: string,
    chatId: number,
    limit: number,
    fromMessageId?: number,
  ): Promise<ChatMessage[]> {
    const session = this.mustGetSession(sessionId);
    const response = await session.client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: fromMessageId ?? 0,
      offset: 0,
      limit,
      only_local: false,
    });

    const result = (response?.messages ?? [])
      .map((message: any) => this.mapMessage(session, chatId, message))
      .filter((message: ChatMessage | null): message is ChatMessage => Boolean(message))
      .sort((a: ChatMessage, b: ChatMessage) => a.timestamp - b.timestamp);

    this.emit(sessionId, "history_loaded", { chatId, count: result.length });
    return result;
  }

  async getChatHistoryByDate(
    sessionId: string,
    chatId: number,
    range: HistoryRange,
  ): Promise<ChatMessage[]> {
    const session = this.mustGetSession(sessionId);
    const inRange: ChatMessage[] = [];

    let fromMessageId = 0;
    let keepLoading = true;
    let iteration = 0;

    while (keepLoading && iteration < 40) {
      iteration += 1;
      const response = await session.client.invoke({
        _: "getChatHistory",
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: 100,
        only_local: false,
      });

      const messages = (response?.messages ?? []) as any[];
      if (messages.length === 0) {
        break;
      }

      for (const rawMessage of messages) {
        const mapped = this.mapMessage(session, chatId, rawMessage);
        if (!mapped) {
          continue;
        }
        if (mapped.timestamp >= range.startTs && mapped.timestamp <= range.endTs) {
          inRange.push(mapped);
        }
      }

      const oldest = messages[messages.length - 1];
      const oldestTs = Number(oldest?.date ?? 0) * 1000;
      if (oldestTs < range.startTs) {
        keepLoading = false;
      }
      fromMessageId = Number(oldest?.id ?? 0);
      if (fromMessageId === 0) {
        break;
      }
    }

    const deduped = new Map<number, ChatMessage>();
    for (const message of inRange) {
      deduped.set(message.id, message);
    }

    const result = [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
    this.emit(sessionId, "history_loaded", { chatId, count: result.length, mode: "range" });
    return result;
  }

  async getChatMessageByDate(
    sessionId: string,
    chatId: number,
    dateTs: number,
  ): Promise<ChatMessage | null> {
    const session = this.mustGetSession(sessionId);
    const response = await session.client.invoke({
      _: "getChatMessageByDate",
      chat_id: chatId,
      date: Math.floor(dateTs / 1000),
    });

    if (!response || typeof response !== "object" || !("id" in response)) {
      return null;
    }

    return this.mapMessage(session, chatId, response);
  }

  async getMessagesByIds(sessionId: string, chatId: number, ids: number[]): Promise<ChatMessage[]> {
    const session = this.mustGetSession(sessionId);
    if (ids.length === 0) {
      return [];
    }

    const response = await session.client.invoke({
      _: "getMessages",
      chat_id: chatId,
      message_ids: ids,
    });

    return (response?.messages ?? [])
      .map((message: any) => this.mapMessage(session, chatId, message))
      .filter((message: ChatMessage | null): message is ChatMessage => Boolean(message))
      .sort((a: ChatMessage, b: ChatMessage) => a.timestamp - b.timestamp);
  }

  async markChatAsRead(sessionId: string, chatId: number): Promise<void> {
    const session = this.mustGetSession(sessionId);
    const history = await session.client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: 0,
      offset: 0,
      limit: 100,
      only_local: false,
    });

    const incomingMessageIds = ((history?.messages ?? []) as any[])
      .filter((message) => Number(message?.sender_user_id ?? 0) !== Number(session.myUserId ?? 0))
      .map((message) => Number(message?.id ?? 0))
      .filter((id) => Number.isFinite(id) && id > 0);

    await session.client.invoke({
      _: "openChat",
      chat_id: chatId,
    });

    if (incomingMessageIds.length > 0) {
      await session.client.invoke({
        _: "viewMessages",
        chat_id: chatId,
        message_ids: incomingMessageIds,
        force_read: true,
      });
    }

    const existingChat = session.chatsCache.get(chatId);
    if (existingChat) {
      session.chatsCache.set(chatId, {
        ...existingChat,
        unreadCount: 0,
      });

      const chats = [...session.chatsCache.values()]
        .filter((chat) => this.isChatAllowed(chat))
        .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0))
        .slice(0, 100);

      this.emit(sessionId, "chats_updated", { chats });
    }
  }

  async sendMessage(sessionId: string, chatId: number, text: string): Promise<ChatMessage> {
    const session = this.mustGetSession(sessionId);
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("Message text is required");
    }

    const response = await session.client.invoke({
      _: "sendMessage",
      chat_id: chatId,
      input_message_content: {
        _: "inputMessageText",
        text: {
          _: "formattedText",
          text: normalized,
          entities: [],
        },
        clear_draft: true,
      },
    });

    const mapped = this.mapMessage(session, chatId, response);
    if (!mapped) {
      throw new Error("Failed to map sent message");
    }

    const existingChat = session.chatsCache.get(chatId);
    if (existingChat) {
      session.chatsCache.set(chatId, {
        ...existingChat,
        lastMessageSnippet: mapped.text,
        lastMessageTs: mapped.timestamp,
      });
      const chats = [...session.chatsCache.values()]
        .filter((chat) => this.isChatAllowed(chat))
        .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0))
        .slice(0, 100);
      this.emit(sessionId, "chats_updated", { chats });
    }

    return mapped;
  }

  subscribe(sessionId: string, listener: (event: TdlibEvent) => void): () => void {
    return this.bus.subscribe(sessionId, listener);
  }

  private async buildClient(sessionId: string): Promise<RawTdClient> {
    const tdlModule = await import("tdl");
    const resolvedTdlModule = ((tdlModule as any).default ?? tdlModule) as Record<string, unknown>;
    const ClientCtor =
      (resolvedTdlModule.Client as new (...args: any[]) => unknown | undefined) ??
      ((tdlModule as any).Client as new (...args: any[]) => unknown | undefined);
    const createClientFn =
      (resolvedTdlModule.createClient as ((opts: Record<string, unknown>) => unknown) | undefined) ??
      ((tdlModule as any).createClient as ((opts: Record<string, unknown>) => unknown) | undefined);
    const configureFn =
      (resolvedTdlModule.configure as ((cfg: Record<string, unknown>) => void) | undefined) ??
      ((tdlModule as any).configure as ((cfg: Record<string, unknown>) => void) | undefined);

    const sessionDir = path.join(this.config.dataDir, sessionId);
    const dbDir = path.join(sessionDir, "db");
    const filesDir = path.join(sessionDir, "files");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });

    const resolvedTdlibPath = await this.resolveTdlibPath();
    const tdlibParameters = {
      use_message_database: true,
      use_chat_info_database: true,
      use_file_database: true,
      use_secret_chats: false,
      use_test_dc: false,
      system_language_code: this.config.systemLanguageCode ?? "en",
      application_version: this.config.applicationVersion ?? "11.9",
      device_model: this.config.deviceModel ?? "Telegram Chat Analyzer",
      system_version: this.config.systemVersion ?? `Node ${process.version} (${process.platform})`,
    };
    const clientOptions = {
      apiId: this.config.apiId,
      apiHash: this.config.apiHash,
      databaseDirectory: dbDir,
      filesDirectory: filesDir,
      // tdl v7 uses tdlibParameters instead of top-level db flags.
      tdlibParameters,
    };

    let client: unknown;

    if (typeof createClientFn === "function" && typeof configureFn === "function") {
      try {
        if (!tdlConfiguredOnce) {
          configureFn({
            ...(resolvedTdlibPath ? { tdjson: resolvedTdlibPath } : {}),
          });
          tdlConfiguredOnce = true;
          tdlConfiguredTdjsonPath = resolvedTdlibPath;
        } else if (
          resolvedTdlibPath &&
          tdlConfiguredTdjsonPath &&
          resolvedTdlibPath !== tdlConfiguredTdjsonPath
        ) {
          // tdl@7 can't be reconfigured after first init; keep first path and log once.
          console.warn(
            `[tdlib-service] tdl already configured with tdjson path "${tdlConfiguredTdjsonPath}", ignoring new path "${resolvedTdlibPath}"`,
          );
        }
        client = createClientFn(clientOptions);
      } catch (error) {
        throw this.formatTdlibLoadError(error);
      }
    } else {
      const addonModule = await import("tdl-tdlib-addon");
      const resolvedAddonModule = ((addonModule as any).default ?? addonModule) as Record<string, unknown>;
      const TDLibCtor =
        (resolvedAddonModule.TDLib as new (...args: any[]) => unknown | undefined) ??
        ((addonModule as any).TDLib as new (...args: any[]) => unknown | undefined);

      if (typeof ClientCtor !== "function") {
        throw new Error(
          `Failed to resolve tdl Client constructor. Module keys: ${Object.keys(resolvedTdlModule).join(", ")}`,
        );
      }
      if (typeof TDLibCtor !== "function") {
        throw new Error(
          `Failed to resolve tdl-tdlib-addon TDLib constructor. Module keys: ${Object.keys(resolvedAddonModule).join(", ")}`,
        );
      }

      let tdlibInstance: unknown;
      try {
        tdlibInstance = resolvedTdlibPath ? new TDLibCtor(resolvedTdlibPath) : new TDLibCtor();
      } catch (error) {
        throw this.formatTdlibLoadError(error);
      }

      client = new ClientCtor(tdlibInstance, {
        apiId: this.config.apiId,
        apiHash: this.config.apiHash,
        databaseDirectory: dbDir,
        filesDirectory: filesDir,
        tdlibParameters,
        useDatabase: true,
        useFileDatabase: true,
        useChatInfoDatabase: true,
        useMessageDatabase: true,
        enableStorageOptimizer: true,
      });
    }

    const normalizedClient = client as {
      connect?: () => Promise<void>;
      close?: () => Promise<void>;
      invoke?: (query: Record<string, unknown>) => Promise<any>;
      on?: (event: "update" | "error", listener: (...args: any[]) => void) => unknown;
    };

    if (typeof normalizedClient.invoke !== "function" || typeof normalizedClient.on !== "function") {
      throw new Error("TDLib client does not expose expected invoke/on methods");
    }

    return {
      connect:
        typeof normalizedClient.connect === "function"
          ? normalizedClient.connect.bind(normalizedClient)
          : async () => undefined,
      close:
        typeof normalizedClient.close === "function"
          ? normalizedClient.close.bind(normalizedClient)
          : async () => undefined,
      invoke: normalizedClient.invoke.bind(normalizedClient),
      on: normalizedClient.on.bind(normalizedClient) as RawTdClient["on"],
    };
  }

  private async resolveTdlibPath(): Promise<string | undefined> {
    try {
      const prebuiltTdlibModule = await import("prebuilt-tdlib");
      const getTdjson = (prebuiltTdlibModule as { getTdjson?: (() => string) | undefined }).getTdjson;
      const candidate = typeof getTdjson === "function" ? getTdjson() : undefined;
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Package is optional. Fall back to explicit/system library paths.
    }

    const explicitPaths = [this.config.tdlibPath, process.env.TDLIB_LIBRARY_PATH].filter(
      (value): value is string => Boolean(value && value.trim()),
    );

    for (const candidate of explicitPaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const commonMacPaths = [
      "/opt/homebrew/lib/libtdjson.dylib",
      "/usr/local/lib/libtdjson.dylib",
      "/usr/lib/libtdjson.dylib",
    ];

    for (const candidate of commonMacPaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private formatTdlibLoadError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const likelyMissingNativeLibrary =
      message.includes("Dynamic Loading Error") || message.includes("libtdjson");

    if (!likelyMissingNativeLibrary) {
      return error instanceof Error ? error : new Error("TDLib initialization failed");
    }

    return new Error(
      "TDLib native library (libtdjson.dylib) is missing. Install TDLib and set TDLIB_LIBRARY_PATH, " +
        "for example: /opt/homebrew/lib/libtdjson.dylib. You can also switch to TDLIB_MODE=mock to test without Telegram.",
    );
  }

  private async handleUpdate(sessionId: string, update: any): Promise<void> {
    if (!update || typeof update !== "object") {
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (update._ === "updateAuthorizationState") {
      const authState = this.mapAuthState(update.authorization_state);
      session.info.authState = authState;
      session.info.qrLink =
        authState === "wait_other_device_confirmation"
          ? String(update.authorization_state?.link ?? "")
          : undefined;
      session.info.authCodeInfo =
        authState === "wait_code"
          ? this.extractAuthCodeInfo(update.authorization_state?.code_info)
          : undefined;
      if (authState === "ready") {
        try {
          await this.syncOwnProfile(session);
        } catch {
          // Ignore profile sync failures; the session is still usable.
        }
      } else {
        session.info.phone = undefined;
      }
      this.emit(sessionId, "auth_state", {
        authState,
        qrLink: session.info.qrLink,
        authCodeInfo: session.info.authCodeInfo,
        phone: session.info.phone,
      });

      if (authState === "ready") {
        try {
          await this.listChats(sessionId, 100);
        } catch (error) {
          this.emit(sessionId, "errors", {
            message: error instanceof Error ? error.message : "Failed to load profile",
          });
        }
      }
      return;
    }

    if (update._ === "updateNewMessage") {
      const chatId = Number(update.message?.chat_id ?? 0);
      const mapped = this.mapMessage(session, chatId, update.message);
      if (!mapped) {
        return;
      }
      const existingChat = session.chatsCache.get(chatId);
      if (existingChat) {
        const isOwnMessage = mapped.senderLabel === "Me";
        session.chatsCache.set(chatId, {
          ...existingChat,
          lastMessageSnippet: mapped.text,
          lastMessageTs: mapped.timestamp,
          unreadCount: isOwnMessage ? existingChat.unreadCount ?? 0 : (existingChat.unreadCount ?? 0) + 1,
        });
        const chats = [...session.chatsCache.values()]
          .filter((chat) => this.isChatAllowed(chat))
          .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0))
          .slice(0, 100);
        this.emit(sessionId, "chats_updated", { chats });
      }
      this.emit(sessionId, "message_received", {
        chatId,
        message: mapped,
      });
      return;
    }

    if (update._ === "updateMessageSendSucceeded") {
      const chatId = Number(update.message?.chat_id ?? 0);
      const mapped = this.mapMessage(session, chatId, update.message);
      if (mapped && mapped.id > 0 && chatId > 0) {
        this.emit(sessionId, "message_received", {
          chatId,
          message: mapped,
        });
      }
      return;
    }

    if (update._ === "updateNewChat" || update._ === "updateChatLastMessage") {
      if (update._ === "updateChatLastMessage") {
        const chatId = Number(update.chat_id ?? update.chat?.id ?? update.last_message?.chat_id ?? 0);
        const mapped = this.mapMessage(session, chatId, update.last_message);
        if (mapped && mapped.id > 0 && chatId > 0) {
          this.emit(sessionId, "message_received", {
            chatId,
            message: mapped,
          });
        }
      }

      try {
        const chats = await this.listChats(sessionId, 100);
        this.emit(sessionId, "chats_updated", { chats });
      } catch (error) {
        this.emit(sessionId, "errors", {
          message: error instanceof Error ? error.message : "Failed to refresh chats",
        });
      }
    }
  }

  private mapAuthState(rawState: any): AuthState {
    const state = rawState?._;
    switch (state) {
      case "authorizationStateWaitPhoneNumber":
        return "wait_phone_number";
      case "authorizationStateWaitOtherDeviceConfirmation":
        return "wait_other_device_confirmation";
      case "authorizationStateWaitCode":
        return "wait_code";
      case "authorizationStateWaitRegistration":
        return "wait_registration";
      case "authorizationStateWaitPassword":
        return "wait_password";
      case "authorizationStateReady":
        return "ready";
      default:
        return "closed";
    }
  }

  private extractAuthCodeInfo(codeInfo: any):
    | {
        deliveryType?: string;
        rawType?: string;
        nextType?: string;
        timeout?: number;
      }
    | undefined {
    if (!codeInfo || typeof codeInfo !== "object") {
      return undefined;
    }

    const rawType = this.readTdType(codeInfo?.type);
    const nextType = this.readTdType(codeInfo?.next_type);
    const timeout = Number(codeInfo?.timeout ?? 0);

    return {
      deliveryType: this.mapAuthCodeDeliveryType(rawType),
      rawType,
      nextType,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    };
  }

  private mapAuthCodeDeliveryType(rawType?: string): string | undefined {
    switch (rawType) {
      case "authenticationCodeTypeTelegramMessage":
        return "telegram";
      case "authenticationCodeTypeSms":
      case "authenticationCodeTypeSmsWord":
      case "authenticationCodeTypeSmsPhrase":
        return "sms";
      case "authenticationCodeTypeCall":
      case "authenticationCodeTypeFlashCall":
      case "authenticationCodeTypeMissedCall":
        return "call";
      case "authenticationCodeTypeEmailAddress":
        return "email";
      case "authenticationCodeTypeFragment":
        return "fragment";
      case "authenticationCodeTypeFirebaseAndroid":
      case "authenticationCodeTypeFirebaseIos":
        return "firebase";
      default:
        return rawType || undefined;
    }
  }

  private async refreshAuthorizationState(sessionId: string, session: TdlibSession): Promise<void> {
    try {
      const authStateRaw = await this.invokeWithTimeout<any>(
        session,
        { _: "getAuthorizationState" },
        4_000,
      );

      const authState = this.mapAuthState(authStateRaw);
      session.info.authState = authState;
      session.info.qrLink =
        authState === "wait_other_device_confirmation"
          ? String(authStateRaw?.link ?? "")
          : undefined;
      session.info.authCodeInfo =
        authState === "wait_code"
          ? this.extractAuthCodeInfo(authStateRaw?.code_info)
          : undefined;
      if (authState === "ready") {
        await this.syncOwnProfile(session);
      } else {
        session.info.phone = undefined;
      }

      this.emit(sessionId, "auth_state", {
        authState,
        qrLink: session.info.qrLink,
        authCodeInfo: session.info.authCodeInfo,
        phone: session.info.phone,
      });
    } catch {
      // Ignore refresh failures here; TDLib updates can still arrive asynchronously.
    }
  }

  private async syncOwnProfile(session: TdlibSession): Promise<void> {
    const me = await session.client.invoke({ _: "getMe" });
    const myUserId = Number(me?.id ?? 0);
    session.myUserId = Number.isFinite(myUserId) && myUserId > 0 ? myUserId : undefined;

    const phone = typeof me?.phone_number === "string" ? me.phone_number.trim() : "";
    session.info.phone = phone || undefined;
  }

  private mapChat(chat: any): ChatSummary {
    const lastMessageTs = Number(chat?.last_message?.date ?? 0) * 1000;
    const chatKind = this.getChatKind(chat);
    return {
      id: Number(chat?.id ?? 0),
      title: String(chat?.title ?? "Unknown chat"),
      unreadCount: Number(chat?.unread_count ?? 0),
      lastMessageSnippet: this.extractMessageText(chat?.last_message),
      lastMessageTs: Number.isFinite(lastMessageTs) ? lastMessageTs : undefined,
      isPrivate: chatKind === "private",
      chatKind,
      memberCount: undefined,
    };
  }

  private async enrichPrivateChat(session: TdlibSession, chat: any, mapped: ChatSummary): Promise<void> {
    const privateUserId = this.extractPrivateUserId(chat);
    if (!privateUserId) {
      return;
    }

    try {
      const user = await this.invokeWithTimeout<any>(
        session,
        {
          _: "getUser",
          user_id: privateUserId,
        },
        2_000,
      );
      mapped.isBot = this.isTelegramBotUser(user);
    } catch {
      // If user lookup times out, keep the chat. getChatDetails will still block bot persistence later.
    }
  }

  private extractPrivateUserId(chat: any): number | undefined {
    const type = chat?.type;
    if (!type || typeof type !== "object") {
      return undefined;
    }

    const tdType = this.readTdType(type);
    if (tdType !== "chatTypePrivate") {
      return undefined;
    }

    const userId = Number(type.user_id ?? 0);
    return Number.isFinite(userId) && userId > 0 ? userId : undefined;
  }

  private extractUsername(user: any): string | undefined {
    const direct = typeof user?.username === "string" ? user.username.trim() : "";
    if (direct) {
      return direct;
    }

    const editable = typeof user?.usernames?.editable_username === "string"
      ? user.usernames.editable_username.trim()
      : "";
    if (editable) {
      return editable;
    }

    const active = Array.isArray(user?.usernames?.active_usernames)
      ? user.usernames.active_usernames.find((value: unknown) => typeof value === "string" && value.trim().length > 0)
      : undefined;

    return typeof active === "string" ? active.trim() : undefined;
  }

  private isTelegramBotUser(user: any): boolean {
    const userType = this.readTdType(user?.type);
    return userType === "userTypeBot" || Boolean(user?.is_bot ?? user?.isBot);
  }

  private mapMessage(session: TdlibSession, chatId: number, message: any): ChatMessage | null {
    const text = this.extractMessageText(message);

    const senderUserId = this.extractSenderUserId(message?.sender_id);
    const senderLabel = senderUserId !== null && senderUserId === session.myUserId ? "Me" : "Other";
    const replyToMessageId = this.extractReplyToMessageId(message);

    return {
      id: Number(message?.id ?? 0),
      chatId,
      senderLabel,
      senderId: senderUserId ?? undefined,
      text,
      timestamp: Number(message?.date ?? 0) * 1000,
      replyToMessageId,
    };
  }

  private extractReplyToMessageId(message: any): number | undefined {
    const directReplyId = Number(
      message?.reply_to_message_id ??
        message?.reply_to?.message_id ??
        message?.reply_to?.origin?.message_id ??
        message?.content?.reply_to_message_id ??
        0,
    );
    if (Number.isFinite(directReplyId) && directReplyId > 0) {
      return directReplyId;
    }

    const replyTo = message?.reply_to;
    if (!replyTo || typeof replyTo !== "object") {
      return undefined;
    }

    const type = this.readTdType(replyTo);
    if (type === "messageReplyToMessage") {
      const id = Number(
        replyTo.message_id ??
          replyTo?.origin?.message_id ??
          replyTo?.origin?.sender_message_id ??
          0,
      );
      if (Number.isFinite(id) && id > 0) {
        return id;
      }
    }

    const nestedId = Number(
      replyTo.message_id ??
        replyTo?.origin?.message_id ??
        replyTo?.origin?.sender_message_id ??
        0,
    );
    if (Number.isFinite(nestedId) && nestedId > 0) {
      return nestedId;
    }

    return undefined;
  }

  private extractSenderUserId(senderId: any): number | null {
    if (!senderId || typeof senderId !== "object") {
      return null;
    }
    const type = this.readTdType(senderId);
    if (type === "messageSenderUser") {
      return Number(senderId.user_id ?? 0);
    }
    return null;
  }

  private extractMessageText(message: any): string {
    const content = message?.content;
    if (!content || typeof content !== "object") {
      return "[Unsupported message]";
    }

    const contentType = this.readTdType(content);

    if (contentType === "messageText") {
      return String(content.text?.text ?? "").trim() || "[Text message]";
    }

    if (contentType === "messagePhoto") {
      return String(content.caption?.text ?? "").trim() || "[Photo]";
    }

    if (contentType === "messageDocument") {
      return String(content.caption?.text ?? "").trim() || "[Document]";
    }

    if (contentType === "messageVideo") {
      return String(content.caption?.text ?? "").trim() || "[Video]";
    }

    if (contentType === "messageAudio") {
      return String(content.caption?.text ?? "").trim() || "[Audio]";
    }

    if (contentType === "messageAnimation") {
      return String(content.caption?.text ?? "").trim() || "[GIF]";
    }

    if (contentType === "messageVoiceNote") {
      return "[Voice message]";
    }

    if (contentType === "messageSticker") {
      return "[Sticker]";
    }

    if (contentType === "messageCall") {
      return "[Call]";
    }

    if (contentType === "messageChatAddMembers") {
      return "[Members added]";
    }

    if (contentType === "messageChatDeleteMember") {
      return "[Member removed]";
    }

    if (contentType === "messagePinMessage") {
      return "[Pinned message]";
    }

    return `[${String(contentType ?? "Unsupported message")}]`;
  }

  private getChatKind(chat: any): "private" | "group" | "channel" | "unknown" {
    const chatType = chat?.type;
    const typeName = this.readTdType(chatType);
    const normalizedType = String(typeName ?? "").toLowerCase();
    if (normalizedType.includes("private") || normalizedType.includes("secret")) {
      return "private";
    }
    if (normalizedType.includes("basicgroup")) {
      return "group";
    }
    if (normalizedType.includes("supergroup")) {
      const isChannel =
        chatType && typeof chatType === "object"
          ? Boolean((chatType as { is_channel?: unknown; isChannel?: unknown }).is_channel ?? (chatType as { isChannel?: unknown }).isChannel)
          : false;
      return isChannel ? "channel" : "group";
    }
    if (normalizedType.includes("channel")) {
      return "channel";
    }

    if (chatType && typeof chatType === "object") {
      if (
        this.hasPositiveId(chatType.user_id) ||
        this.hasPositiveId(chatType.userId) ||
        this.hasPositiveId(chatType.secret_chat_id) ||
        this.hasPositiveId(chatType.secretChatId)
      ) {
        return "private";
      }
      if (
        this.hasPositiveId(chatType.basic_group_id) ||
        this.hasPositiveId(chatType.basicGroupId) ||
        this.hasPositiveId(chatType.supergroup_id) ||
        this.hasPositiveId(chatType.supergroupId)
      ) {
        const isChannel = Boolean(chatType.is_channel ?? chatType.isChannel);
        return isChannel ? "channel" : "group";
      }
      if (
        this.hasPositiveId(chatType.channel_id) ||
        this.hasPositiveId(chatType.channelId)
      ) {
        return "channel";
      }
    }

    return "unknown";
  }

  private isChatAllowed(chat: ChatSummary): boolean {
    if (chat.chatKind === "private") {
      return chat.isBot !== true;
    }
    if (chat.chatKind !== "group") {
      return false;
    }

    const maxGroupMembers = this.getMaxGroupMembers();
    if (!maxGroupMembers) {
      return true;
    }

    const count = chat.memberCount;
    if (typeof count !== "number" || !Number.isFinite(count)) {
      return false;
    }
    return count < maxGroupMembers;
  }

  private getMaxGroupMembers(): number | undefined {
    const value = this.config.maxGroupMembers;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  private async resolveGroupMemberCount(session: TdlibSession, chat: any): Promise<number | undefined> {
    const chatType = chat?.type;
    const basicGroupId = this.toPositiveInt(chatType?.basic_group_id ?? chatType?.basicGroupId);
    if (basicGroupId) {
      const key = `basic:${basicGroupId}`;
      const cached = session.groupMemberCountCache.get(key);
      if (typeof cached === "number" && Number.isFinite(cached)) {
        return cached;
      }

      let count = this.toPositiveInt(chat?.member_count ?? chat?.memberCount);
      if (!count) {
        try {
          const basicGroup = await this.invokeWithTimeout<any>(
            session,
            {
              _: "getBasicGroup",
              basic_group_id: basicGroupId,
            },
            2_500,
          );
          count = this.toPositiveInt(basicGroup?.member_count ?? basicGroup?.memberCount);
        } catch {
          return undefined;
        }
      }

      if (count) {
        session.groupMemberCountCache.set(key, count);
      }
      return count;
    }

    const supergroupId = this.toPositiveInt(chatType?.supergroup_id ?? chatType?.supergroupId);
    if (supergroupId) {
      const key = `super:${supergroupId}`;
      const cached = session.groupMemberCountCache.get(key);
      if (typeof cached === "number" && Number.isFinite(cached)) {
        return cached;
      }

      let count = this.toPositiveInt(chat?.member_count ?? chat?.memberCount);
      if (!count) {
        try {
          const supergroup = await this.invokeWithTimeout<any>(
            session,
            {
              _: "getSupergroup",
              supergroup_id: supergroupId,
            },
            2_500,
          );
          count = this.toPositiveInt(supergroup?.member_count ?? supergroup?.memberCount);
        } catch {
          return undefined;
        }
      }

      if (count) {
        session.groupMemberCountCache.set(key, count);
      }
      return count;
    }

    return this.toPositiveInt(chat?.member_count ?? chat?.memberCount);
  }

  private toPositiveInt(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return Math.floor(parsed);
  }

  private hasPositiveId(value: unknown): boolean {
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0;
    }
    if (typeof value === "bigint") {
      return value > 0n;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0;
    }
    return false;
  }

  private emit(sessionId: string, type: TdlibEvent["type"], payload: unknown): void {
    this.bus.emit({
      type,
      sessionId,
      payload,
      ts: Date.now(),
    });
  }

  private async preloadChats(
    session: TdlibSession,
    listType: TdChatListType,
    attempts: number,
  ): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
      try {
        await this.invokeWithTimeout(
          session,
          {
            _: "loadChats",
            chat_list: {
              _: listType,
            },
            limit: 100,
          },
          3_000,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (message.includes("chat list is empty")) {
          break;
        }
        if (message.includes("flood") || message.includes("too many requests")) {
          break;
        }
      }
    }
  }

  private async invokeWithTimeout<T>(
    session: TdlibSession,
    query: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<T>([
        session.client.invoke(query) as Promise<T>,
        new Promise<T>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`TDLib invoke timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private readTdType(entity: any): string | undefined {
    if (!entity || typeof entity !== "object") {
      return undefined;
    }
    if (typeof entity._ === "string") {
      return entity._;
    }
    if (typeof entity["@type"] === "string") {
      return entity["@type"];
    }
    if (typeof entity.type === "string") {
      return entity.type;
    }
    return undefined;
  }

  private mustGetSession(sessionId: string): TdlibSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }
}
