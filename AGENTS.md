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

- Run `npm run lint` and `npm run build` for normal changes.
- Exercise both mock and real adapter implications when a shared adapter contract changes; real TDLib validation requires an appropriately configured environment.
