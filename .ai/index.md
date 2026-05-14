# AI Operating Guide

## Fast Path

For low-risk local work: inspect relevant files, make the smallest correct change, review, validate when practical, and report gaps.

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
6. Validate the primary path when behavior changes.
7. Review for regressions, scope drift, and missing tests.
8. Report validation status and residual risk.

## Checklists

- implementation: scoped, style preserved, assumptions visible, unrelated files untouched
- review: correctness, regressions, validation gaps, architecture boundaries, severity order
- bugfix: root cause checked, primary path validated, fallback not treated as proof
- refactor: behavior preserved, boundaries stable, rollback safe
- safety: no secrets, no unapproved destructive/public action, user work preserved

## Continuity

Re-check task class, risk, scope, workflow, assumptions, validation, and correction state after user changes, validation failure, context resume, unexpected worktree changes, or major implementation phases.

## State

Update `.ai/state.yaml` for medium/high-risk work when useful, and for high-risk work when required to keep assumptions visible. Ask before recording long-lived architecture decisions or persistent project risks.

Do not update state performatively.
