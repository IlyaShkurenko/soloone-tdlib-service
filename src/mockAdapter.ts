import { SessionEventBus } from "./eventBus.js";
import type {
  ChatDetails,
  ChatMessage,
  ChatSummary,
  HistoryRange,
  TdlibEvent,
  TelegramAdapter,
  TelegramSessionInfo,
} from "./types.js";

interface MockSession {
  info: TelegramSessionInfo;
  chats: ChatSummary[];
  messagesByChatId: Map<number, ChatMessage[]>;
}

export class MockTelegramAdapter implements TelegramAdapter {
  private readonly sessions = new Map<string, MockSession>();

  constructor(private readonly bus: SessionEventBus) {}

  async createSession(sessionId: string): Promise<void> {
    const now = Date.now();
    const mockSession: MockSession = {
      info: {
        sessionId,
        authState: "wait_phone_number",
        phone: undefined,
        authCodeInfo: undefined,
        createdAt: now,
      },
      chats: [
        {
          id: 1,
          title: "Alex",
          unreadCount: 1,
          lastMessageSnippet: "Can we talk later?",
          lastMessageTs: now - 1000 * 60 * 70,
          isPrivate: true,
        },
        {
          id: 2,
          title: "Team Chat",
          unreadCount: 0,
          lastMessageSnippet: "Release moved to Friday",
          lastMessageTs: now - 1000 * 60 * 60 * 8,
          isPrivate: false,
        },
      ],
      messagesByChatId: new Map([
        [
          1,
          [
            {
              id: 101,
              chatId: 1,
              senderLabel: "Other",
              senderId: 10,
              text: "Hey, are you free tonight?",
              timestamp: now - 1000 * 60 * 90,
            },
            {
              id: 102,
              chatId: 1,
              senderLabel: "Me",
              senderId: 11,
              text: "I can be. What happened?",
              timestamp: now - 1000 * 60 * 80,
            },
            {
              id: 103,
              chatId: 1,
              senderLabel: "Other",
              senderId: 10,
              text: "Can we talk later?",
              timestamp: now - 1000 * 60 * 70,
              replyToMessageId: 102,
            },
          ],
        ],
        [
          2,
          [
            {
              id: 201,
              chatId: 2,
              senderLabel: "Other",
              senderId: 25,
              text: "Release moved to Friday",
              timestamp: now - 1000 * 60 * 60 * 10,
            },
            {
              id: 202,
              chatId: 2,
              senderLabel: "Me",
              senderId: 11,
              text: "Noted, I will update the backlog.",
              timestamp: now - 1000 * 60 * 60 * 8,
            },
          ],
        ],
      ]),
    };

    this.sessions.set(sessionId, mockSession);
    this.emit(sessionId, "auth_state", { authState: "wait_phone_number" });
  }

