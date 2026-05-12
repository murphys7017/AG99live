# Safety Checklist

- No secrets or credentials are committed.
- No destructive operation was performed without approval.
- User changes were not reverted.
- Public or irreversible actions were explicitly requested.
- Scope did not expand silently.

## Result Format

```yaml
checklist_result:
  checklist: safety
  status: pass | partial | fail
  evidence:
    - <approval, inspected file, or git status>
  issues:
    - <safety issue or empty>
  required_correction:
    - <correction or empty>
```
