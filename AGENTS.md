# SoloOne TDLib service

This service owns the HTTP and event-stream boundary around Telegram TDLib sessions used by SoloOne.

## Context and scope

- Discover installed harness modules in `.harness/manifest.yaml`.
- `docs/` is current project knowledge; `records/` is historical and not default context.
- For non-trivial work, start with `mq docs/ .tree` and retrieve only relevant sections.
- Current code, types, configuration, and adapter behavior override stale documentation.
- Update documentation only when durable session, authentication, API, event, adapter, persistence, or runtime behavior changes.
- Backend Telegram orchestration belongs to `soloone-backend`; coordinate boundary changes there.

## Specification workflow

- Small/local changes require code and appropriate validation only.
- Non-trivial session, API, or event behavior requires stable contract requirements and a feature specification.
- Architectural or cross-project changes require an RFC when the decision must be preserved.
- Executable coverage should reference the contract IDs it verifies.
- Detailed rules live in `docs/spec-process.md`.

## Validation

- Run `npm run gate` and `npm run build` for normal changes.
- Exercise both mock and real adapter implications when a shared adapter contract changes; real TDLib validation requires an appropriately configured environment.

## Quality and security gate

These rules apply to every change, by a person or an agent. `.claude/README.md` describes the agents and the guard
that enforce them.

- **Done means the gate is green.** `npm run gate` runs the type check, every test and the secret scan
  (`npm run lint` is the same type check; there is no linter yet). Run the whole gate, not just the test file you
  touched: a fix in one place must not break another. CI runs the same gate on every push and pull request
  (`.github/workflows/ci.yml`).
- **Test first.** A feature or a bug fix starts with a test of the behavior that fails on the current code
  (`npm run fails-first -- <files>`), then the code that makes it pass. A bug fix always comes with the test that
  reproduces the bug.
- **Who writes what.** For anything beyond a one-line fix, the `test-writer` agent writes the tests and the `builder`
  agent writes the code; the builder doesn't change the tests. The `verifier` checks the result. Changes to sign-in,
  payments, wallets, deposits, personal data, webhooks or secrets also get the `security-reviewer`, and their tests
  get 2 to 4 `critic` runs.
- **Secrets.** Never open, print or commit `.env` files or keys. Configuration is read by variable name; the names are
  in SECURITY.md (this repo has no `.env.example`). `tdlib-data/` holds logged-in Telegram sessions: never open,
  copy or commit it. A secret that reached git is rotated, not just deleted.
- **Test data is fictional.** Emails at example.com or example.test, phones 447700900000 to 447700900999, invented
  names. No real customer, creator or phone number in code, tests, fixtures or docs.
- **Logs** carry IDs and outcomes, never tokens, message text, phone numbers or emails.
