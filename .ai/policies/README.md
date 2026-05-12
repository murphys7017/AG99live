# Policies

Policy files define structured operational constraints for AI coding agents.

Policies are not just prose instructions. They should be readable by humans and stable enough to be interpreted by future tooling.

## Schema

Each policy file uses this structure:

```yaml
name: <policy-name>
version: <semver>
purpose: <short purpose statement>
rules:
  - id: <stable-rule-id>
    severity: low | medium | high | critical
    category: <policy-category>
    description: <human-readable rule>
    applies_to:
      - <task-or-action-signal>
    enforcement: <expected enforcement behavior>
    exceptions:
      - <allowed exception signal>
```

## Field Semantics

- `id`: stable identifier used by router, workflow, and review references.
- `severity`: how strongly the rule should influence execution.
- `category`: the control domain affected by the rule.
- `description`: concise human-readable rule text.
- `applies_to`: task classes, risk signals, or actions that activate the rule.
- `enforcement`: expected behavior when the rule applies.
- `exceptions`: explicit situations where the rule may be relaxed.

## Severity Levels

- `low`: advisory preference.
- `medium`: expected default behavior.
- `high`: strong constraint that should be followed unless explicitly overridden.
- `critical`: must not be bypassed without explicit user approval or a documented exception.

## v1 Policy Discipline

- Keep rule identifiers stable.
- Prefer small specific rules over broad vague rules.
- Do not encode complex automation before router behavior is validated.
- Surface policy conflicts instead of silently choosing one.
