from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

from check_ui_collaboration import validate_plan, validate_pr


class CollaborationGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ui-collab-test-", dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "shared.ts").write_bytes(b"frozen shared contract\n")
        self.plan = {"schema_version": 1, "integration_branch": "codex/ui-parity-integration",
                     "source_baseline_commit": "a" * 40,
                     "execution_policy": {"mode": "queue_only", "max_automatic_runs": 0, "global_cli_limit": 8,
                                          "per_host_cli_limit": 4, "retry_max_total_attempts": 3},
                     "frozen_context": [{"path": "shared.ts", "sha256": hashlib.sha256(b"frozen shared contract\n").hexdigest()}],
                     "packages": [{"id": "one", "branch": "codex/mac-one", "allowed_files": ["one.tsx"],
                                   "context_files": ["shared.ts"], "start_document": "docs/one.md", "ordered_steps": ["source", "tests"]},
                                  {"id": "two", "branch": "codex/mac-two", "allowed_files": ["two.tsx"],
                                   "context_files": ["shared.ts"], "start_document": "docs/two.md", "ordered_steps": ["source", "tests"]}]}

    def test_independent_modules_can_share_frozen_context(self):
        validate_plan(self.root, self.plan, verify_hashes=True)
        validate_pr(self.root, self.plan, "codex/mac-one", ["docs/one.md", "one.tsx"])

    def test_two_writers_are_rejected(self):
        self.plan["packages"][1]["allowed_files"] = ["one.tsx"]
        with self.assertRaisesRegex(ValueError, "write/write"):
            validate_plan(self.root, self.plan)

    def test_write_read_dependency_is_not_parallel(self):
        self.plan["packages"][0]["allowed_files"] = ["shared.ts"]
        self.plan["packages"][0]["context_files"] = []
        with self.assertRaisesRegex(ValueError, "write/read"):
            validate_plan(self.root, self.plan)

    def test_changed_frozen_bytes_stop_mac_delivery(self):
        (self.root / "shared.ts").write_bytes(b"different owner changed the contract\n")
        with self.assertRaisesRegex(ValueError, "Frozen dependency"):
            validate_pr(self.root, self.plan, "codex/mac-one", ["one.tsx"])

    def test_mac_cannot_modify_other_module_or_shared_inputs(self):
        for changed in (["two.tsx"], ["shared.ts"], ["docs/two.md"]):
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, "ownership"):
                validate_pr(self.root, self.plan, "codex/mac-one", changed)

    def test_escaping_paths_are_rejected(self):
        self.plan["packages"][0]["allowed_files"] = ["../outside.tsx"]
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            validate_plan(self.root, self.plan)

    def test_excess_concurrency_and_retries_are_rejected(self):
        for key, value in (("global_cli_limit", 9), ("per_host_cli_limit", 5), ("retry_max_total_attempts", 4)):
            plan = copy.deepcopy(self.plan)
            plan["execution_policy"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_plan(self.root, plan)

    def test_github_cannot_start_a_model(self):
        self.plan["execution_policy"]["max_automatic_runs"] = 1
        with self.assertRaisesRegex(ValueError, "zero automatic"):
            validate_plan(self.root, self.plan)


if __name__ == "__main__":
    unittest.main()
