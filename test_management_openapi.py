from __future__ import annotations

import json

from scripts.export_management_openapi import BASELINE, build_schema


def test_management_openapi_matches_reviewed_baseline() -> None:
    assert json.loads(BASELINE.read_text(encoding="utf-8")) == build_schema()


def test_management_openapi_has_only_read_contract_paths_and_no_secret_fields() -> None:
    schema = build_schema()

    assert set(schema["paths"]) == {
        "/management/v1/capabilities",
        "/management/v1/summary",
        "/management/v1/credentials",
        "/management/v1/stats",
    }
    serialized = json.dumps(schema)
    for forbidden in (
        "access_token",
        "refresh_token",
        "client_secret",
        "management_token",
        "panel_password",
    ):
        assert forbidden not in serialized.lower()
    for path in schema["paths"].values():
        assert set(path) <= {"get"}
        for operation in path.values():
            assert "422" not in operation["responses"]
            assert operation["security"] == [{"HTTPBearer": []}]
