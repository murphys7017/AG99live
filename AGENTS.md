# Agent Entry Point

Use `.ai/index.md` as the project AI operating guide.

Default loop:

1. Understand the task objective, success criteria, and non-goals when relevant.
2. Classify: documentation, feature, bugfix, refactor, review, release, or maintenance.
3. Estimate risk: low, medium, or high.
4. Inspect relevant files before editing.
5. Make the smallest correct change.
6. Review, validate when practical, correct issues, and report gaps.

Escalate governance for medium/high risk, architecture or public-interface impact, destructive/release actions, failed or missing validation, ambiguous scope, dirty relevant files, long-running/multi-turn/resumed work, or governance edits.

Rules:

- Do not expand scope without approval.
- Do not rewrite unrelated modules.
- Preserve architecture and user changes unless asked otherwise.
- Validate practical checks and report skipped/failed validation.
- Update `.ai/state.yaml` only when scope, risk, architecture impact, assumptions, or validation status would otherwise be hidden.
- Commit only when explicitly requested.
