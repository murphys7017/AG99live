# Implementation Checklist

- Is the change bounded to the requested task?
- Does it preserve existing architecture and style?
- Are assumptions explicit where they matter?
- Is validation available and practical?
- Are unrelated files untouched?

## Result Format

```yaml
checklist_result:
  checklist: implementation
  status: pass | partial | fail
  evidence:
    - <changed file, inspected file, or validation step>
  issues:
    - <issue or empty>
  required_correction:
    - <correction or empty>
```
