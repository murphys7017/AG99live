# Bugfix Workflow

Use this workflow when the primary output is correction of faulty behavior.

## Inputs

- observed bug, failing behavior, or concrete defect signal
- current suspected scope
- available reproduction or validation evidence

## Required Loop

1. Reproduce or reason from concrete evidence.
2. State the current root-cause hypothesis.
3. Identify the smallest faulty behavior boundary.
4. Patch at the point where the defect is introduced.
5. Validate the primary path, not only fallback or degraded behavior.
6. Check for regressions or adjacent failure modes.

## Default Skills

- `skills/debugging.md`
- `skills/dataflow_review.md` when the defect crosses multiple boundaries
- `skills/implementation.md`
- `skills/review.md`
- `skills/state_management.md` when state is being maintained

## Checklist Binding

Required:

- `checklists/implementation.md`
- `checklists/review.md`
- `checklists/root_cause.md`

Optional based on risk:

- `checklists/architecture.md`
- `checklists/safety.md`

## Evaluation Binding

Required:

- `evaluation/execution_quality.md`

Optional based on risk:

- `evaluation/architecture_stability.md`
- `evaluation/governance_compliance.md`

## State Expectations

- Update `task_state.yaml` when bugfix scope or risk changes.
- Update `context_state.yaml` when the fix depends on assumptions or incomplete evidence.
- Update `verification_state.yaml` with checks run and remaining gaps.

## Exit Conditions

- faulty behavior is corrected or the boundary of the unresolved issue is explicit
- fallback or degraded paths are not used as proof of correctness
- validation status is known
- likely regressions were considered
- remaining risks are visible
