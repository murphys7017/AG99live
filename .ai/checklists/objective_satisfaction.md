# Objective Satisfaction Checklist

- Is the current objective explicit?
- Are success criteria or acceptance conditions known?
- Are non-goals or scope boundaries clear?
- Did the implementation or response optimize for the requested outcome rather than nearby cleanup?
- Were relevant quality criteria checked before completion?
- Are unmet objectives, partial satisfaction, or tradeoffs visible?

## Result Format

```yaml
checklist_result:
  checklist: objective_satisfaction
  status: pass | partial | fail
  evidence:
    - <user request, inspected file, changed file, validation result, or evaluation>
  issues:
    - <objective, success criteria, non-goal, or quality issue or empty>
  required_correction:
    - <correction or empty>
```
