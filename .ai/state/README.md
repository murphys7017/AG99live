# Runtime State

This directory models explicit control-system state for agent execution.

State files are not hidden memory. They are inspectable records of task, architecture, risk, context, execution, and verification conditions.

## File Status

The YAML files in this directory are v1 runtime state baselines.

They are not examples and they are not read-only templates. They represent the repository's current explicit governance state when maintained.

Because v1 is manual, state updates should be intentional and minimal. Do not update state just to create activity.

## Purpose

The state layer exists to reduce hidden runtime assumptions.

Use it to make important control conditions visible:

- what task is being executed
- what phase the task is in
- what level of risk is currently assumed
- whether architecture boundaries may be affected
- whether validation was completed or skipped

## Scope Model

### Session-scoped state

These files are primarily about the current execution session:

- `task_state.yaml`
- `context_state.yaml`
- `execution_state.yaml`
- `verification_state.yaml`

### Project-scoped state

These files describe broader project or governance conditions:

- `architecture_state.yaml`
- `runtime_state.yaml`

### Mixed state

These files may be influenced by the current session but can also carry forward broader project signals:

- `risk_state.yaml`

## Update Policy

v1 does not require every task to fully maintain all state files.

Use the following expectations:

- Low-risk tasks may skip state updates unless state visibility would be useful.
- Medium-risk tasks should review relevant state and update it when execution meaningfully changes status.
- High-risk tasks should explicitly review and update relevant state.

## Update Responsibility

The active coding agent is responsible for proposing and applying state updates when the loaded router path marks state updates as recommended or required.

The user remains the authority for project-level state when an update would record a long-lived architecture decision, persistent risk, or governance constraint.

Ask before updating project-scoped state if the update changes long-term project meaning rather than simply recording the current task.

## Required Update Triggers

Update relevant state when any of these occur:

- task risk changes after initial classification
- task scope expands beyond the original request
- architecture boundaries are changed or newly identified
- destructive or irreversible action becomes pending
- validation fails or cannot be run
- a persistent known risk or unresolved question is discovered

## Template Policy

If a reusable starting point is needed later, create it under `.ai/state/templates/`.

Do not treat the live files in `.ai/state/` as templates.

## State File Intent

### `task_state.yaml`

Records the current task class, scope, risk, phase, and owner.

**Naming note:** State enum values use snake_case (e.g., `feature_development`, `repository_maintenance`). Human-readable task class names in router and workflow documents may use spaces (e.g., `feature development`, `repository maintenance`). Treat both forms as equivalent when mapping between documents.

Recommended values:

- `type`: `documentation`, `feature_development`, `bugfix`, `refactor`, `review`, `release`, `repository_maintenance`, `unknown`
- `scope`: `local`, `bounded`, `cross_module`, `broad`, `unknown`
- `risk`: `low`, `medium`, `high`, `unknown`
- `phase`: `analyze`, `plan`, `implement`, `review`, `validate`, `correct`, `done`, `not_started`
- `owner`: `agent`, `user`, `mixed`

### `architecture_state.yaml`

Records architecture stability assumptions and known boundary changes.

Recommended values:

- `stability`: `stable`, `watch`, `at_risk`, `unknown`
- `pending_breaking_change`: `true` or `false`
- `boundary_changes`: list of impacted boundaries or modules

### `runtime_state.yaml`

Records high-level governance mode and runtime capability constraints.

Recommended values:

- `governance_mode`: `manual_v1`, `assisted`, `adaptive`, `unknown`
- `adaptive_routing_enabled`: `true` or `false`
- `self_modifying_governance_enabled`: `true` or `false`

### `risk_state.yaml`

Records current risk assumptions and escalation signals.

Recommended values:

- `current_level`: `low`, `medium`, `high`, `unknown`
- `scope_expansion_detected`: `true` or `false`
- `architecture_risk_detected`: `true` or `false`
- `destructive_action_pending`: `true` or `false`

### `context_state.yaml`

Records context confidence, loaded files, assumptions, and unresolved questions.

Recommended values:

- `confidence`: `low`, `medium`, `high`, `unknown`
- `required_files_loaded`: list of governance or project files inspected
- `assumptions`: list of current execution assumptions
- `unresolved_questions`: list of unresolved decision points

### `execution_state.yaml`

Records the current execution phase and whether review or correction is still needed.

Recommended values:

- `phase`: `analyze`, `plan`, `implement`, `review`, `validate`, `correct`, `done`, `not_started`
- `validation_passed`: `true` or `false`
- `review_completed`: `true` or `false`
- `correction_required`: `true` or `false`

### `verification_state.yaml`

Records which checks ran, which failed, and where validation gaps remain.

Recommended values:

- `checks_run`: list of validation commands or review steps performed
- `checks_failed`: list of failed validations
- `validation_gap`: `none`, `limited`, `significant`, `unknown`

## Minimal State Transitions

Use these transitions as the default v1 behavior:

1. At task start, set `task_state.phase` to `analyze`.
2. After scope is chosen, set `task_state.phase` to `plan` or `implement` depending on task complexity.
3. Before editing, set `execution_state.phase` to `implement`.
4. After changes are inspected, set `execution_state.phase` to `review`.
5. After validation attempts, set `execution_state.phase` to `validate` and update `verification_state.yaml`.
6. If issues remain, set `execution_state.correction_required` to `true` and move phase to `correct`.
7. When the task is complete, set phase to `done` where state maintenance is being used.

## State Discipline

- Do not update state performatively for trivial tasks that do not benefit from it.
- Do update state when risk, scope, architecture impact, or validation status would otherwise remain implicit.
- Prefer a small accurate state update over a large stale state model.
