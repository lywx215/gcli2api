"""Catalog HTTP acceptance with real compiler/store and no upstream network."""

import asyncio
import importlib
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

import config
import src.storage_adapter as adapter_module
from src.router.base_router import create_gemini_model_list, create_openai_model_list
from src.models import model_to_dict


@pytest.fixture
def catalog_runtime(monkeypatch):
    state = {"table": {"routes": []}, "reads": 0, "fetches": 0, "fetch_mode": "ok", "timeout_seconds": []}

    async def fresh(key, default=None):
        assert key == "model_routing"
        state["reads"] += 1
        return deepcopy(state["table"])

    monkeypatch.setattr(adapter_module, "_storage_adapter", SimpleNamespace(_initialized=True, get_config_fresh=fresh))
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})
    app = FastAPI()
    cli = importlib.import_module("src.router.geminicli.model_list")
    ag = importlib.import_module("src.router.antigravity.model_list")
    app.include_router(cli.router)
    app.include_router(ag.router)

    async def auth_ok():
        return "isolated-test-auth"

    app.dependency_overrides[cli.authenticate_flexible] = auth_ok
    app.dependency_overrides[ag.authenticate_flexible] = auth_ok
    ids = ["opaque-target", "opaque-target-search", "ordinary-model"]
    monkeypatch.setattr(cli, "get_available_models", lambda channel: list(ids))

    async def fetch():
        state["fetches"] += 1
        if state["fetch_mode"] == "cancel":
            raise asyncio.CancelledError()
        if state["fetch_mode"] == "error":
            raise RuntimeError("private-target-diagnostic")
        if state["fetch_mode"] == "empty":
            return []
        return [{"id": name} for name in ids]

    monkeypatch.setattr(ag, "fetch_available_models", fetch)
    real_timeout = asyncio.timeout

    def observed_timeout(seconds):
        state["timeout_seconds"].append(seconds)
        return real_timeout(seconds)

    monkeypatch.setattr(ag.asyncio, "timeout", observed_timeout)
    return app, state, ids


async def get_catalog(app, channel, protocol):
    prefix = "/antigravity" if channel == "antigravity" else ""
    path = prefix + ("/v1beta/models" if protocol == "gemini" else "/v1/models")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        return await client.get(path)


def ids_of(response, protocol):
    body = response.json()
    return [item["name"].removeprefix("models/") for item in body["models"]] if protocol == "gemini" else [item["id"] for item in body["data"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["gemini", "openai"])
async def test_empty_table_catalog_is_master_deep_equal(catalog_runtime, channel, protocol):
    app, state, original = catalog_runtime
    source = original if channel == "geminicli" else [prefix + name for name in original for prefix in ("", "假流式/", "抗截断/")]
    response = await get_catalog(app, channel, protocol)
    assert response.status_code == 200, response.text
    if protocol == "gemini":
        from src.utils import get_base_model_from_feature_model
        expected = create_gemini_model_list(source, base_name_extractor=get_base_model_from_feature_model)
    else:
        expected = {"object": "list", "data": [model_to_dict(model) for model in create_openai_model_list(source, owned_by="google").data]}
        # The existing factory timestamps the response at generation time.
        for actual, wanted in zip(response.json()["data"], expected["data"]):
            wanted["created"] = actual["created"]
    assert response.json() == expected
    assert state["reads"] == 1
    assert state["fetches"] == (channel == "antigravity")
    if channel == "antigravity":
        assert state["timeout_seconds"] == [30]


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["gemini", "openai"])
async def test_projection_hides_target_without_inventing_capabilities(catalog_runtime, channel, protocol):
    app, state, _ = catalog_runtime
    state["table"] = {"routes": [{"channel": channel, "public_name": "public-alpha", "upstream_name": "opaque-target", "enabled": True}]}
    response = await get_catalog(app, channel, protocol)
    assert response.status_code == 200, response.text
    names = ids_of(response, protocol)
    assert "public-alpha" in names and "opaque-target" not in names
    assert "假流式/public-alpha" in names
    assert "public-alpha-search" not in names
    assert ("opaque-target-search" in names) is (channel == "antigravity")
    if protocol == "gemini":
        public = next(item for item in response.json()["models"] if item["name"] == "models/public-alpha")
        assert all("opaque-target" not in str(public[field]) for field in ("name", "baseModelId", "displayName", "description"))


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["gemini", "openai"])
@pytest.mark.parametrize("failure", ["error", "empty"])
async def test_failed_ag_directory_preserves_only_configured_public_items(catalog_runtime, protocol, failure):
    app, state, _ = catalog_runtime
    state["fetch_mode"] = failure
    empty = await get_catalog(app, "antigravity", protocol)
    assert empty.status_code == 200 and ids_of(empty, protocol) == []
    state["table"] = {"routes": [{"channel": "antigravity", "public_name": "public-alpha", "upstream_name": "opaque-target", "enabled": True}]}
    routed = await get_catalog(app, "antigravity", protocol)
    assert routed.status_code == 200
    assert ids_of(routed, protocol) == ["public-alpha", "假流式/public-alpha", "抗截断/public-alpha"]
    assert "private-target-diagnostic" not in routed.text


@pytest.mark.asyncio
async def test_invalid_ag_config_never_fetches_directory(catalog_runtime):
    app, state, _ = catalog_runtime
    state["table"] = {"routes": [None]}
    response = await get_catalog(app, "antigravity", "gemini")
    assert response.status_code == 503
    assert state["fetches"] == 0


@pytest.mark.asyncio
async def test_ag_directory_cancellation_propagates(catalog_runtime):
    app, state, _ = catalog_runtime
    state["fetch_mode"] = "cancel"
    with pytest.raises(asyncio.CancelledError):
        await get_catalog(app, "antigravity", "gemini")


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["gemini", "openai"])
@pytest.mark.parametrize("missing", [False, True])
async def test_source_drift_empty_or_missing_catalog_keeps_master_projection(catalog_runtime, monkeypatch, channel, protocol, missing):
    from dataclasses import replace
    from src.model_routing import policy
    from src.model_routing.types import thaw
    app, state, _ = catalog_runtime
    if missing:
        async def fresh(key, default=None):
            state["reads"] += 1
            return default
        adapter_module._storage_adapter.get_config_fresh = fresh
    baseline = await get_catalog(app, channel, protocol)
    assert baseline.status_code == 200
    original = policy.build_policy_snapshot()
    rules = thaw(original.static_rules)
    rules["source_digests"]["src/models.py"] = "synthetic-unreviewed-source"
    candidate = replace(original, static_rules=rules, digest=policy.digest(rules))
    monkeypatch.setattr(policy, "build_policy_snapshot", lambda: candidate)
    result = await get_catalog(app, channel, protocol)
    assert result.status_code == 200
    expected = baseline.json()
    if protocol == "openai":
        for before, after in zip(expected["data"], result.json()["data"]):
            before["created"] = after["created"]  # Existing factory timestamp.
    assert result.json() == expected and state["reads"] == 2
