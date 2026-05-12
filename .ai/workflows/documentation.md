# Documentation Workflow

Use this workflow when the primary output is explanatory, descriptive, or governance documentation.

## Inputs

- requested documentation change
- relevant source or governance files
- intended audience

## Required Loop

1. Identify the document purpose and audience.
2. Inspect nearby terminology and structure.
3. Make the smallest clear documentation change.
4. Review for accuracy, duplication, and scope drift.
5. Validate links, paths, or examples when practical.

## Default Skills

- `skills/implementation.md`
- `skills/review.md`
- `skills/state_management.md` only when documentation affects governance state or architecture assumptions

## Checklist Binding

Required:

- `checklists/review.md`

Optional based on impact:

- `checklists/implementation.md`
- `checklists/architecture.md`

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
- terminology is consistent with nearby files
- examples, paths, or references were checked when practical
- remaining uncertainty is explicit
