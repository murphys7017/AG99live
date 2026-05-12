# Documentation Workflow

Use this workflow when the primary output is explanatory, descriptive, or governance documentation.

## Inputs

- requested documentation change
- relevant source or governance files
- intended audience

## Required Loop

1. Identify the document purpose and audience.
2. Define success criteria and scope boundaries when they are not trivial.
3. Inspect nearby terminology and structure.
4. Make the smallest clear documentation change.
5. Review for accuracy, duplication, objective satisfaction, and scope drift.
6. Validate links, paths, or examples when practical.
7. For multi-turn documentation work, run a continuity checkpoint before completion.

## Default Skills

- `skills/implementation.md`
- `skills/review.md`
- `skills/state_management.md` only when documentation affects governance state or architecture assumptions

## Checklist Binding

Required:

- `checklists/review.md`

Optional based on impact:

- `checklists/implementation.md`
- `checklists/objective_satisfaction.md`
- `checklists/architecture.md`
- `checklists/continuity.md`

## Evaluation Binding

Optional by default:

- `evaluation/execution_quality.md`

Required when documentation changes governance behavior:

- `evaluation/governance_compliance.md`

## State Expectations

- Low-risk documentation tasks usually do not update state.
- Update `context_state.yaml` when documentation depends on assumptions or unresolved questions.
- Update `architecture_state.yaml` only when the documentation records a real architecture decision.

## Exit Conditions

- documentation change is scoped to the requested purpose
- objective satisfaction is checked when success criteria are non-trivial
- terminology is consistent with nearby files
- examples, paths, or references were checked when practical
- remaining uncertainty is explicit
