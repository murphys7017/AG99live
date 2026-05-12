# Bugfix Workflow

Use this workflow when the primary output is correction of faulty behavior.

## Inputs

- observed bug, failing behavior, or concrete defect signal
- current suspected scope
- available reproduction or validation evidence

## Required Loop

1. Reproduce or reason from concrete evidence.
2. Define the corrected behavior and success criteria.
3. State the current root-cause hypothesis.
4. Identify the smallest faulty behavior boundary.
5. Patch at the point where the defect is introduced.
6. Validate the primary path, not only fallback or degraded behavior.
7. Check for regressions, adjacent failure modes, and objective satisfaction.
8. For long-running or multi-turn work, run a continuity checkpoint before continuing after major changes and before completion.

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
- `checklists/objective_satisfaction.md`

Optional based on risk:

- `checklists/architecture.md`
- `checklists/safety.md`
- `checklists/continuity.md`

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
- corrected behavior satisfies the stated success criteria or the gap is explicit
- fallback or degraded paths are not used as proof of correctness
- validation status is known
- likely regressions were considered
- remaining risks are visible