  async destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.bus.clear(sessionId);
  }

  getSessionInfo(sessionId: string): TelegramSessionInfo {
    const session = this.mustGetSession(sessionId);
    return session.info;
  }

  async startQrAuthentication(sessionId: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    session.info.authState = "wait_other_device_confirmation";
    session.info.qrLink = `tg://login?token=mock-${Date.now()}`;
    session.info.authCodeInfo = undefined;
    this.emit(sessionId, "auth_state", {
      authState: "wait_other_device_confirmation",
      qrLink: session.info.qrLink,
    });

    setTimeout(() => {
      const stillExists = this.sessions.get(sessionId);
      if (!stillExists) {
        return;
      }
      stillExists.info.authState = "ready";
      stillExists.info.qrLink = undefined;
      this.emit(sessionId, "auth_state", { authState: "ready" });
      this.emit(sessionId, "chats_updated", { chats: this.visibleChats(stillExists) });
    }, 2500).unref();
  }

  async setPhoneNumber(sessionId: string, phoneNumber: string): Promise<void> {
    if (!phoneNumber.startsWith("+")) {
      throw new Error("Phone number must start with + in mock mode");
    }
    const session = this.mustGetSession(sessionId);
    session.info.phone = phoneNumber.replace(/\D/g, "");
    session.info.authState = "wait_code";
    session.info.qrLink = undefined;
    session.info.authCodeInfo = {
      deliveryType: "sms",
      rawType: "authenticationCodeTypeSms",
      timeout: 60,
    };
    this.emit(sessionId, "auth_state", {
      authState: "wait_code",
      authCodeInfo: session.info.authCodeInfo,
    });
  }

  async submitCode(sessionId: string, code: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    if (code === "00000") {
      session.info.authState = "wait_password";
      session.info.qrLink = undefined;
      session.info.authCodeInfo = undefined;
      this.emit(sessionId, "auth_state", { authState: "wait_password" });
      return;
    }
    if (code.length < 4) {
      throw new Error("Invalid code in mock mode");
    }
    if (code === "11111") {
      session.info.authState = "wait_registration";
      session.info.qrLink = undefined;
      session.info.authCodeInfo = undefined;
      this.emit(sessionId, "auth_state", { authState: "wait_registration" });
      return;
    }
    session.info.authState = "ready";
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    this.emit(sessionId, "auth_state", { authState: "ready" });
    this.emit(sessionId, "chats_updated", { chats: this.visibleChats(session) });
  }

  async registerUser(sessionId: string, firstName: string, lastName?: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    if (!firstName.trim()) {
      throw new Error("First name required in mock mode");
    }
    session.info.authState = "ready";
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    this.emit(sessionId, "auth_state", {
      authState: "ready",
      profile: {
        firstName: firstName.trim(),
        lastName: lastName?.trim() || undefined,
      },
    });
    this.emit(sessionId, "chats_updated", { chats: this.visibleChats(session) });
  }

  async submitPassword(sessionId: string, password: string): Promise<void> {
    const session = this.mustGetSession(sessionId);
    if (!password) {
      throw new Error("Password required in mock mode");
    }
    session.info.authState = "ready";
    session.info.qrLink = undefined;
    session.info.authCodeInfo = undefined;
    this.emit(sessionId, "auth_state", { authState: "ready" });
    this.emit(sessionId, "chats_updated", { chats: this.visibleChats(session) });
  }

  async listChats(sessionId: string, limit = 100): Promise<ChatSummary[]> {
    const session = this.mustGetSession(sessionId);
    return session.chats
      .filter((chat) => chat.isPrivate)
      .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0))
      .slice(0, limit);
  }

  async getChatDetails(sessionId: string, chatId: number): Promise<ChatDetails> {
    const session = this.mustGetSession(sessionId);
    const chat = session.chats.find((item) => item.id === chatId);

    if (!chat) {
      throw new Error("Chat not found in mock mode");
    }

    return {
      ...chat,
      phone: chatId === 1 ? "447700900123" : "",
      username: chatId === 1 ? "alex" : undefined,
      userId: chatId === 1 ? 10 : undefined,
    };
  }

  async getChatHistory(
    sessionId: string,
    chatId: number,
    limit: number,
    fromMessageId?: number,
  ): Promise<ChatMessage[]> {
    const messages = [...this.mustGetMessages(sessionId, chatId)].sort((a, b) => b.id - a.id);
    const filtered = fromMessageId
      ? messages.filter((message) => message.id < fromMessageId)
      : messages;
    const result = filtered.slice(0, limit).sort((a, b) => a.timestamp - b.timestamp);
    this.emit(sessionId, "history_loaded", { chatId, count: result.length });
    return result;
  }

  async getChatHistoryByDate(
    sessionId: string,
    chatId: number,
    range: HistoryRange,
  ): Promise<ChatMessage[]> {
    const result = this.mustGetMessages(sessionId, chatId)
      .filter((message) => message.timestamp >= range.startTs && message.timestamp <= range.endTs)
      .sort((a, b) => a.timestamp - b.timestamp);
    this.emit(sessionId, "history_loaded", { chatId, count: result.length, mode: "range" });
    return result;
  }

  async getChatMessageByDate(sessionId: string, chatId: number, dateTs: number): Promise<ChatMessage | null> {
    const messages = this.mustGetMessages(sessionId, chatId)
      .filter((message) => message.timestamp <= dateTs)
      .sort((a, b) => b.timestamp - a.timestamp);
    return messages[0] ?? null;
  }

  async getMessagesByIds(sessionId: string, chatId: number, ids: number[]): Promise<ChatMessage[]> {
    const idSet = new Set(ids);
    return this.mustGetMessages(sessionId, chatId)
      .filter((message) => idSet.has(message.id))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async markChatAsRead(sessionId: string, chatId: number): Promise<void> {
    const session = this.mustGetSession(sessionId);
    session.chats = session.chats.map((chat) => (
      chat.id === chatId
        ? {
            ...chat,
            unreadCount: 0,
          }
        : chat
    ));

    this.emit(sessionId, "chats_updated", { chats: this.visibleChats(session) });
  }

  async sendMessage(sessionId: string, chatId: number, text: string): Promise<ChatMessage> {
    const session = this.mustGetSession(sessionId);
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("Message text is required");
    }

    const chatMessages = this.mustGetMessages(sessionId, chatId);
    const nextId = Math.max(0, ...chatMessages.map((message) => message.id)) + 1;
    const message: ChatMessage = {
      id: nextId,
      chatId,
      senderLabel: "Me",
      senderId: 11,
      text: normalized,
      timestamp: Date.now(),
    };

    chatMessages.push(message);
    session.chats = session.chats.map((chat) =>
      chat.id === chatId
        ? {
            ...chat,
            lastMessageSnippet: normalized,
            lastMessageTs: message.timestamp,
          }
        : chat,
    );

    this.emit(sessionId, "chats_updated", { chats: this.visibleChats(session) });
    return message;
  }

  subscribe(sessionId: string, listener: (event: TdlibEvent) => void): () => void {
    return this.bus.subscribe(sessionId, listener);
  }

  private emit(sessionId: string, type: TdlibEvent["type"], payload: unknown): void {
    this.bus.emit({
      type,
      sessionId,
      payload,
      ts: Date.now(),
    });
  }

  private mustGetSession(sessionId: string): MockSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }

  private mustGetMessages(sessionId: string, chatId: number): ChatMessage[] {
    const session = this.mustGetSession(sessionId);
    const messages = session.messagesByChatId.get(chatId);
    if (!messages) {
      throw new Error(`Unknown chat ${chatId}`);
    }
    return messages;
  }

  private visibleChats(session: MockSession): ChatSummary[] {
    return session.chats
      .filter((chat) => chat.isPrivate)
      .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
  }
}
