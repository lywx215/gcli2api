"""Safe exact-model selection and mocked probes for the live catalog validator."""

import json
import sqlite3

import httpx
import pytest

from scripts import validate_antigravity_model_catalog as validator


OPUS_MODELS = [f"claude-opus-5-5-{tier}" for tier in ("low", "medium", "high")]


def test_exact_selection_keeps_all_efforts_once_in_requested_order():
    assert validator._choose_exact_models(set(OPUS_MODELS), OPUS_MODELS + OPUS_MODELS) == [
        ("claude-opus-5-5", model) for model in OPUS_MODELS
    ]


@pytest.mark.parametrize("missing", ["claude-opus-4-6", "claude-opus-5-5", OPUS_MODELS[2]])
def test_exact_selection_fails_closed_when_requested_id_is_not_public(missing):
    with pytest.raises(RuntimeError, match="missing models"):
        validator._choose_exact_models(set(OPUS_MODELS[:2]), [OPUS_MODELS[0], missing])


@pytest.mark.parametrize("selection", [
    ["--family", "claude-opus-5-5"], ["--all-models"],
    ["--all-public-models"], ["--all-internal-models"],
    ["--live-url", "http://127.0.0.1:1"],
])
def test_exact_cli_conflicts_fail_before_reading_credentials(monkeypatch, selection):
    def forbidden_read(_):
        pytest.fail("invalid arguments must not read any credential")
    monkeypatch.setattr(validator, "_read_enabled_pro_credential", forbidden_read)
    with pytest.raises(SystemExit) as error:
        validator.main(["--source-db", "unused.db", "--models", *OPUS_MODELS, *selection])
    assert error.value.code == 2


def test_exact_candidate_uses_temporary_storage_and_disables_generation_retries(monkeypatch, tmp_path):
    for key in ("POSTGRESQL_URI", "MONGODB_URI", "MYSQL_URI", "REDIS_URL",
                "DATABASE_URL", "KEEPALIVE_URL", "NODE_MANAGEMENT_TOKEN"):
        monkeypatch.setenv(key, "synthetic-external-setting")
    monkeypatch.setenv("RETRY_429_ENABLED", "true")
    monkeypatch.setenv("RETRY_429_MAX_RETRIES", "8")
    monkeypatch.setenv("SMART_429_PROTECTION_ENABLED", "true")
    environment = validator._candidate_environment(tmp_path, 7862, "fixture-password", single_attempt=True)
    assert environment["CREDENTIALS_DIR"] == str(tmp_path)
    assert environment["RETRY_429_ENABLED"] == "false"
    assert environment["RETRY_429_MAX_RETRIES"] == "0"
    assert environment["SMART_429_PROTECTION_ENABLED"] == "false"
    assert environment["ENABLE_LOG"] == "0"
    for key in ("POSTGRESQL_URI", "MONGODB_URI", "MYSQL_URI", "REDIS_URL",
                "DATABASE_URL", "KEEPALIVE_URL", "NODE_MANAGEMENT_TOKEN"):
        assert environment[key] == ""


def test_exact_validation_posts_once_per_effort_and_never_probes_other_families(monkeypatch):
    posts = []
    public_ids = OPUS_MODELS + ["claude-sonnet-4-6", "gemini-3.8-flash-medium"]
    quota_models = {model: {"public": True} for model in public_ids}
    quota_models["internal-fixture"] = {"public": False}

    def handler(request):
        if request.url.path == "/keepalive":
            return httpx.Response(200)
        if request.url.path == "/creds/stats-today":
            return httpx.Response(200, json={"total_count": len(posts), "success_count": len(posts)})
        if request.url.path.startswith("/creds/quota/"):
            return httpx.Response(200, json={"success": True, "models": quota_models})
        if request.url.path == "/antigravity/v1/models":
            return httpx.Response(200, json={"data": [{"id": model} for model in public_ids]})
        assert request.url.path == "/antigravity/v1/chat/completions"
        payload = json.loads(request.content)
        posts.append(payload)
        return httpx.Response(200, json={"choices": [{"message": {"content": "测试成功"}}]})

    client_class = httpx.Client
    monkeypatch.setattr(validator.httpx, "Client", lambda **kwargs: client_class(
        **kwargs, transport=httpx.MockTransport(handler)))
    report = validator._validate_live_service(
        "http://fixture", "fixture-password", "fixture-password", "fixture.json",
        set(), False, False, False, 1, requested_models=OPUS_MODELS + [OPUS_MODELS[0]],
    )
    assert [payload["model"] for payload in posts] == OPUS_MODELS
    assert all(payload["max_tokens"] == 256 and payload["stream"] is False for payload in posts)
    assert report["tested_model_count"] == report["stats_total_delta"] == 3
    assert all(result["ok"] for result in report["results"])


def test_source_credential_selection_opens_read_only_and_copies_only_one(monkeypatch, tmp_path):
    source = tmp_path / "synthetic.db"
    connect = sqlite3.connect
    with connect(source) as database:
        database.execute("CREATE TABLE antigravity_credentials (id INTEGER, filename TEXT, credential_data TEXT, disabled INTEGER, permanent_disabled INTEGER, tier TEXT, rotation_order INTEGER)")
        for index in range(2):
            database.execute("INSERT INTO antigravity_credentials VALUES (?, ?, ?, 0, 0, 'pro', ?)",
                             (index, f"fixture-{index}.json", json.dumps({"access_token": f"fixture-token-{index}"}), index))
    connections = []

    def traced_connect(path, **kwargs):
        connections.append((path, kwargs))
        return connect(path, **kwargs)
    monkeypatch.setattr(validator.sqlite3, "connect", traced_connect)
    filename, credential = validator._read_enabled_pro_credential(source)
    assert filename == "fixture-0.json"
    assert credential == {"access_token": "fixture-token-0"}
    assert connections == [(source.resolve().as_uri() + "?mode=ro", {"uri": True})]
