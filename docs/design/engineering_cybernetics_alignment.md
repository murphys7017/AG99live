# Engineering Cybernetics Alignment

This document maps the core spirit of Engineering Cybernetics into this project's lightweight AI coding agent governance runtime.

It is a conceptual alignment document, not a mathematical control theory specification.

## Scope Boundary

This project does not attempt to implement formal control-theoretic models such as transfer functions, state equations, optimal control equations, or provable stability guarantees.

Instead, it translates practical engineering-cybernetics ideas into execution discipline for non-deterministic AI coding agents:

- observe the system before acting
- classify the task before selecting controls
- choose stronger controls for higher risk
- keep important state explicit
- use feedback to correct execution
- preserve stability through bounded changes
- let practice validate and refine the governance system

## Concept Mapping

| Engineering Cybernetics Concept | Governance Runtime Equivalent | Purpose |
| --- | --- | --- |
| System | The repository plus `.ai/` governance runtime plus active agent | Treat agent execution as part of a controlled working system. |
| Controlled Object | The target repository being modified or reviewed | Keep the real project as the object of control, not the governance documents themselves. |
| Controller | `.ai/router/`, `.ai/policies/`, and selected workflow | Choose task-specific constraints and execution paths. |
| Actuator | The coding agent operating through Codex, OpenCode, Claude Code, Cursor, or another adapter | Apply changes, run checks, and report results. |
| Sensor | File inspection, git status, tests, validation commands, state files, user instructions | Gather information before and during execution. |
| State | `.ai/state/*.yaml` and surfaced task assumptions | Make task phase, risk, context, and verification status observable. |
| Control Law | Policies, invariants, workflow exit conditions, and checklist requirements | Convert project principles into operational constraints. |
| Feedback | Review, validation, checklist results, evaluation summaries, validator output | Detect drift and correct execution before completion. |
| Stability | Bounded scope, preserved architecture, rollback safety, validation visibility | Reduce uncontrolled edits and long-term project instability. |
| Disturbance | Ambiguous user requests, context loss, dirty worktrees, failing validation, scope creep, multi-agent edits | Identify forces that can destabilize agent behavior. |
| Correction | Workflow correction phase, required corrections, follow-up risks | Close the loop when review or validation detects a problem. |
| Practice Test | Examples, validator, CI, real agent usage, release package installation | Let actual use reveal whether the governance rules work. |

## Runtime Interpretation

The governance runtime treats an AI coding agent as a capable but non-deterministic execution component.

The agent is not assumed to be stable by default. It can drift, overgeneralize, miss context, rewrite too broadly, or infer hidden state incorrectly.

The governance system therefore acts as a stabilizing wrapper:

```text
User Task
    -> Task Classification
    -> Risk Estimation
    -> Governance Material Selection
    -> Bounded Workflow Execution
    -> Checklist and Evaluation Feedback
    -> Correction or Completion
```

This is the practical v1 control loop.

## Design Implications

### 1. Stability Comes First

The first requirement of a controlled execution process is stability.

For this project, stability means:

- changes remain bounded to the task
- architecture boundaries are preserved
- unrelated user changes are not reverted
- destructive or irreversible actions require explicit approval
- validation gaps are reported instead of hidden

### 2. Information Controls Execution

Agent behavior should be guided by observable information, not hidden assumptions.

This is why the runtime emphasizes:

- reading nearby files before editing
- inspecting git state
- recording meaningful assumptions
- using state files when risk or scope makes hidden state dangerous
- reporting evidence for checklist and evaluation results

### 3. Risk Selects Governance Intensity

Not every task needs the same control effort.

Low-risk documentation edits should stay lightweight. High-risk refactors, releases, public interface changes, or destructive actions require stronger governance.

The router exists to prevent both under-control and over-control:

- under-control causes drift and unsafe execution
- over-control creates context entropy and process drag

### 4. Feedback Must Be Actionable

Feedback is useful only when it can change behavior.

A checklist or evaluation should not be decorative. It should answer:

- what was checked
- what evidence supports the result
- what remains uncertain
- whether correction is required

This is why checklist and evaluation outputs include evidence, issues, validation gaps, residual risk, and required corrections.

### 5. Practice Refines the Runtime

Engineering Cybernetics is rooted in engineering practice.

Likewise, this governance runtime should evolve through actual agent use:

- validator failures should reveal structural gaps
- examples should reveal routing ambiguity
- release package installation should reveal adoption friction
- real coding tasks should reveal missing policies or workflows

The governance system should be revised when practice shows that a rule is unclear, too weak, too heavy, or not operationally useful.

## Current Alignment Strengths

- The project has a clear entry point in `AGENTS.md`.
- The `.ai/` directory separates philosophy, routing, policies, workflows, state, checklists, and evaluation.
- The router selects different governance paths based on task class and risk.
- State files make important execution conditions observable.
- Checklists, evaluation schemas, and the validator provide feedback.
- Adapters preserve the same control loop across multiple agent runtimes.
- Release packaging supports practical reuse in other repositories.

## Current Limits

- The runtime is lightweight and manual; it does not enforce behavior automatically.
- The validator checks structure, not actual agent behavior quality.
- State updates depend on agent discipline and user expectations.
- Disturbance handling is modeled as a first-class router document in `.ai/router/disturbance_model.md`.
- Examples are still needed to test the governance loop in realistic tasks.
- CLI and MCP integrations are future work.

## Next Design Moves

The next improvements should strengthen conceptual and operational alignment without over-formalizing the system:

1. Validate disturbance model behavior through examples and validator checks.
2. Add examples that demonstrate routing, execution, evaluation, and correction.
3. Expand the validator to check examples and release package contents.
4. Build a small Python CLI around classification, routing, validation, and reporting.
5. Consider MCP integration only after the CLI behavior is stable.
