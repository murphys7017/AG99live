# Agent Governance Map

This file is the agent-readable map of the `.ai/` governance runtime.

Use it to understand where to look, not as a replacement for the router.

## Entry Flow

For any non-trivial task, load governance in this order:

1. `AGENTS.md`
2. `.ai/README.md`
3. `.ai/index.md`
4. `.ai/constitution/core.md`
5. `.ai/invariants/core.md`
6. `.ai/router/task_classification.md`
7. `.ai/router/risk_levels.md`
8. `.ai/router/disturbance_model.md`
9. `.ai/router/loading_rules.md`
10. Task-specific files selected by the router

Do not bypass task classification, risk estimation, or loading rules.

## Layer Map

| Layer | Path | Purpose |
| --- | --- | --- |
| Constitution | `constitution/` | Stable philosophy and long-term control principles. |
| Invariants | `invariants/` | Rules that must not be violated during execution. |
| Policies | `policies/` | Structured operational constraints and permissions. |
| Router | `router/` | Task classification, risk estimation, disturbance awareness, and loading selection. |
| Workflows | `workflows/` | Task-specific execution loops and exit conditions. |
| Skills | `skills/` | Reusable operational procedures. |
| Checklists | `checklists/` | Completion checks and attention recall mechanisms. |
| Evaluation | `evaluation/` | Feedback criteria and result semantics. |
| State | `state/` | Explicit observable runtime state. |
| Adapters | `adapters/` | Runtime-specific guidance for Codex, OpenCode, Claude Code, Cursor, and similar agents. |

## Router Files

The router is the control selection layer.

- `router/task_classification.md` defines task classes.
- `router/risk_levels.md` defines governance intensity.
- `router/disturbance_model.md` defines common destabilizing conditions.
- `router/loading_rules.md` maps task class and risk to files that should be loaded.

## Typical Paths

### Low-risk documentation

1. Classify as `documentation`.
2. Estimate risk as `low`.
3. Load `workflows/documentation.md`.
4. Apply `checklists/review.md`.
5. Skip state updates unless an assumption or persistent decision must be recorded.

### Medium bugfix

1. Classify as `bugfix`.
2. Estimate risk as `medium`.
3. Load runtime, workflow, safety, debugging, implementation, review, and state materials selected by `loading_rules.md`.
4. Reproduce or reason from evidence.
5. Validate and report remaining gaps.

### High-risk refactor or release

1. Classify the primary task.
2. Estimate risk as `high`.
3. Load the full selected governance path, including safety and architecture review.
4. Review and update relevant state when required.
5. Do not perform destructive, irreversible, or publication actions without explicit user approval.

## Agent Completion Expectations

Before final response, an agent should know:

- task class
- risk level
- selected workflow
- files or state inspected
- validation performed or skipped
- checklist or evaluation result when applicable
- residual risk
- whether correction remains required

If any of these are unknown for a medium or high-risk task, report the gap explicitly.

## Correctness Discipline

When reviewing or fixing behavior:

- use `policies/correctness.yaml` to distinguish root-cause fixes from downstream masking
- use `skills/dataflow_review.md` when correctness crosses multiple boundaries
- use `checklists/root_cause.md` for bugfixes, fallback-heavy paths, and degraded behavior

Fallback, default values, retries, or swallowed errors are not proof that the primary path is correct.
