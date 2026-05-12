# Feature Development Workflow

Use this workflow when the primary output is new behavior, new capability, or an expanded supported use case.

## Inputs

- requested capability or desired outcome
- current nearby architecture and patterns
- initial risk assumption

## Required Loop

1. Analyze current architecture and nearby patterns.
2. Define objective, success criteria, and bounded scope.
3. Implement the smallest complete change.
4. Review for objective satisfaction, drift, coupling, and safety.
5. Validate with available checks.
6. Correct issues before completion.
7. For long-running or multi-turn work, run a continuity checkpoint before continuing after major changes and before completion.

## Default Skills

- `skills/planning.md` for medium or high-risk work
- `skills/implementation.md`
- `skills/review.md`
- `skills/state_management.md` when state is being maintained

## Checklist Binding

Required:

- `checklists/implementation.md`
- `checklists/review.md`
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

- Review `task_state.yaml` before major edits.
- Update `execution_state.yaml` and `verification_state.yaml` for medium or high-risk work.
- Update `architecture_state.yaml` when the feature changes boundaries or introduces structural coupling.

## Exit Conditions

- requested feature scope is implemented or intentionally bounded
- objective satisfaction was checked against success criteria
- implementation and review checklists have been applied
- validation status is known
- remaining gaps or risks are explicit
