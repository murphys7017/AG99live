# Tools

This directory contains local helper tools for validating and operating the governance runtime.

## Runtime Validator

Run from the repository root:

```bash
python tools/validate_runtime.py
```

The validator is dependency-free and checks the v1 runtime structure:

- required governance files exist
- `loading_rules.md` references resolve
- task classes have loading matrix coverage
- policy YAML files contain required rule fields
- checklist and evaluation files expose result schemas
- state YAML files contain expected fields
- adapters point back to the shared execution protocol and router

Use `--warnings-as-errors` when running in CI:

```bash
python tools/validate_runtime.py --warnings-as-errors
```
