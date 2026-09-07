import json
import sqlite3

import pytest

from src.error_classification import (
    HTTP_403_OTHER,
    HTTP_403_SUBSCRIPTION_REQUIRED,
    HTTP_403_TOS_VIOLATION,
    classify_http_403,
    get_error_classifications,
    matches_error_code_filter,
    paginate_and_classify_summaries,
    safe_json_list,
    safe_json_object,
)
from src.panel import creds
from src.storage.sqlite_manager import SQLiteManager


def _error_payload(*reasons: str) -> str:
    return json.dumps(
        {
            "error": {
                "code": 403,
                "status": "PERMISSION_DENIED",
                "details": [{"reason": reason} for reason in reasons],
            }
        }
    )


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (_error_payload("TOS_VIOLATION"), HTTP_403_TOS_VIOLATION),
        (
            _error_payload("SUBSCRIPTION_REQUIRED"),
            HTTP_403_SUBSCRIPTION_REQUIRED,
        ),
        (_error_payload("UNKNOWN_REASON"), HTTP_403_OTHER),
        (json.dumps({"error": {"details": []}}), HTTP_403_OTHER),
        (json.dumps({"error": {}}), HTTP_403_OTHER),
        ("not-json", HTTP_403_OTHER),
        ("", HTTP_403_OTHER),
        (None, HTTP_403_OTHER),
    ],
)
def test_classify_http_403(payload, expected):
    assert classify_http_403(payload) == expected


def test_tos_violation_takes_precedence_when_multiple_reasons_are_present():
    payload = _error_payload("SUBSCRIPTION_REQUIRED", "TOS_VIOLATION")
    assert classify_http_403(payload) == HTTP_403_TOS_VIOLATION


def test_error_classifications_require_a_403_error_code():
    messages = {"403": _error_payload("TOS_VIOLATION")}
    assert get_error_classifications([403], messages) == {"403": "tos_violation"}
    assert get_error_classifications(["403"], messages) == {"403": "tos_violation"}
    assert get_error_classifications([400], messages) == {}


@pytest.mark.parametrize(
    ("filter_value", "expected"),
    [
        ("all", True),
        ("403", True),
        ("403_tos_violation", True),
        ("403_subscription_required", False),
        ("403_other", False),
        ("400", False),
        ("none", False),
    ],
)
def test_matches_error_code_filter(filter_value, expected):
    messages = {"403": _error_payload("TOS_VIOLATION")}
    assert matches_error_code_filter([403], messages, filter_value) is expected


def test_legacy_403_without_error_message_is_other():
    assert matches_error_code_filter([403], {}, "403_other") is True
    assert get_error_classifications([403], {}) == {"403": "other"}


def test_none_filter_matches_empty_error_list():
    assert matches_error_code_filter([], {}, "none") is True


def test_safe_json_decoders_tolerate_invalid_and_wrong_shaped_values():
    assert safe_json_list('[403, "429"]') == [403, "429"]
    assert safe_json_list("not-json") == []
    assert safe_json_list('{"403": true}') == []
    assert safe_json_object('{"403": "message"}') == {"403": "message"}
    assert safe_json_object("not-json") == {}
    assert safe_json_object("[403]") == {}


@pytest.mark.asyncio
async def test_two_stage_classification_loads_only_page_403_messages():
    calls = []

    async def loader(filenames):
        calls.append(filenames)
        return {"page.json": {"403": _error_payload("TOS_VIOLATION")}}

    summaries = [
        {"filename": "before.json", "error_codes": [403]},
        {"filename": "page.json", "error_codes": [403]},
        {"filename": "after.json", "error_codes": [403]},
    ]
    selected, total = await paginate_and_classify_summaries(
        summaries,
        offset=1,
        limit=1,
        error_code_filter="all",
        include_error_classifications=True,
        load_error_messages=loader,
    )
    assert total == 3
    assert calls == [["page.json"]]
    assert selected[0]["error_classifications"] == {"403": "tos_violation"}


@pytest.mark.asyncio
async def test_management_style_summary_does_not_load_error_messages():
    calls = []

    async def loader(filenames):
        calls.append(filenames)
        return {}

    selected, total = await paginate_and_classify_summaries(
        [{"filename": "credential.json", "error_codes": [403]}],
        offset=0,
        limit=None,
        error_code_filter=None,
        include_error_classifications=False,
        load_error_messages=loader,
    )
    assert total == 1
    assert selected[0]["error_codes"] == [403]
    assert "error_classifications" not in selected[0]
    assert calls == []


@pytest.mark.asyncio
async def test_large_non_403_page_does_not_load_error_messages():
    calls = []

    async def loader(filenames):
        calls.append(filenames)
        return {}

    summaries = [
        {"filename": f"credential-{index}.json", "error_codes": [400]}
        for index in range(5000)
    ]
    selected, total = await paginate_and_classify_summaries(
        summaries,
        offset=2000,
        limit=25,
        error_code_filter="all",
        include_error_classifications=True,
        load_error_messages=loader,
    )
    assert total == 5000
    assert len(selected) == 25
    assert calls == []


