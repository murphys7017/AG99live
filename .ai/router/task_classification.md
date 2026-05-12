# Task Classification

Classify tasks before selecting workflows, skills, state handling, and evaluation.

## Task Classes

- documentation
- feature development
- bugfix
- refactor
- review
- release
- repository maintenance

## Primary Classification Rule

Classify by the primary intended outcome of the task, not by the tools used during the task.

Examples:

- Editing Markdown to clarify behavior is `documentation`.
- Fixing broken behavior is `bugfix`.
- Changing structure while preserving behavior is `refactor`.
- Assessing code without making changes is `review`.

## Classification Heuristics

### documentation

Use when the primary output is explanatory or descriptive material.

Typical signals:

- README updates
- architecture notes
- comments or docstrings
- governance text changes

### feature development

Use when the primary output is new behavior, new capability, or expanded functionality.

Typical signals:

- adding a new module or interface
- adding support for a new use case
- extending a workflow or adapter with new behavior

### bugfix

Use when the primary output is correction of faulty behavior.

Typical signals:

- incorrect output
- broken command or workflow
- invalid assumptions or logic
- failed validation tied to an identifiable defect

### refactor

Use when the primary output is structural improvement without intentionally changing externally visible behavior.

Typical signals:

- reorganizing files or modules
- renaming for clarity
- reducing coupling
- replacing brittle structure with safer equivalent structure

### review

Use when the primary output is assessment, findings, or risk identification rather than implementation.

Typical signals:

- code review
- governance review
- architecture review
- gap analysis

### release

Use when the primary output is packaging, publishing, versioning, or release readiness.

Typical signals:

- preparing release notes
- validating release artifacts
- tagging or publishing
- checking final repository readiness

### repository maintenance

Use when the primary output is repository setup or operational housekeeping.

Typical signals:

- initializing repo structure
- reorganizing docs directories
- updating repository metadata
- adding repository-level configs

## Priority Rules

When a task appears to fit multiple classes, use the first matching rule below:

1. If the task is primarily an assessment, classify as `review`.
2. If the task is primarily packaging or publication, classify as `release`.
3. If the task corrects faulty behavior, classify as `bugfix`.
4. If the task adds new behavior, classify as `feature development`.
5. If the task preserves behavior while changing structure, classify as `refactor`.
6. If the task changes only explanatory material, classify as `documentation`.
7. Otherwise classify as `repository maintenance`.

## Secondary Tags

After primary classification, record useful secondary concerns when relevant:

- architecture-impact
- public-interface-impact
- safety-sensitive
- state-update-required
- validation-limited

Secondary tags do not replace the primary task class. They increase governance intensity.

## Naming Convention

Human-readable task class names may use spaces:

- `feature development`
- `repository maintenance`

State enum values in `state/task_state.yaml` should use snake_case:

- `feature_development`
- `repository_maintenance`

When matching across documents, consider both forms equivalent. Tools and validators should normalize to snake_case for comparison.
