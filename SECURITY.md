# Security

## What the service does with data

The service signs in to Telegram accounts through TDLib on behalf of the SoloOne backend and keeps those sessions
open. Over HTTP it takes the account's phone number, login code, 2FA password, QR confirmation and registration name;
it lists chats, reads message history, sends messages, marks chats read, deletes chats and sets the profile photo. It
streams auth, chat and message events per session as server-sent events. `TDLIB_MODE` defaults to `mock`, which uses
fixed fictional data and no Telegram connection; `real` uses TDLib.

## Configuration and secrets

Read in `src/index.ts` and `src/tdlibAdapter.ts`. Names only; there is no `.env.example`. `.env` is loaded from the
working directory, its parent and the folders around the build output (`src/index.ts:13-20`); none is in git.

| Variable | Secret | What it is for |
|---|---|---|
| `TDLIB_API_HASH` | yes | Telegram application hash (real mode). |
| `TDLIB_API_ID` | yes | Telegram application id, paired with the hash (real mode). |
| `TDLIB_MODE` | no | `mock` (default) or `real`. |
| `TDLIB_SERVICE_PORT` | no | HTTP port, default 4003. |
| `TDLIB_DATA_DIR` | no | Where TDLib keeps sessions, default `./tdlib-data`. |
| `TDLIB_LIBRARY_PATH` | no | Path to the TDLib library, when not the bundled one. |
| `TDLIB_MAX_GROUP_MEMBERS` | no | Real mode: groups with this many members or more are left out of chat lists (default 20). |
| `TDLIB_APPLICATION_VERSION`, `TDLIB_DEVICE_MODEL`, `TDLIB_SYSTEM_VERSION`, `TDLIB_SYSTEM_LANGUAGE_CODE` | no | How the session presents itself to Telegram. |

## Who can call what

From `src/index.ts`:

- No route checks a token or any caller identity. Whoever can reach the port can create a session, sign in, read
  chats and history, send messages, delete chats and change the profile photo.
- A session id (16 random characters from `nanoid`) is the only key to a session. Routes under
  `/sessions/:sessionId` answer 404 for an id that is not active in this process.
- Request bodies are validated with Zod (phone, code, password, registration, message ids); the avatar must be a
  non-empty `image/jpeg` body up to 5 MB.

Who may reach the port is therefore a deployment matter (see Known gaps).

## Where personal data is stored

- `TDLIB_DATA_DIR/<sessionId>/db` and `/files`: TDLib's databases and files for each signed-in account: the
  Telegram login keys, chats, messages, contacts and downloaded files. The folder is in `.gitignore`.
- Active session ids are kept in process memory only.
- A profile photo upload is written to a temporary folder and deleted after the call (`src/tdlibAdapter.ts:536`).
- The service's own logs are the start-up line and one TDLib path warning (`src/index.ts:392`,
  `src/tdlibAdapter.ts:676`); phone numbers, codes, passwords and message text are not logged. Error messages go back
  to the caller in the HTTP response.

## Secret scan

`npm run gate` ends with `npm run secret-scan` (`scripts/secret-scan.mjs`): gitleaks over the whole git history,
staged changes and unstaged changes, with values redacted. CI (`.github/workflows/ci.yml`) installs gitleaks and runs
the gate on every push and pull request. Known false positives go in `.gitleaks.toml`, each with a reason; a real
secret is removed and rotated, never allowed.

## Known gaps

- No authentication on any route (`src/index.ts:86-363`). Anyone who reaches the port can sign in to and use any
  session whose id they know, and create new ones.
- CORS allows every origin (`src/index.ts:23`), so a web page in a browser that can reach the service can call it.
- The server listens on all network interfaces, not only localhost (`src/index.ts:391`).
- `POST /sessions/resume` accepts any 8 to 128 character `sessionId` (`src/index.ts:62`), and the id is joined into
  the data path (`src/tdlibAdapter.ts:633`). An id with `../` can create TDLib folders outside `TDLIB_DATA_DIR`.
- TDLib's database is opened without an encryption key (`src/tdlibAdapter.ts:639-657`), so the session files on disk
  give full access to the Telegram accounts to anyone who can read them.

## Reporting a problem

Report a security problem to the owner of this repository directly, not in a public issue.
