# Loading Rules

Load governance material based on task class and risk.

## Default Minimum Load Set

- relevant constitution files
- core invariants
- runtime continuity rules when work is long-running, multi-turn, interrupted, or resumed
- objective policy when task success depends on outcome, quality criteria, or scope boundaries
- relevant policies
- one workflow
- task-specific skills
- final checklist

## Notes

- `AGENTS.md` is the runtime entry point and should be read first.
- `constitution/core.md` and `invariants/core.md` are part of the default base for all non-trivial tasks.
- Higher risk tasks load more layers, not different philosophy.

## Loading Matrix

### documentation + low

- Constitution: `constitution/core.md`
- Invariants: `invariants/core.md`
- Policies: `policies/workflow.yaml`, `policies/objective.yaml` when documentation purpose or audience affects success
- Workflow: `workflows/documentation.md`
- Skills: `skills/implementation.md`, `skills/review.md`
- Checklists: `checklists/review.md`, `checklists/objective_satisfaction.md` when purpose, audience, or acceptance criteria are non-trivial
- Evaluation: optional `evaluation/execution_quality.md`
- State to inspect: `state/task_state.yaml`, `state/execution_state.yaml`
- State update expectation: optional lightweight update

### documentation + medium

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/objective.yaml`
- Workflow: `workflows/documentation.md`
- Skills: `skills/planning.md`, `skills/implementation.md`, `skills/review.md`, `skills/state_management.md`
- Checklists: `checklists/review.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md` when governance behavior or architecture decisions are documented
- Evaluation: `evaluation/execution_quality.md`, `evaluation/governance_compliance.md` when documentation changes agent behavior
- State to inspect: `state/task_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: recommended when assumptions, governance behavior, or persistent decisions change

### documentation + high

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`, `constitution/engineering_control.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/permissions.yaml`, `policies/objective.yaml`
- Workflow: `workflows/documentation.md`
- Skills: `skills/planning.md`, `skills/implementation.md`, `skills/review.md`, `skills/architecture_review.md`, `skills/state_management.md`
- Checklists: `checklists/review.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md`, `checklists/safety.md`
- Evaluation: `evaluation/execution_quality.md`, `evaluation/architecture_stability.md` when architecture meaning changes, `evaluation/governance_compliance.md`
- State to inspect: `state/task_state.yaml`, `state/architecture_state.yaml`, `state/risk_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: required

### feature development + medium

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/objective.yaml`
- Workflow: `workflows/feature_development.md`
- Skills: `skills/planning.md`, `skills/implementation.md`, `skills/review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/objective_satisfaction.md`
- Evaluation: `evaluation/execution_quality.md`
- State to inspect: `state/task_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: recommended

### feature development + high

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`, `constitution/engineering_control.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/permissions.yaml`, `policies/objective.yaml`
- Workflow: `workflows/feature_development.md`
- Skills: `skills/planning.md`, `skills/implementation.md`, `skills/review.md`, `skills/architecture_review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md`, `checklists/safety.md`
- Evaluation: `evaluation/execution_quality.md`, `evaluation/architecture_stability.md`, `evaluation/governance_compliance.md`
- State to inspect: `state/task_state.yaml`, `state/architecture_state.yaml`, `state/risk_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: required

### bugfix + medium

