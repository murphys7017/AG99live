# Release Package

The GitHub Actions release workflow builds a zip package intended to be copied into another repository.

## Included Files

The release package includes:

- `AGENTS.md`
- `.ai/`
- `.ai/runtime/continuity.md`
- `.ai/policies/objective.yaml`
- `.ai/checklists/objective_satisfaction.md`
- `docs/runtime/README.md`
- `docs/runtime/agent_execution_protocol.md`
- `docs/runtime/release_package.md`
- `tools/README.md`
- `tools/validate_runtime.py`
- `INSTALL.md`

The package does not include `README.md`, `examples/`, `references/`, or `ai_governance_runtime_overview_manifest.md` by default. Those files are repository-level documentation, regression samples, conceptual background, or would conflict with files that commonly already exist in a target project.

## Installation

Extract the release zip into the root directory of the target repository.

Then run:

```bash
python tools/validate_runtime.py --warnings-as-errors
```

After validation passes, customize `AGENTS.md` for the target repository.
