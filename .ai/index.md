# AI Operating Guide

## Fast Path

For low-risk local work: inspect relevant files, make the smallest correct change, review the real call path, run only essential static checks or basic boundary input/output smoke checks, and report runtime evidence gaps.

## Route

Task class:

- documentation: docs/comments/governance text
- feature: new behavior or capability
- bugfix: faulty behavior correction
- refactor: structure change preserving behavior
- review: findings only
- release: packaging, versioning, publishing
- maintenance: repo setup or housekeeping

Risk:

- low: local/docs-only/easy inspection/no public or architecture impact
- medium: bounded behavior change, multi-file local edit, partial validation, relevant dirty files
- high: architecture boundary, public interface, release/destructive action, broad refactor, low context confidence

Escalate when uncertain.

## Execute

1. State objective, success criteria, and non-goals when they affect correctness.
2. Inspect before editing.
3. Preserve user changes and architecture.
4. Patch the source of the issue; do not mask defects with fallback behavior.
5. Keep changes scoped.
6. Trace the primary path across its real callers and dependencies when behavior changes.
7. Review for regressions, scope drift, ownership conflicts, and missing runtime evidence.
8. Report what was established from source, what was only smoke-checked, and what still requires a live run.

### Replacement Over Compatibility

- Do not treat leaving old code untouched as inherently safer. Before editing, decide whether the old implementation should be replaced or removed.
- For internal code without an explicit external compatibility requirement, do not add backward compatibility, fallbacks, wrappers, or parallel paths. Unify callers and delete the old path.

## Testing Policy

- Automated tests are low-confidence boundary smoke checks, not evidence that the feature or end-to-end chain is correct.
- Do not run full suites, broad regression suites, coverage jobs, or repeated test matrices by default.
- When a check is necessary, limit it to the smallest public-boundary input/output case, normally one success case and one rejection case.
- Do not add tests for private implementation details, branch combinations, internal state permutations, or fake integrations that reproduce the implementation's assumptions.
- Prefer source tracing, type/static checks, real protocol payloads, runtime logs, and live AstrBot + Electron + TTS + Live2D verification.
- If live verification is unavailable, report the gap explicitly instead of compensating with more mocks, tests, fallback behavior, or compatibility code.

## Checklists

- implementation: scoped, style preserved, assumptions visible, unrelated files untouched
- review: real call chain, correctness, regressions, runtime evidence gaps, architecture boundaries, severity order
- bugfix: root cause traced through real callers, primary path source-reviewed, fallback and smoke tests not treated as proof
- refactor: behavior preserved, boundaries stable, rollback safe
- safety: no secrets, no unapproved destructive/public action, user work preserved

## Continuity

Re-check task class, risk, scope, workflow, assumptions, validation, and correction state after user changes, validation failure, context resume, unexpected worktree changes, or major implementation phases.

## State

Update `.ai/state.yaml` for medium/high-risk work when useful, and for high-risk work when required to keep assumptions visible. Ask before recording long-lived architecture decisions or persistent project risks.

Do not update state performatively.
