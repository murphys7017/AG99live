# Evaluation

This directory defines feedback criteria for execution quality, architecture stability, modification safety, and governance compliance.

v1 should focus on explicit review criteria before introducing numeric scoring or autonomous evaluation.

## Purpose

Evaluation closes the governance loop after implementation or review.

It answers:

- Was the requested objective satisfied?
- Was the work executionally sound?
- Was architecture stability preserved?
- Was the intended governance path actually followed?
- What remains unverified or risky?

## v1 Output Format

Use this logical output structure when an evaluation is performed:

```yaml
evaluation:
  objective_satisfaction: pass | partial | fail | not_applicable
  execution_quality: pass | partial | fail | not_applicable
  architecture_stability: pass | partial | fail | not_applicable
  governance_compliance: pass | partial | fail | not_applicable
  validation_status: passed | partial | failed | not_run
  risk_level: low | medium | high | unknown
  evidence:
    - <file, command, checklist, or observation used as support>
  validation_gap:
    - <gap or skipped check>
  residual_risk:
    - <risk remaining after completion>
  key_risks:
    - <remaining risk>
  required_correction:
    - <correction required before safe completion>
  follow_up_required: true | false
```

This schema does not need to be materialized as a file for every task, but the evaluation summary should be compatible with it.

## Evaluation Dimensions

### Objective Satisfaction

Use to assess whether the delivered result satisfies the user's requested outcome, known success criteria, and relevant non-goals.

Normally applicable to:

- feature development
- bugfix
- refactor
- documentation with a specific audience or purpose
- release

May be `not_applicable` for:

- exploratory review without a completion claim
- trivial read-only questions

### Execution Quality

Use to assess whether the task followed a bounded, reviewable, and validated execution path.

Normally applicable to:

- feature development
- bugfix
- refactor
- repository maintenance
- release

### Architecture Stability

Use to assess whether architecture boundaries, coupling, and rollback safety were preserved.

Normally applicable to:

- medium or high-risk refactor
- high-risk feature work
- tasks with boundary changes

May be `not_applicable` for:

- docs-only tasks
- local metadata updates
- isolated review tasks with no structural implications

### Governance Compliance

Use to assess whether the expected governance path was followed.

Normally applicable to:

- high-risk tasks
- release tasks
- tasks where process quality matters as much as code changes

May be `not_applicable` for:

- low-risk trivial tasks
- isolated documentation cleanup

## Evaluation Discipline

- Do not force full evaluation for every trivial task.
- Do use explicit evaluation for medium and high-risk work.
- Prefer `partial` over pretending a result is fully verified.
- Prefer `not_applicable` over fake completeness.
- Always surface validation gaps when checks were not run or were incomplete.

## Result Semantics

- `pass`: the criterion was checked and no material issue remains.
- `partial`: the criterion was partly checked or some limitation remains.
- `fail`: the criterion found an issue that should block or change completion.
- `not_applicable`: the criterion does not apply to this task class or risk level.

## Evidence Requirement

Every `pass`, `partial`, or `fail` result should have supporting evidence.

Evidence can include:

- inspected files
- commands or validation checks run
- loaded checklists
- review findings
- explicit user approval

## Correction Rule

If `required_correction` is non-empty, the task should not be reported as fully complete.

The final response should either describe the correction performed or explicitly state why correction remains pending.
