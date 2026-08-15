# TDLib service architecture

## Role

This Express service isolates Telegram TDLib runtime and authentication from the main backend. It exposes session, authentication, chat, history, message, read-state, and event operations through a stable HTTP boundary.

## Adapter boundary

`src/adapterFactory.ts` selects either the mock or real TDLib adapter from `TDLIB_MODE`. Both implement the `TelegramAdapter` contract in `src/types.ts`. Changes to that interface must be reflected in both adapters, the HTTP boundary, and backend callers.

Mock mode is the default and supports development without a native TDLib runtime. Real mode requires Telegram API credentials, a TDLib library, and a configured data directory.

## Sessions and authentication

`src/index.ts` creates session IDs, tracks active sessions in process memory, serializes concurrent initialization for the same session, and delegates durable TDLib state to the adapter/data directory. The authentication state machine supports phone, QR confirmation, code, registration, password, ready, and closed states.

Session identifiers are the API's routing key. Do not change their lifecycle, resume behavior, or error semantics without coordinating persisted backend configuration and recovery behavior.

## HTTP and event boundary

The service exposes:

- `/health` with the active adapter mode;
- session creation, resume, lookup, and deletion;
- phone, QR, code, registration, and password authentication operations;
- chat listing and details;
- history by cursor or date, targeted message lookup, read state, and message sending;
- per-session event streaming for auth, chat, history, message, and error updates.

Input validation uses Zod at the HTTP boundary. The default port is `4003`.

## Data and deployment

TDLib session files live under the configured `TDLIB_DATA_DIR`, defaulting to `./tdlib-data`. They are service runtime data, not source artifacts. The Dockerfile packages the service runtime; native-library and data-volume configuration remain deployment concerns.

## Change boundaries

- HTTP, auth-state, session, and event changes require updates in `soloone-backend` Telegram callers and persisted runtime behavior.
- Adapter-interface changes require both mock and real implementations.
- Durable boundary or recovery changes should update this document and an applicable feature specification.
