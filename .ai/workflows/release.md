# Release Workflow

Use this workflow when the primary output is release preparation, publication, or release readiness verification.

## Inputs

- release target or publication intent
- repository state
- validation and artifact expectations

## Required Loop

1. Define release objective, target artifact, and readiness criteria.
2. Check repository state.
3. Review pending changes and version metadata.
4. Run available validation.
5. Confirm release artifacts, notes, and objective satisfaction.
6. Avoid irreversible publication without explicit approval.
7. Run a continuity checkpoint before publication or final release readiness claims.

## Default Skills

- `skills/planning.md`
- `skills/review.md`
- `skills/state_management.md`

## Checklist Binding

Required:

- `checklists/review.md`
- `checklists/safety.md`
- `checklists/objective_satisfaction.md`
- `checklists/continuity.md`

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
- release objective and readiness criteria are satisfied or the gap is explicit
- validation status is known
- safety checklist was applied
- irreversible publication steps were explicitly approved when required
