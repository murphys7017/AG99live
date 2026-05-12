# Architecture Checklist

- Are module boundaries preserved?
- Are invariants still valid?
- Is state explicit and observable?
- Is coupling increased unnecessarily?
- Can the change be reviewed and rolled back safely?

## Result Format

```yaml
checklist_result:
  checklist: architecture
  status: pass | partial | fail
  evidence:
    - <architecture file, boundary, or reviewed module>
  issues:
    - <architecture issue or empty>
  required_correction:
    - <correction or empty>
```
