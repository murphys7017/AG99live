# Risk Levels

Use risk levels to determine governance intensity.

Risk estimation should also consider `disturbance_model.md`, which defines destabilizing conditions such as ambiguous intent, dirty worktrees, validation gaps, context loss, and governance drift.

## Risk Factors

Assess risk using these factors:

- scope size
- architecture boundary impact
- public interface impact
- destructive or irreversible potential
- validation availability
- uncertainty of current context

## Low Risk

Typical conditions:

- documentation-only changes
- isolated metadata updates
- narrow local edits
- no architecture boundary changes
- no public interface impact
- easy manual inspection

Governance expectation:

- lightweight routing
- minimal state updates
- checklist and execution-quality review are usually sufficient

## Medium Risk

Typical conditions:

- localized implementation changes
- bounded multi-file edits
- bugfixes with limited surface area
- small refactors with preserved boundaries
- partial but not complete validation availability

Governance expectation:

- full task classification
- workflow selection required
- task, execution, and verification state should be reviewed
- execution-quality evaluation should normally be applied

## High Risk

Typical conditions:

- architecture boundary changes
- public API or external interface changes
- broad refactors
- release preparation or publication steps
- destructive, irreversible, or hard-to-rollback actions
- low confidence in context or verification

Governance expectation:

- full governance path should be loaded
- architecture and safety checklists should be considered
- architecture-stability and governance-compliance evaluation should be considered
- state review and state update should be explicit

## Escalation Rules

Escalate to `high` risk if any of the following are true:

- the task changes architecture boundaries
- the task changes public interfaces
- the task performs publication or irreversible actions
- the task requires broad refactoring across unrelated areas

Escalate from `low` to `medium` if any of the following are true:

- more than one file is changed in a behavior-affecting way
- available validation is incomplete
- the current context is uncertain
- the task includes both implementation and structural cleanup

When uncertain between two levels, choose the higher level.
