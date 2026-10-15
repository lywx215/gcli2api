"""Validate queued UI module ownership; never dispatches agents or changes source."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

PLAN_PATH = "docs/ui-redesign/github/TASKS.json"
RELATED_TESTS = {
    "LegacyModelQuota": ["src/pages/credentials/LegacyModelQuota.test.tsx", "src/pages/credentials/ResultView.test.tsx"],
    "AgQuotaEvidence": ["src/pages/credentials/AgQuotaEvidence.test.tsx", "src/pages/credentials/advancedApi.test.ts"],
}


def relative_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Expected an explicit repository-relative path")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"..", ".git"} or any(c in part for c in "*?[]") for part in path.parts):
        raise ValueError("Unsafe repository-relative path: " + name)
    resolved = root.joinpath(*path.parts).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError("Path escapes repository: " + name)
    return resolved


def validate_plan(root: Path, plan: dict, *, verify_hashes: bool = False) -> None:
    if plan.get("schema_version") != 1:
        raise ValueError("Unsupported collaboration schema")
    policy = plan["execution_policy"]
    if policy.get("mode") != "queue_only" or policy.get("max_automatic_runs") != 0:
        raise ValueError("GitHub must remain queue_only with zero automatic model runs")
    if not 1 <= policy["global_cli_limit"] <= 8 or not 1 <= policy["per_host_cli_limit"] <= 4:
        raise ValueError("CLI concurrency exceeds the approved bounds")
    if not 1 <= policy["retry_max_total_attempts"] <= 3:
        raise ValueError("Retry limit exceeds three total attempts")
    if plan.get("integration_branch") != "codex/ui-parity-integration":
        raise ValueError("Unexpected integration branch")
    if not re.fullmatch(r"[0-9a-f]{40}", plan["source_baseline_commit"]):
        raise ValueError("Expected immutable source baseline SHA")
    contexts = {}
    for entry in plan["frozen_context"]:
        path = relative_path(root, entry["path"])
        if entry["path"] in contexts or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise ValueError("Invalid frozen context manifest")
        contexts[entry["path"]] = entry
        if verify_hashes and (not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]):
            raise ValueError("Frozen dependency changed: " + entry["path"])
    ids, branches, ownership = set(), set(), []
    for package in plan["packages"]:
        if package["id"] in ids or package["branch"] in branches or not package["branch"].startswith("codex/"):
            raise ValueError("Duplicate module or branch")
        ids.add(package["id"])
        branches.add(package["branch"])
        if not 2 <= len(package["ordered_steps"]) <= 5:
            raise ValueError("Expected a coherent package of two to five ordered steps")
        writes, reads = set(package["allowed_files"]), set(package["context_files"])
        if not writes or len(writes) != len(package["allowed_files"]) or writes & reads:
            raise ValueError("Invalid module file ownership")
        for name in writes | reads | {package["start_document"]}:
            relative_path(root, name)
        if not reads.issubset(contexts):
            raise ValueError("Module has an unfrozen dependency")
        ownership.append((writes, reads))
    for index, (writes, reads) in enumerate(ownership):
        for other_writes, other_reads in ownership[index + 1:]:
            if writes & other_writes or writes & other_reads or other_writes & reads:
                raise ValueError("Modules have a write/write or write/read conflict")


def validate_pr(root: Path, plan: dict, branch: str, changed: list[str]) -> dict | None:
    module = next((package for package in plan["packages"] if package["branch"] == branch), None)
    validate_plan(root, plan, verify_hashes=module is not None)
    if module is not None:
        allowed = set(module["allowed_files"]) | {module["start_document"]}
        if any(name not in allowed for name in changed):
            raise ValueError("Module PR changes files outside its declared ownership")
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--branch", default="")
    parser.add_argument("--verify-frozen", action="store_true")
    parser.add_argument("--run-module-tests", action="store_true")
    args = parser.parse_args()
    root = args.repo.resolve()
    plan = json.loads((root / PLAN_PATH).read_text(encoding="utf-8"))
    validate_plan(root, plan, verify_hashes=args.verify_frozen)
    changed = []
    if bool(args.base) != bool(args.head):
        raise ValueError("Both base and head are required")
    if args.base:
        if not all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in (args.base, args.head)):
            raise ValueError("Diff references must be full immutable SHAs")
        diff = subprocess.run(["git", "--no-optional-locks", "-C", str(root), "diff", "--name-only", "-z", args.base + "..." + args.head], capture_output=True, check=True)
        changed = [name.decode("utf-8") for name in diff.stdout.split(b"\0") if name]
    module = validate_pr(root, plan, args.branch, changed)
    frontend_changed = any(name.startswith("frontend/") for name in changed)
    tests = RELATED_TESTS.get(module["module"], []) if module else []
    if args.run_module_tests:
        if not tests or any(not (root / "frontend" / name).is_file() for name in tests):
            raise ValueError("No complete module test set is available")
        return subprocess.run(["npm", "test", "--", "--maxWorkers=2", *tests], cwd=root / "frontend", check=False).returncode
    output_file = os.environ.get("GITHUB_OUTPUT")
    if output_file:
        with open(output_file, "a", encoding="utf-8") as output:
            output.write(f"frontend_changed={str(frontend_changed).lower()}\n")
            output.write(f"module_tests={str(bool(tests) and frontend_changed).lower()}\n")
    print(json.dumps({"status": "PASS", "modules": len(plan["packages"]), "module": module["module"] if module else None,
                      "changed_paths": len(changed), "frontend_changed": frontend_changed,
                      "automatic_model_runs": 0, "docker": "skipped", "deployment": "not performed"}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, OSError) as exc:
        raise SystemExit("UI collaboration validation failed: " + str(exc))
