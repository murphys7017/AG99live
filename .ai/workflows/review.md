# Review Workflow

Use this workflow when the primary output is assessment, findings, risk identification, or approval guidance without implementation.

## Inputs

- review target
- review scope
- relevant files or governance layers
- expected review lens

## Required Loop

1. Define review objective, scope, success criteria, and assumptions.
2. Inspect relevant files and governance constraints.
3. Follow the relevant dataflow when correctness depends on multiple boundaries.
4. Identify findings, risks, fallback reliance, objective gaps, and validation gaps.
5. Prioritize findings by severity.
6. Report residual risk and validation limits.
7. For long-running or multi-turn review, run a continuity checkpoint before finalizing findings.

## Default Skills

- `skills/review.md`
- `skills/architecture_review.md` when architecture is in scope
- `skills/dataflow_review.md` when reviewing multi-step behavior
- `skills/state_management.md` only when review changes explicit project state

## Checklist Binding

Required:

- `checklists/review.md`

Optional based on scope:

- `checklists/objective_satisfaction.md`
- `checklists/architecture.md`
- `checklists/safety.md`
- `checklists/root_cause.md`
- `checklists/continuity.md`

## Evaluation Binding

Optional by default:

- `evaluation/governance_compliance.md`

Required when reviewing governance execution:

- `evaluation/execution_quality.md`
- `evaluation/governance_compliance.md`

## State Expectations

- Review-only tasks normally do not update state.
- Update `risk_state.yaml` when a persistent project risk is identified.
- Update `architecture_state.yaml` when the review confirms or changes architecture assumptions.

## Exit Conditions

- findings are prioritized by severity
- review objective and success criteria were satisfied or the gap is explicit
- primary-path correctness is distinguished from fallback or degraded behavior when applicable
- assumptions and scope limits are explicit
- residual risks are stated
- no implementation occurred unless separately requested
