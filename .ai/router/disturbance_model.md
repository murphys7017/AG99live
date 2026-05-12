# Disturbance Model

Disturbances are conditions that can destabilize AI coding agent execution.

Use this model while estimating risk and deciding whether to load stronger governance material.

## Purpose

AI coding agents are non-deterministic execution components. Even when the user request is simple, external conditions can make execution unstable.

Disturbance awareness helps prevent:

- silent scope expansion
- accidental overwrite of user work
- architecture drift
- false confidence in incomplete validation
- stale or contradictory governance loading
- incomplete final reporting

## Common Disturbances

### Ambiguous User Intent

Signals:

- user request has multiple plausible interpretations
- acceptance criteria are missing
- target files or behavior are unspecified

Default response:

- clarify when necessary
- otherwise choose the smallest reversible scope
- record assumptions when they affect implementation

Risk effect:

- low -> medium when ambiguity affects implementation behavior
- medium -> high when ambiguity affects public interfaces, architecture, or release actions

### Context Loss

Signals:

- relevant files cannot be inspected
- prior decisions are unavailable
- conversation or task state has been compacted
- governance files conflict or appear stale

Default response:

- reload the entry path
- inspect nearby files
- reduce confidence
- surface missing context

Risk effect:

- escalate at least one level when context is required for safe execution

### Dirty Worktree

Signals:

- uncommitted changes exist before work starts
- files relevant to the task already contain edits
- generated files or caches appear unexpectedly

Default response:

- inspect status before editing
- preserve user changes
- avoid broad formatting or rewrites
- report unrelated dirty state only when relevant

Risk effect:

- low -> medium when touched files are already dirty
- medium -> high when dirty state affects release, destructive actions, or broad refactors

### Validation Gap

Signals:

- tests do not exist
- tests cannot run
- required tools are unavailable
- validation is partial or only manual

Default response:

- run practical checks
- report skipped or unavailable validation
- avoid claiming full verification

Risk effect:

- low -> medium when behavior changes cannot be validated
- medium -> high when validation gaps affect public APIs, releases, or architecture changes

### Scope Creep

Signals:

- agent identifies unrelated cleanup opportunities
- implementation touches unrelated modules
- task expands from fix to refactor or redesign

Default response:

- stop expansion
- ask for approval when broader work is needed
- keep unrelated cleanup out of the current change

Risk effect:

- escalate to high if broad unrelated changes are required or already occurring

### Multi-agent or User Concurrent Edits

Signals:

- files change unexpectedly during execution
- user edits overlap with agent work
- multiple agents may be working in the same repository

Default response:

- re-read affected files
- preserve external edits
- avoid reverting changes not made by the current agent
- report conflicts or uncertainty

Risk effect:

- escalate when overlap affects correctness, architecture, or release readiness

### Governance Drift

Signals:

- `AGENTS.md`, adapters, loading rules, and workflows disagree
- required runtime files are missing
- checklist or evaluation schemas are incomplete
- release package contents differ from documentation

Default response:

- run `tools/validate_runtime.py`
- fix structural drift before relying on the runtime
- report residual governance risk

Risk effect:

- medium by default for governance edits
- high when drift affects agent entry points, routing, or release packaging

## Escalation Rule

When a disturbance is present and its impact is uncertain, choose the higher plausible risk level.

If multiple disturbances are present, consider the combined effect rather than evaluating each in isolation.

## Relationship to Risk Levels

This file complements `risk_levels.md`.

Risk levels describe governance intensity. The disturbance model describes destabilizing conditions that may require higher intensity.
