# Engineering Cybernetics Alignment

This project keeps AI agent governance minimal: observe, classify, estimate risk, act in a bounded way, validate, and correct.

## Mapping

| Concept | Runtime Equivalent |
| --- | --- |
| System | repository + agent + `.ai/` |
| Controller | `AGENTS.md` and `.ai/index.md` |
| State | `.ai/state.yaml` and surfaced assumptions |
| Sensor | file inspection, git status, tests, user instructions |
| Feedback | review, validation, validator output |
| Stability | bounded scope, preserved architecture, visible validation gaps |
| Disturbance | ambiguity, context loss, dirty worktree, failed validation, scope creep |

## Loop

```text
task -> classify -> risk -> inspect -> change -> review -> validate -> correct/report
```

Low-risk work should stay light. Higher-risk work should make assumptions, state, validation gaps, and residual risk explicit.
