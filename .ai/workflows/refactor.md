# Refactor Workflow

Use this workflow when the primary output is structural improvement while preserving intended behavior.

## Inputs

- refactor goal
- behavior that must remain unchanged
- affected structural boundary
- initial risk assumption

## Required Loop

1. Confirm refactor necessity.
2. Define behavior that must remain unchanged.
3. Limit the affected scope.
4. Refactor incrementally.
5. Validate behavior preservation.
6. Stop before unrelated redesign.

## Default Skills

- `skills/planning.md`
- `skills/refactor.md`
- `skills/review.md`
- `skills/architecture_review.md` for medium or high-risk work
- `skills/state_management.md` when state is being maintained

## Checklist Binding

Required:

- `checklists/implementation.md`
- `checklists/review.md`
- `checklists/architecture.md`

Optional based on risk:

- `checklists/safety.md`

## Evaluation Binding

Required:

- `evaluation/execution_quality.md`
- `evaluation/architecture_stability.md`

Optional based on risk:

- `evaluation/governance_compliance.md`

## State Expectations

- Update `task_state.yaml` and `risk_state.yaml` when scope grows or boundaries shift.
- Update `architecture_state.yaml` when modules, boundaries, or interface ownership change.
- Update `verification_state.yaml` to record behavior-preservation checks.

## Exit Conditions

- intended behavior remains preserved
- affected scope stayed bounded
- architecture checklist was applied
- validation status is known
- unrelated redesign was avoided
