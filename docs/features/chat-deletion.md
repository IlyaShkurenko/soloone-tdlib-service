# Telegram chat deletion

## Contract requirements

- `TG-CHAT-DEL-1.1` `DELETE /sessions/:sessionId/chats/:chatId` removes the chat history from the authenticated Telegram account and removes the chat from its chat list.
- `TG-CHAT-DEL-1.2` Real mode invokes TDLib `deleteChatHistory` with `remove_from_chat_list: true` and `revoke: false`; deletion affects the current account only and does not revoke messages for the other participant.
- `TG-CHAT-DEL-1.3` Mock and real adapters expose the same `deleteChat` operation. Mock mode removes the chat and its messages and publishes a `chats_updated` event.
- `TG-CHAT-DEL-1.4` Unknown sessions or chats fail through the existing HTTP error boundary. Success returns `{ "ok": true }`.

## Integration

The main backend owns authorization and customer persistence. It calls this session-scoped endpoint only after proving that the customer belongs to the authenticated provider and resolving that provider's linked Telegram session.

## Executable coverage

`tests/chat-deletion.test.ts` verifies mock adapter removal and the updated chat-list event. Real TDLib behavior requires an authenticated runtime and is validated by compile-time adapter parity plus deployment smoke testing.
