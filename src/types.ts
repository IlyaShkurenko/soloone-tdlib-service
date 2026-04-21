export type AuthState =
  | "wait_phone_number"
  | "wait_other_device_confirmation"
  | "wait_code"
  | "wait_registration"
  | "wait_password"
  | "ready"
  | "closed";

export type TdlibEventType =
  | "auth_state"
  | "chats_updated"
  | "history_loaded"
  | "message_received"
  | "errors";

export type ChatKind = "private" | "group" | "channel" | "unknown";

export interface TdlibEvent<T = unknown> {
  type: TdlibEventType;
  sessionId: string;
  payload: T;
  ts: number;
}

export interface ChatSummary {
  id: number;
  title: string;
  unreadCount?: number;
  lastMessageSnippet?: string;
  lastMessageTs?: number;
  isPrivate?: boolean;
  isBot?: boolean;
  chatKind?: ChatKind;
  memberCount?: number;
}

export interface ChatDetails extends ChatSummary {
  phone?: string;
  username?: string;
  userId?: number;
}

export interface ChatMessage {
  id: number;
  chatId: number;
  senderLabel: "Me" | "Other";
  senderId?: number;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
}

export interface TelegramSessionInfo {
  sessionId: string;
  authState: AuthState;
  qrLink?: string;
  phone?: string;
  authCodeInfo?: {
    deliveryType?: string;
    rawType?: string;
    nextType?: string;
    timeout?: number;
  };
  createdAt: number;
}

export interface HistoryRange {
  startTs: number;
  endTs: number;
}

export interface TelegramAdapter {
  createSession(sessionId: string): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
  getSessionInfo(sessionId: string): TelegramSessionInfo;
  startQrAuthentication(sessionId: string): Promise<void>;
  setPhoneNumber(sessionId: string, phoneNumber: string): Promise<void>;
  submitCode(sessionId: string, code: string): Promise<void>;
  registerUser(sessionId: string, firstName: string, lastName?: string): Promise<void>;
  submitPassword(sessionId: string, password: string): Promise<void>;
  listChats(sessionId: string, limit?: number): Promise<ChatSummary[]>;
  getChatDetails(sessionId: string, chatId: number): Promise<ChatDetails>;
  getChatHistory(
    sessionId: string,
    chatId: number,
    limit: number,
    fromMessageId?: number,
  ): Promise<ChatMessage[]>;
  getChatHistoryByDate(
    sessionId: string,
    chatId: number,
    range: HistoryRange,
  ): Promise<ChatMessage[]>;
  getChatMessageByDate(
    sessionId: string,
    chatId: number,
    dateTs: number,
  ): Promise<ChatMessage | null>;
  getMessagesByIds(
    sessionId: string,
    chatId: number,
    ids: number[],
  ): Promise<ChatMessage[]>;
  markChatAsRead(
    sessionId: string,
    chatId: number,
  ): Promise<void>;
  sendMessage(
    sessionId: string,
    chatId: number,
    text: string,
  ): Promise<ChatMessage>;
  subscribe(sessionId: string, listener: (event: TdlibEvent) => void): () => void;
}
