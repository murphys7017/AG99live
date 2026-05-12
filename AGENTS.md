# Agent Entry Point

This project uses `.ai/` as the runtime governance directory for AI coding agents.

Agents should not treat this file as the full governance system. This file is only the entry point and loading guide.

For the shared Codex/OpenCode/Claude Code/Cursor execution protocol, read `docs/runtime/agent_execution_protocol.md`.

## Governance Philosophy

This project treats AI coding agents as non-deterministic runtime systems. Reliability is a control problem, not a prompt problem.

Prefer policy-driven execution over prompt-driven behavior: classify the task, estimate risk, load only relevant governance, follow a bounded workflow, apply checklists and evaluation, and update explicit state when required.

## Default Loading Order

1. Read `.ai/README.md`.
2. Read `.ai/index.md`.
3. Read `.ai/constitution/core.md`.
4. Read `.ai/invariants/core.md`.
5. Classify the task using `.ai/router/task_classification.md`.
6. Estimate risk using `.ai/router/risk_levels.md` and `.ai/router/disturbance_model.md`.
7. Read `.ai/runtime/continuity.md` for long-running, multi-turn, interrupted, or resumed work.
8. Load relevant policies, workflows, skills, checklists, evaluation, and state files using `.ai/router/loading_rules.md`.

## Core Behavior

- Follow a closed execution loop: analyze, plan, implement, review, validate, correct.
- Make the task objective, success criteria, and non-goals explicit when they affect execution.
- Prefer stable constrained execution over unconstrained changes.
- Build context before editing files.
- Make the smallest correct change that solves the task.
- Preserve architecture and user changes unless explicitly instructed otherwise.
- Keep important assumptions, state, and risks observable.
- Apply checklists and report evaluation results when applicable.
- Validate changes when practical and report gaps honestly.
- Update explicit state when the router path requires or recommends it.
- Create commits only when explicitly requested.
