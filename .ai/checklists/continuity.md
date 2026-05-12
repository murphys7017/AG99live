# Continuity Checklist

- Is the original task still the active task?
- Has scope expanded beyond the original request?
- Has the task class changed?
- Has risk changed?
- Has any new disturbance appeared?
- Is the selected workflow still appropriate?
- Are additional policies, skills, checklists, or state files now required?
- Are assumptions, unresolved questions, and validation gaps visible?
- Is correction required before continuing or completing?

## Result Format

```yaml
checklist_result:
  checklist: continuity
  status: pass | partial | fail
  evidence:
    - <checkpoint, user change, state file, validation result, or inspected file>
  issues:
    - <drift, scope, risk, workflow, or validation issue or empty>
  required_correction:
    - <correction or empty>
```
