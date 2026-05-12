# Root Cause Checklist

- Was the root cause hypothesis stated before or during the fix?
- Was the hypothesis checked against code paths, logs, tests, or reproduction evidence?
- Was the fix applied where the defect is introduced rather than only downstream?
- Were fallback, default, retry, or degraded paths separated from primary-path correctness?
- Are fallback triggers observable through logs, diagnostics, evaluation output, or explicit reporting?
- Does validation prove the primary path works, not only that the system avoids crashing?

## Result Format

```yaml
checklist_result:
  checklist: root_cause
  status: pass | partial | fail
  evidence:
    - <code path, log, test, reproduction, or validation step>
  issues:
    - <root-cause or fallback issue or empty>
  required_correction:
    - <correction or empty>
```