@pytest.mark.asyncio
async def test_classified_filter_loads_all_and_only_403_candidates():
    calls = []

    async def loader(filenames):
        calls.append(filenames)
        return {
            "tos.json": {"403": _error_payload("TOS_VIOLATION")},
            "other.json": {"403": "not-json"},
        }

    selected, total = await paginate_and_classify_summaries(
        [
            {"filename": "tos.json", "error_codes": [403]},
            {"filename": "other.json", "error_codes": ["403"]},
            {"filename": "bad-request.json", "error_codes": [400]},
        ],
        offset=0,
        limit=20,
        error_code_filter="403_tos_violation",
        include_error_classifications=True,
        load_error_messages=loader,
    )
    assert total == 1
    assert [item["filename"] for item in selected] == ["tos.json"]
    assert calls == [["tos.json", "other.json"]]


@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
@pytest.mark.asyncio
async def test_sqlite_summary_classifies_and_filters_403_errors(
    tmp_path, monkeypatch, mode
):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        cases = {
            "tos.json": _error_payload("TOS_VIOLATION"),
            "subscription.json": _error_payload("SUBSCRIPTION_REQUIRED"),
            "other.json": _error_payload("UNKNOWN_REASON"),
            "legacy.json": None,
        }
        for filename, message in cases.items():
            await manager.store_credential(filename, {"project_id": filename}, mode=mode)
            update = {"error_codes": [403], "error_messages": {}}
            if message is not None:
                update["error_messages"] = {"403": message}
            await manager.update_credential_state(filename, update, mode=mode)

        expected = {
            "403": set(cases),
            "403_tos_violation": {"tos.json"},
            "403_subscription_required": {"subscription.json"},
            "403_other": {"other.json", "legacy.json"},
        }
        for filter_value, filenames in expected.items():
            result = await manager.get_credentials_summary(
                mode=mode,
                error_code_filter=filter_value,
                include_error_classifications=True,
            )
            assert {item["filename"] for item in result["items"]} == filenames
            assert result["total"] == len(filenames)

        result = await manager.get_credentials_summary(
            mode=mode,
            error_code_filter="403_tos_violation",
            include_error_classifications=True,
        )
        assert result["items"][0]["error_codes"] == [403]
        assert result["items"][0]["error_classifications"] == {
            "403": "tos_violation"
        }
        assert "error_messages" not in result["items"][0]
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_sqlite_corrupt_error_json_does_not_empty_the_summary(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        for filename in ("corrupt-message.json", "corrupt-code.json", "healthy.json"):
            await manager.store_credential(filename, {"project_id": filename})
        connection = sqlite3.connect(tmp_path / "credentials.db")
        connection.execute(
            "UPDATE credentials SET error_codes = ?, error_messages = ? WHERE filename = ?",
            ("[403]", "not-json", "corrupt-message.json"),
        )
        connection.execute(
            "UPDATE credentials SET error_codes = ?, error_messages = ? WHERE filename = ?",
            ("not-json", "not-json", "corrupt-code.json"),
        )
        connection.commit()
        connection.close()

        result = await manager.get_credentials_summary(
            mode="geminicli",
            error_code_filter="403_other",
            include_error_classifications=True,
        )
        assert [item["filename"] for item in result["items"]] == [
            "corrupt-message.json"
        ]
        assert result["items"][0]["error_classifications"] == {"403": "other"}

        all_result = await manager.get_credentials_summary(mode="geminicli")
        assert all_result["total"] == 3
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_credential_errors_endpoint_adds_classification(monkeypatch):
    class Backend:
        async def get_credential_errors(self, filename, mode="geminicli"):
            return {
                "filename": filename,
                "error_codes": [403],
                "error_messages": {
                    "403": _error_payload("SUBSCRIPTION_REQUIRED")
                },
            }

    class Adapter:
        _backend = Backend()

    async def get_storage_adapter():
        return Adapter()

    monkeypatch.setattr(creds, "get_storage_adapter", get_storage_adapter)
    response = await creds.get_credential_errors(
        "subscription.json", token="panel-token"
    )
    payload = json.loads(response.body)
    assert payload["error_codes"] == [403]
    assert payload["error_classifications"] == {
        "403": "subscription_required"
    }


@pytest.mark.asyncio
async def test_credential_status_returns_classification_without_error_body(monkeypatch):
    class Backend:
        async def get_credentials_summary(self, **kwargs):
            return {
                "items": [
                    {
                        "filename": "tos.json",
                        "user_email": "user@example.test",
                        "disabled": True,
                        "error_codes": [403],
                        "error_classifications": {"403": "tos_violation"},
                        "last_success": None,
                    }
                ],
                "total": 1,
                "stats": {"total": 1, "normal": 0, "disabled": 1},
            }

    class Adapter:
        _backend = Backend()

        async def get_backend_info(self):
            return {"backend_type": "test"}

    async def get_storage_adapter():
        return Adapter()

    monkeypatch.setattr(creds, "get_storage_adapter", get_storage_adapter)
    response = await creds.get_creds_status_common(
        offset=0, limit=20, status_filter="all", error_code_filter="403_tos_violation"
    )
    payload = json.loads(response.body)
    assert payload["items"][0]["error_codes"] == [403]
    assert payload["items"][0]["error_classifications"] == {
        "403": "tos_violation"
    }
    assert "error_messages" not in payload["items"][0]
