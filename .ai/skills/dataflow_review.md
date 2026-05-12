# Dataflow Review Skill

Use dataflow review when correctness depends on a multi-step path rather than a single function or file.

## Procedure

1. Identify the primary path from input to final externally visible effect.
2. Name each boundary where data is transformed, validated, persisted, broadcast, rendered, or reported.
3. Inspect whether each boundary preserves the intended schema, identity, status, and error semantics.
4. Distinguish primary-path success from fallback or degraded execution.
5. Treat default values, retries, swallowed exceptions, and silent ignores as risk signals until proven harmless.
6. Verify the fix at the earliest point where the defect is introduced.

## Review Outcomes

Classify each relevant segment as one of:

- confirmed correct
- confirmed faulty
- works only through fallback or degraded behavior
- insufficient information, requiring logs, reproduction, or targeted validation

## Completion Standard

Do not mark a dataflow-sensitive task complete merely because the system does not crash.

Completion requires evidence that the intended primary path produced the expected result, or an explicit statement of the remaining uncertainty.
