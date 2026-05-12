# Cursor Adapter

Use this adapter to map project governance files into Cursor-compatible working instructions.

Use `docs/runtime/agent_execution_protocol.md` as the shared execution protocol.

## Required Load Order

1. `AGENTS.md`
2. `.ai/README.md`
3. `.ai/index.md`
4. `.ai/constitution/core.md`
5. `.ai/invariants/core.md`
6. `.ai/router/task_classification.md`
7. `.ai/router/risk_levels.md`
8. `.ai/router/disturbance_model.md`
9. `.ai/runtime/continuity.md`
10. `.ai/router/loading_rules.md`
11. task-specific policies, workflow, skills, checklists, evaluation, and state files selected by the router

## Adapter Rule

Do not bypass the router layer. Cursor-compatible rules should classify the task and estimate risk before selecting workflow material.

For long-running, multi-turn, interrupted, or resumed tasks, run continuity checkpoints instead of assuming the initial load remains valid.
