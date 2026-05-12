#!/usr/bin/env python3
"""Validate the v1 AI governance runtime structure.

The validator is intentionally dependency-free so it can run immediately after a
release archive is unpacked into a target repository.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


REQUIRED_FILES = [
    "AGENTS.md",
    ".ai/README.md",
    ".ai/index.md",
    ".ai/constitution/core.md",
    ".ai/invariants/core.md",
    ".ai/router/task_classification.md",
    ".ai/router/risk_levels.md",
    ".ai/router/disturbance_model.md",
    ".ai/router/loading_rules.md",
    ".ai/runtime/continuity.md",
    ".ai/checklists/continuity.md",
    ".ai/policies/correctness.yaml",
    ".ai/policies/objective.yaml",
    ".ai/policies/workflow.yaml",
    ".ai/workflows/documentation.md",
    ".ai/workflows/feature_development.md",
    ".ai/workflows/bugfix.md",
    ".ai/workflows/refactor.md",
    ".ai/workflows/review.md",
    ".ai/workflows/release.md",
    ".ai/checklists/review.md",
    ".ai/checklists/root_cause.md",
    ".ai/checklists/objective_satisfaction.md",
    ".ai/evaluation/README.md",
    ".ai/skills/dataflow_review.md",
    ".ai/state/README.md",
    "docs/runtime/agent_execution_protocol.md",
]

EXPECTED_TASK_CLASSES = [
    "documentation",
    "feature development",
    "bugfix",
    "refactor",
    "review",
    "release",
    "repository maintenance",
]

EXPECTED_POLICY_KEYS = [
    "id",
    "severity",
    "category",
    "description",
    "applies_to",
    "enforcement",
    "exceptions",
]

EXPECTED_STATE_FIELDS = {
    "task_state.yaml": ["current_task:", "type:", "scope:", "risk:", "phase:", "owner:"],
    "context_state.yaml": ["context:", "confidence:", "required_files_loaded:", "assumptions:", "unresolved_questions:"],
    "architecture_state.yaml": ["architecture:", "stability:", "pending_breaking_change:", "boundary_changes:"],
    "risk_state.yaml": ["risk:", "current_level:", "scope_expansion_detected:", "architecture_risk_detected:", "destructive_action_pending:"],
    "execution_state.yaml": ["execution:", "phase:", "validation_passed:", "review_completed:", "correction_required:"],
    "verification_state.yaml": ["verification:", "checks_run:", "checks_failed:", "validation_gap:"],
}

EXPECTED_EXAMPLE_FILES = [
    "request.md",
    "expected_route.yaml",
    "expected_behavior.md",
    "expected_evaluation.yaml",
]

EXPECTED_EXAMPLE_ROUTE_FIELDS = [
    "task_class:",
    "risk_level:",
    "workflow:",
    "required_policies:",
    "required_checklists:",
    "expected_evaluation:",
    "state_update:",
]

EXPECTED_EXAMPLE_EVALUATION_FIELDS = [
    "evaluation:",
    "objective_satisfaction:",
    "execution_quality:",
    "governance_compliance:",
    "validation_status:",
    "evidence:",
    "validation_gap:",
    "residual_risk:",
    "required_correction:",
    "follow_up_required:",
]


@dataclass(frozen=True)
class Finding:
    severity: str
    path: str
    message: str


class Validator:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.findings: list[Finding] = []

    def error(self, path: str, message: str) -> None:
        self.findings.append(Finding("ERROR", path, message))

    def warn(self, path: str, message: str) -> None:
        self.findings.append(Finding("WARN", path, message))

    def read_text(self, relative: str) -> str:
        return (self.root / relative).read_text(encoding="utf-8")

    def exists(self, relative: str) -> bool:
        return (self.root / relative).exists()

    def validate(self) -> list[Finding]:
        self.check_required_files()
        self.check_loading_rule_links()
        self.check_governance_map()
        self.check_disturbance_model_linkage()
        self.check_runtime_continuity()
        self.check_objective_discipline()
        self.check_correctness_discipline()
        self.check_task_class_coverage()
        self.check_policy_schema()
        self.check_checklist_result_schema()
        self.check_evaluation_schema()
        self.check_state_schema()
        self.check_adapter_protocol_links()
        self.check_examples()
        return self.findings

    def check_required_files(self) -> None:
        for relative in REQUIRED_FILES:
            if not self.exists(relative):
                self.error(relative, "required file is missing")

    def check_loading_rule_links(self) -> None:
        relative = ".ai/router/loading_rules.md"
        if not self.exists(relative):
            return

        text = self.read_text(relative)
        refs = sorted(set(re.findall(r"`([^`]+)`", text)))
        runtime_refs = [
            ref
            for ref in refs
            if ref.startswith(
                (
                    "constitution/",
                    "invariants/",
                    "runtime/",
                    "policies/",
                    "workflows/",
                    "skills/",
                    "checklists/",
                    "evaluation/",
                    "state/",
                )
            )
        ]

        for ref in runtime_refs:
            if not (self.root / ".ai" / ref).exists():
                self.error(relative, f"referenced runtime file does not exist: {ref}")

    def check_governance_map(self) -> None:
        relative = ".ai/index.md"
        if not self.exists(relative):
            return

        text = self.read_text(relative)
        required_refs = [
            "router/task_classification.md",
            "router/risk_levels.md",
            "router/disturbance_model.md",
            "runtime/continuity.md",
            "router/loading_rules.md",
            "workflows/",
            "checklists/",
            "evaluation/",
            "state/",
            "adapters/",
        ]

        for ref in required_refs:
            if ref not in text:
                self.error(relative, f"governance map is missing reference: {ref}")

    def check_disturbance_model_linkage(self) -> None:
        risk_levels = ".ai/router/risk_levels.md"
        disturbance_model = ".ai/router/disturbance_model.md"
        if not self.exists(risk_levels) or not self.exists(disturbance_model):
            return

        risk_text = self.read_text(risk_levels)
        disturbance_text = self.read_text(disturbance_model)

        if "disturbance_model.md" not in risk_text:
            self.error(risk_levels, "risk levels do not reference the disturbance model")

        for required in [
            "Ambiguous User Intent",
            "Context Loss",
            "Dirty Worktree",
            "Validation Gap",
            "Scope Creep",
            "Governance Drift",
            "Escalation Rule",
        ]:
            if required not in disturbance_text:
                self.error(disturbance_model, f"disturbance model is missing section: {required}")

    def check_runtime_continuity(self) -> None:
        agents = "AGENTS.md"
        index = ".ai/index.md"
        protocol = "docs/runtime/agent_execution_protocol.md"
        continuity = ".ai/runtime/continuity.md"
        checklist = ".ai/checklists/continuity.md"

        for relative in [agents, index, protocol, continuity, checklist]:
            if not self.exists(relative):
                return

        agents_text = self.read_text(agents)
        index_text = self.read_text(index)
        protocol_text = self.read_text(protocol)
        continuity_text = self.read_text(continuity)
        checklist_text = self.read_text(checklist)

        for relative, text in [(agents, agents_text), (index, index_text), (protocol, protocol_text)]:
            for ref in [".ai/runtime/continuity.md", "checklists/continuity.md"]:
                if relative == agents and ref == "checklists/continuity.md":
                    continue
                if ref not in text:
                    self.error(relative, f"continuity reference is missing: {ref}")

        for required in [
            "Governance Checkpoint",
            "Checkpoint Triggers",
            "task class",
            "risk",
            "disturbance",
            "scope",
            "validation",
            "correction",
        ]:
            if required not in continuity_text:
                self.error(continuity, f"continuity guidance is missing concept: {required}")

        for required in ["checklist_result:", "checklist: continuity", "scope", "risk", "workflow", "validation"]:
            if required not in checklist_text:
                self.error(checklist, f"continuity checklist is missing concept: {required}")

        workflow_dir = self.root / ".ai" / "workflows"
        if workflow_dir.exists():
            for path in sorted(workflow_dir.glob("*.md")):
                text = path.read_text(encoding="utf-8")
                relative = path.relative_to(self.root).as_posix()
                if "continuity checkpoint" not in text:
                    self.error(relative, "workflow does not mention continuity checkpoint")

    def check_correctness_discipline(self) -> None:
        index = ".ai/index.md"
        loading_rules = ".ai/router/loading_rules.md"
        correctness_policy = ".ai/policies/correctness.yaml"
        dataflow_skill = ".ai/skills/dataflow_review.md"
        root_cause_checklist = ".ai/checklists/root_cause.md"

        for relative in [index, loading_rules, correctness_policy, dataflow_skill, root_cause_checklist]:
            if not self.exists(relative):
                return

        index_text = self.read_text(index)
        loading_text = self.read_text(loading_rules)
        policy_text = self.read_text(correctness_policy)
        skill_text = self.read_text(dataflow_skill)
        checklist_text = self.read_text(root_cause_checklist)

        for ref in ["policies/correctness.yaml", "skills/dataflow_review.md", "checklists/root_cause.md"]:
            if ref not in index_text:
                self.error(index, f"governance map is missing correctness reference: {ref}")

        for ref in ["policies/correctness.yaml", "skills/dataflow_review.md", "checklists/root_cause.md"]:
            if ref not in loading_text:
                self.error(loading_rules, f"loading rules are missing correctness reference: {ref}")

        for required in ["root_cause_over_masking", "fallback_not_correctness_proof", "observable_failure_paths"]:
            if required not in policy_text:
                self.error(correctness_policy, f"correctness policy is missing rule: {required}")

        for required in ["primary path", "fallback", "confirmed faulty", "insufficient information"]:
            if required not in skill_text:
                self.error(dataflow_skill, f"dataflow review skill is missing concept: {required}")

        for required in ["root cause", "fallback", "primary path", "checklist_result:"]:
            if required not in checklist_text:
                self.error(root_cause_checklist, f"root cause checklist is missing concept: {required}")

    def check_objective_discipline(self) -> None:
        agents = "AGENTS.md"
        index = ".ai/index.md"
        loading_rules = ".ai/router/loading_rules.md"
        objective_policy = ".ai/policies/objective.yaml"
        objective_checklist = ".ai/checklists/objective_satisfaction.md"
        evaluation = ".ai/evaluation/README.md"

        for relative in [agents, index, loading_rules, objective_policy, objective_checklist, evaluation]:
            if not self.exists(relative):
                return

        agents_text = self.read_text(agents)
        index_text = self.read_text(index)
        loading_text = self.read_text(loading_rules)
        policy_text = self.read_text(objective_policy)
        checklist_text = self.read_text(objective_checklist)
        evaluation_text = self.read_text(evaluation)

        for required in ["task objective", "success criteria", "non-goals"]:
            if required not in agents_text:
                self.error(agents, f"agent entry point is missing objective concept: {required}")

        for ref in ["policies/objective.yaml", "checklists/objective_satisfaction.md"]:
            if ref not in index_text:
                self.error(index, f"governance map is missing objective reference: {ref}")
            if ref not in loading_text:
                self.error(loading_rules, f"loading rules are missing objective reference: {ref}")

        for required in [
            "objective_before_execution",
            "quality_criteria_before_completion",
            "non_goals_limit_scope",
        ]:
            if required not in policy_text:
                self.error(objective_policy, f"objective policy is missing rule: {required}")

        for required in [
            "checklist: objective_satisfaction",
            "success criteria",
            "non-goals",
            "quality criteria",
            "required_correction:",
        ]:
            if required not in checklist_text:
                self.error(objective_checklist, f"objective checklist is missing concept: {required}")

        if "objective_satisfaction: pass | partial | fail | not_applicable" not in evaluation_text:
            self.error(evaluation, "evaluation schema is missing objective_satisfaction")

        workflow_dir = self.root / ".ai" / "workflows"
        if workflow_dir.exists():
            for path in sorted(workflow_dir.glob("*.md")):
                text = path.read_text(encoding="utf-8")
                relative = path.relative_to(self.root).as_posix()
                if "objective" not in text and "success criteria" not in text:
                    self.error(relative, "workflow does not mention objective or success criteria")

    def check_task_class_coverage(self) -> None:
        classification = ".ai/router/task_classification.md"
        loading_rules = ".ai/router/loading_rules.md"
        if not self.exists(classification) or not self.exists(loading_rules):
            return

        classification_text = self.read_text(classification)
        loading_text = self.read_text(loading_rules)

        for task_class in EXPECTED_TASK_CLASSES:
            if f"- {task_class}" not in classification_text:
                self.error(classification, f"expected task class is missing: {task_class}")
            if not re.search(rf"^### {re.escape(task_class)} \+", loading_text, re.MULTILINE):
                self.error(loading_rules, f"loading matrix has no entry for task class: {task_class}")

    def check_policy_schema(self) -> None:
        policy_dir = self.root / ".ai" / "policies"
        if not policy_dir.exists():
            self.error(".ai/policies", "policy directory is missing")
            return

        for path in sorted(policy_dir.glob("*.yaml")):
            text = path.read_text(encoding="utf-8")
            relative = path.relative_to(self.root).as_posix()
            if "rules:" not in text:
                self.error(relative, "policy file is missing rules block")
                continue

            rule_blocks = re.split(r"\n\s*-\s+id:\s+", text)
            if len(rule_blocks) <= 1:
                self.error(relative, "policy file has no rules with id")
                continue

            for index, block in enumerate(rule_blocks[1:], start=1):
                normalized = "id: " + block
                for key in EXPECTED_POLICY_KEYS:
                    if not re.search(rf"^\s*{re.escape(key)}\s*:", normalized, re.MULTILINE):
                        self.error(relative, f"rule {index} is missing key: {key}")

    def check_checklist_result_schema(self) -> None:
        checklist_dir = self.root / ".ai" / "checklists"
        if not checklist_dir.exists():
            self.error(".ai/checklists", "checklist directory is missing")
            return

        for path in sorted(checklist_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            relative = path.relative_to(self.root).as_posix()
            for required in ["## Result Format", "checklist_result:", "status: pass | partial | fail", "evidence:", "issues:", "required_correction:"]:
                if required not in text:
                    self.error(relative, f"checklist result schema is missing: {required}")

    def check_evaluation_schema(self) -> None:
        relative = ".ai/evaluation/README.md"
        if not self.exists(relative):
            return

        text = self.read_text(relative)
        for required in [
            "execution_quality: pass | partial | fail | not_applicable",
            "architecture_stability: pass | partial | fail | not_applicable",
            "governance_compliance: pass | partial | fail | not_applicable",
            "validation_status: passed | partial | failed | not_run",
            "evidence:",
            "required_correction:",
        ]:
            if required not in text:
                self.error(relative, f"evaluation schema is missing: {required}")

    def check_state_schema(self) -> None:
        state_dir = self.root / ".ai" / "state"
        if not state_dir.exists():
            self.error(".ai/state", "state directory is missing")
            return

        for filename, fields in EXPECTED_STATE_FIELDS.items():
            path = state_dir / filename
            relative = path.relative_to(self.root).as_posix()
            if not path.exists():
                self.error(relative, "state file is missing")
                continue
            text = path.read_text(encoding="utf-8")
            for field in fields:
                if field not in text:
                    self.error(relative, f"state field is missing: {field}")

    def check_adapter_protocol_links(self) -> None:
        adapter_dir = self.root / ".ai" / "adapters"
        if not adapter_dir.exists():
            self.warn(".ai/adapters", "adapter directory is missing")
            return

        required_refs = [
            "docs/runtime/agent_execution_protocol.md",
            ".ai/README.md",
            ".ai/index.md",
            ".ai/constitution/core.md",
            ".ai/invariants/core.md",
            ".ai/router/task_classification.md",
            ".ai/router/risk_levels.md",
            ".ai/router/disturbance_model.md",
            ".ai/runtime/continuity.md",
            ".ai/router/loading_rules.md",
        ]

        for path in sorted(adapter_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            relative = path.relative_to(self.root).as_posix()
            for required_ref in required_refs:
                if required_ref not in text:
                    self.error(relative, f"adapter is missing required load reference: {required_ref}")
            if "Do not bypass the router layer" not in text:
                self.error(relative, "adapter does not enforce router usage")

    def check_examples(self) -> None:
        examples_dir = self.root / "examples"
        if not examples_dir.exists():
            return

        readme = examples_dir / "README.md"
        if not readme.exists():
            self.error("examples/README.md", "examples README is missing")

        example_dirs = sorted(path for path in examples_dir.iterdir() if path.is_dir())
        if not example_dirs:
            self.error("examples", "examples directory has no example cases")
            return

        for example_dir in example_dirs:
            relative_dir = example_dir.relative_to(self.root).as_posix()

            for filename in EXPECTED_EXAMPLE_FILES:
                path = example_dir / filename
                if not path.exists():
                    self.error(f"{relative_dir}/{filename}", "example file is missing")

            route = example_dir / "expected_route.yaml"
            behavior = example_dir / "expected_behavior.md"
            evaluation = example_dir / "expected_evaluation.yaml"
            if not route.exists() or not behavior.exists() or not evaluation.exists():
                continue

            route_text = route.read_text(encoding="utf-8")
            behavior_text = behavior.read_text(encoding="utf-8")
            evaluation_text = evaluation.read_text(encoding="utf-8")

            for field in EXPECTED_EXAMPLE_ROUTE_FIELDS:
                if field not in route_text:
                    self.error(route.relative_to(self.root).as_posix(), f"expected route is missing field: {field}")

            for ref in re.findall(r"-\s+(\.ai/[^\s]+)", route_text):
                if not (self.root / ref).exists():
                    self.error(route.relative_to(self.root).as_posix(), f"referenced runtime file does not exist: {ref}")

            if "Acceptable behavior:" not in behavior_text:
                self.error(behavior.relative_to(self.root).as_posix(), "expected behavior is missing acceptable behavior section")
            if "Unacceptable behavior:" not in behavior_text:
                self.error(behavior.relative_to(self.root).as_posix(), "expected behavior is missing unacceptable behavior section")

            for field in EXPECTED_EXAMPLE_EVALUATION_FIELDS:
                if field not in evaluation_text:
                    self.error(evaluation.relative_to(self.root).as_posix(), f"expected evaluation is missing field: {field}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate the AI governance runtime structure.")
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="Repository root to validate. Defaults to the current directory.",
    )
    parser.add_argument(
        "--warnings-as-errors",
        action="store_true",
        help="Return a failing exit code when warnings are present.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = Path(args.root).resolve()

    validator = Validator(root)
    findings = validator.validate()

    errors = [finding for finding in findings if finding.severity == "ERROR"]
    warnings = [finding for finding in findings if finding.severity == "WARN"]

    if not findings:
        print(f"PASS: governance runtime validation succeeded for {root}")
        return 0

    for finding in findings:
        print(f"{finding.severity}: {finding.path}: {finding.message}")

    print(f"\nSummary: {len(errors)} error(s), {len(warnings)} warning(s)")

    if errors or (args.warnings_as_errors and warnings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
