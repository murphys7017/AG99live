# Review Checklist

- Are there correctness risks?
- Are there behavioral regressions?
- Are there missing tests or validation gaps?
- Are architecture boundaries preserved?
- Are findings prioritized by severity?

## Result Format

```yaml
checklist_result:
  checklist: review
  status: pass | partial | fail
  evidence:
    - <reviewed file, diff, or finding>
  issues:
    - <prioritized issue or empty>
  required_correction:
    - <correction or empty>
```
