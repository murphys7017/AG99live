# Release Workflow

Use this workflow when the primary output is release preparation, publication, or release readiness verification.

## Inputs

- release target or publication intent
- repository state
- validation and artifact expectations

## Required Loop

1. Check repository state.
2. Review pending changes and version metadata.
3. Run available validation.
4. Confirm release artifacts and notes.
5. Avoid irreversible publication without explicit approval.

## Default Skills

- `skills/planning.md`
- `skills/review.md`
- `skills/state_management.md`

## Checklist Binding

Required:

- `checklists/review.md`
- `checklists/safety.md`

Optional based on impact:

- `checklists/architecture.md`

## Evaluation Binding

Required:

- `evaluation/execution_quality.md`
- `evaluation/governance_compliance.md`

Optional based on impact:

- `evaluation/architecture_stability.md`

## State Expectations

- Update `risk_state.yaml` when publication risk or irreversible actions are involved.
- Update `execution_state.yaml` and `verification_state.yaml` with validation and review status.
- Update `task_state.yaml` to reflect release phase progression when state maintenance is in use.

## Exit Conditions

- repository and release state are understood
- validation status is known
- safety checklist was applied
- irreversible publication steps were explicitly approved when required
