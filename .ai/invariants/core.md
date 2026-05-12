# Core Invariants

Invariants define rules that must not be violated during agent execution.

Initial invariants:

- Do not expand task scope without explicit user approval.
- Do not rewrite unrelated modules during local changes.
- Preserve existing architecture unless the task explicitly requires changing it.
- Keep important state and assumptions observable.
- Prefer reviewable, rollback-safe changes.
