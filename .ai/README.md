# AI Runtime Governance

This directory contains the project-level governance runtime for AI coding agents.

It is intended to be loaded selectively by adapters, workflows, and task routing rules instead of being copied into one large prompt.

Agents should read `index.md` as the map for this governance runtime after loading the root entry point and before selecting task-specific files.

## Structure

- `index.md` - agent-readable map of the governance runtime.
- `constitution/` - stable philosophy and long-term principles.
- `invariants/` - rules that must not be violated.
- `policies/` - operational constraints, objective discipline, and permissions.
- `runtime/` - runtime continuity and long-running execution control.
- `router/` - task classification, risk levels, and loading rules.
- `skills/` - reusable operational procedures.
- `workflows/` - task-specific execution loops.
- `checklists/` - self-review and recall mechanisms.
- `evaluation/` - feedback criteria and governance quality review.
- `state/` - explicit control-system state, not hidden agent memory.
- `adapters/` - entry guidance for specific agent runtimes.
