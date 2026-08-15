# Specification process

## Scope

Small implementation fixes and refactors need code and appropriate validation only. Session lifecycle, authentication state, HTTP requests/responses, event streams, adapter guarantees, or persisted recovery behavior require stable contract requirements and a feature specification.

## Workflow and locations

- Use an RFC for adapter architecture, persistence, compatibility, or cross-project migrations whose rationale must persist. Create `records/rfcs/` only when needed.
- Put feature specifications in `docs/features/` when the first contract is needed.
- Use stable IDs such as `TG-1.1`, `TG-AUTH-2.2`, or `TG-EVENT-1.3`.
- Put executable specifications in root `tests/` when a test runner is established, covering mock mode by default and real mode only when the environment supports it.
- Reference verified requirements with a marker such as `// Contract: TG-AUTH-2.2`.

BDD/Gherkin is not the default. If a contract has no executable coverage, record the gap and do not treat TypeScript compilation as behavioral verification.

## Completion

Before significant work is complete, compare requirements, HTTP/event contracts, shared types, mock adapter, real adapter, backend callers, and executable coverage for drift.