- Constitution: `constitution/core.md`, `constitution/stability.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/correctness.yaml`, `policies/objective.yaml`
- Workflow: `workflows/bugfix.md`
- Skills: `skills/debugging.md`, `skills/dataflow_review.md` when behavior crosses multiple boundaries, `skills/implementation.md`, `skills/review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/root_cause.md`, `checklists/objective_satisfaction.md`
- Evaluation: `evaluation/execution_quality.md`
- State to inspect: `state/task_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: recommended

### bugfix + high

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`, `constitution/engineering_control.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/permissions.yaml`, `policies/correctness.yaml`, `policies/objective.yaml`
- Workflow: `workflows/bugfix.md`
- Skills: `skills/debugging.md`, `skills/dataflow_review.md`, `skills/implementation.md`, `skills/review.md`, `skills/architecture_review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/root_cause.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md`, `checklists/safety.md`
- Evaluation: `evaluation/execution_quality.md`, `evaluation/architecture_stability.md`, `evaluation/governance_compliance.md`
- State to inspect: `state/task_state.yaml`, `state/architecture_state.yaml`, `state/risk_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: required

### refactor + medium

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/objective.yaml`
- Workflow: `workflows/refactor.md`
- Skills: `skills/planning.md`, `skills/refactor.md`, `skills/review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md`
- Evaluation: `evaluation/execution_quality.md`, `evaluation/architecture_stability.md`
- State to inspect: `state/task_state.yaml`, `state/architecture_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: recommended

### refactor + high

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`, `constitution/engineering_control.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/permissions.yaml`, `policies/objective.yaml`
- Workflow: `workflows/refactor.md`
- Skills: `skills/planning.md`, `skills/refactor.md`, `skills/review.md`, `skills/architecture_review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md`, `checklists/safety.md`
- Evaluation: `evaluation/execution_quality.md`, `evaluation/architecture_stability.md`, `evaluation/governance_compliance.md`
- State to inspect: `state/task_state.yaml`, `state/architecture_state.yaml`, `state/risk_state.yaml`, `state/context_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: required

### review + low or medium

- Constitution: `constitution/core.md`, `constitution/architecture.md`
- Invariants: `invariants/core.md`
- Policies: `policies/workflow.yaml`, `policies/objective.yaml`, `policies/correctness.yaml` when reviewing behavior correctness
- Workflow: `workflows/review.md`
- Skills: `skills/review.md`, `skills/architecture_review.md`, `skills/dataflow_review.md` when reviewing multi-step behavior
- Checklists: `checklists/review.md`, `checklists/objective_satisfaction.md` when reviewing against requested success criteria, `checklists/architecture.md` when architecture is in scope, `checklists/root_cause.md` when reviewing bugfix or fallback behavior
- Evaluation: `evaluation/governance_compliance.md` when reviewing governance use, otherwise optional
- State to inspect: `state/task_state.yaml`, `state/context_state.yaml`
- State update expectation: optional

### release + high

- Constitution: `constitution/core.md`, `constitution/stability.md`, `constitution/architecture.md`, `constitution/engineering_control.md`
- Invariants: `invariants/core.md`
- Policies: `policies/runtime.yaml`, `policies/workflow.yaml`, `policies/safety.yaml`, `policies/permissions.yaml`, `policies/objective.yaml`
- Workflow: `workflows/release.md`
- Skills: `skills/planning.md`, `skills/review.md`, `skills/state_management.md`
- Checklists: `checklists/review.md`, `checklists/safety.md`, `checklists/objective_satisfaction.md`, `checklists/architecture.md` when release changes affect boundaries
- Evaluation: `evaluation/execution_quality.md`, `evaluation/governance_compliance.md`
- State to inspect: `state/task_state.yaml`, `state/risk_state.yaml`, `state/execution_state.yaml`, `state/verification_state.yaml`
- State update expectation: required

### repository maintenance + low or medium

- Constitution: `constitution/core.md`, `constitution/stability.md`
- Invariants: `invariants/core.md`
- Policies: `policies/workflow.yaml`, `policies/safety.yaml`, `policies/objective.yaml`
- Workflow: `workflows/documentation.md` for docs-only maintenance, `workflows/feature_development.md` for additive setup, `workflows/refactor.md` for structural reorganization
- Skills: `skills/planning.md`, `skills/implementation.md`, `skills/review.md`, `skills/state_management.md`
- Checklists: `checklists/implementation.md`, `checklists/review.md`, `checklists/objective_satisfaction.md` when outcome or scope boundaries are non-trivial
- Evaluation: `evaluation/execution_quality.md`
- State to inspect: `state/task_state.yaml`, `state/execution_state.yaml`
- State update expectation: optional for low, recommended for medium

## Fallback Rule

If no exact matrix entry fits the task:

1. classify using the nearest primary task class,
2. choose the higher plausible risk level,
3. load the stricter workflow path,
4. document the assumption in `state/context_state.yaml` when state is being updated.
