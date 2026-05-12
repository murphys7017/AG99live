# Codex Adapter

Use this adapter to map project governance files into Codex-compatible working instructions.

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
9. `.ai/router/loading_rules.md`
10. task-specific policies, workflow, skills, checklists, evaluation, and state files selected by the router

## Adapter Rule

Do not bypass the router layer. Codex-compatible instructions should classify the task and estimate risk before selecting workflow material.
