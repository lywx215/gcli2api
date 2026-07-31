import json

import pytest
from fastapi import HTTPException

import config
from src.models import ConfigSaveRequest
from src.panel import config_routes
from src.panel.utils import get_env_locked_keys
from src.router.stream_passthrough import build_streaming_response_or_error
from src.smart_429 import smart_429_service
from src.streaming_latency import (
    StreamRequestTrace,
    bind_stream_trace,
    reset_stream_trace,
)


@pytest.mark.asyncio
async def test_persisted_diagnostics_switch_hot_reloads(monkeypatch):
    values = {"stream_diagnostics_enabled": True}

    class Backend:
        async def reload_config_cache(self):
            return None

    class Adapter:
        _backend = Backend()

        async def get_all_config(self):
            return dict(values)

    async def get_adapter():
        return Adapter()

    monkeypatch.delenv("STREAM_DIAGNOSTICS_ENABLED", raising=False)
    monkeypatch.setattr("src.storage_adapter.get_storage_adapter", get_adapter)
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})
    monkeypatch.setattr(config, "_stream_diagnostics_enabled_cache", False)

    await config.reload_config()
    assert await config.get_stream_diagnostics_enabled() is True
    assert config.is_stream_diagnostics_enabled() is True

    values["stream_diagnostics_enabled"] = False
    await config.reload_config()
    assert await config.get_stream_diagnostics_enabled() is False
    assert config.is_stream_diagnostics_enabled() is False


@pytest.mark.asyncio
@pytest.mark.parametrize(("env_value", "expected"), [("true", True), ("false", False)])
async def test_diagnostics_environment_value_wins_and_locks(
    monkeypatch, env_value, expected
):
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(
        config,
        "_config_cache",
        {"stream_diagnostics_enabled": not expected},
    )
    monkeypatch.setattr(
        config,
        "_stream_diagnostics_enabled_cache",
        not expected,
    )
    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", env_value)

    assert await config.get_stream_diagnostics_enabled() is expected
    assert config.is_stream_diagnostics_enabled() is expected
    assert "stream_diagnostics_enabled" in get_env_locked_keys()


def test_diagnostics_setting_is_snapshotted_per_request(monkeypatch):
    monkeypatch.delenv("STREAM_DIAGNOSTICS_ENABLED", raising=False)
    monkeypatch.setattr(config, "_stream_diagnostics_enabled_cache", False)
    old_trace = StreamRequestTrace(model="old")

    monkeypatch.setattr(config, "_stream_diagnostics_enabled_cache", True)
    new_trace = StreamRequestTrace(model="new")

    messages = []
    monkeypatch.setattr("src.streaming_latency.log.info", messages.append)
    old_trace.finish("error", force_log=True)
    new_trace.finish("error", force_log=True)

    assert old_trace.diagnostics_enabled is False
    assert new_trace.diagnostics_enabled is True
    assert len(messages) == 1
    assert '"model":"new"' in messages[0]


@pytest.mark.asyncio
async def test_inflight_response_keeps_diagnostics_header_snapshot(monkeypatch):
    async def one_chunk():
        yield b"data: ok\n\n"

    monkeypatch.delenv("STREAM_DIAGNOSTICS_ENABLED", raising=False)
    monkeypatch.setattr(config, "_stream_diagnostics_enabled_cache", False)
    trace = StreamRequestTrace(model="old")
    monkeypatch.setattr(config, "_stream_diagnostics_enabled_cache", True)

    token = bind_stream_trace(trace)
    try:
        old_response = await build_streaming_response_or_error(
            one_chunk(), model="old", protocol="gemini"
        )
    finally:
        reset_stream_trace(token)
    new_response = await build_streaming_response_or_error(
        one_chunk(), model="new", protocol="gemini"
    )

    assert old_response.headers.get("server-timing") is None
    assert new_response.headers.get("server-timing")


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["true", 1, None])
async def test_panel_rejects_non_boolean_diagnostics_values(invalid):
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(config={"stream_diagnostics_enabled": invalid}),
            token="test",
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_panel_get_exposes_diagnostics_switch(monkeypatch):
    class Adapter:
        async def get_all_config(self):
            return {}

    async def get_adapter():
        return Adapter()

    async def enabled():
        return True

    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(
        config_routes.config,
        "get_stream_diagnostics_enabled",
        enabled,
    )
    monkeypatch.setattr(
        config_routes.config,
        "get_geminicli_capacity_fast_fail_enabled",
        enabled,
    )
    monkeypatch.setattr(
        config_routes.config,
        "get_geminicli_stream_header_hedge_enabled",
        enabled,
    )

    response = await config_routes.get_config(token="test")
    payload = json.loads(response.body)
    assert payload["config"]["stream_diagnostics_enabled"] is True
    assert payload["config"]["geminicli_capacity_fast_fail_enabled"] is True
    assert payload["config"]["geminicli_stream_header_hedge_enabled"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("workers", "reload_diagnostics", "result_key"),
    [("1", True, "hot_updated"), ("2", False, "restart_required")],
)
async def test_panel_reports_single_or_multi_worker_activation(
    monkeypatch, workers, reload_diagnostics, result_key
):
    stored = {}
    reload_calls = []

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def reload_config(**kwargs):
        reload_calls.append(kwargs)

    async def password():
        return "pwd"

    async def reconfigure():
        return None

    monkeypatch.delenv("STREAM_DIAGNOSTICS_ENABLED", raising=False)
    monkeypatch.setenv("WORKERS", workers)
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", reload_config)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)

    response = await config_routes.save_config(
        ConfigSaveRequest(config={"stream_diagnostics_enabled": True}),
        token="test",
    )
    payload = json.loads(response.body)

    assert stored == {"stream_diagnostics_enabled": True}
    assert reload_calls == [
        {
            "reload_stream_diagnostics": reload_diagnostics,
            "reload_capacity_fast_fail": reload_diagnostics,
            "reload_stream_header_hedge": reload_diagnostics,
        }
    ]
    assert payload[result_key] == ["stream_diagnostics_enabled"]
    if workers == "2":
        assert "restart_notice" in payload


@pytest.mark.asyncio
async def test_panel_ignores_environment_locked_diagnostics_save(monkeypatch):
    stored = {}

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def no_op(**kwargs):
        return None

    async def password():
        return "pwd"

    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", "false")
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", no_op)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", no_op)

    response = await config_routes.save_config(
        ConfigSaveRequest(config={"stream_diagnostics_enabled": True}),
        token="test",
    )
    payload = json.loads(response.body)

    assert stored == {}
    assert payload["saved_config"] == {}
    assert payload["hot_updated"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("env_value", "expected"), [("true", True), ("false", False)])
async def test_capacity_fast_fail_environment_value_wins_and_locks(
    monkeypatch, env_value, expected
):
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(
        config,
        "_config_cache",
        {"geminicli_capacity_fast_fail_enabled": not expected},
    )
    monkeypatch.setattr(
        config,
        "_geminicli_capacity_fast_fail_enabled_cache",
        not expected,
    )
    monkeypatch.setenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", env_value)

    assert await config.get_geminicli_capacity_fast_fail_enabled() is expected
    assert config.is_geminicli_capacity_fast_fail_enabled() is expected
    assert "geminicli_capacity_fast_fail_enabled" in get_env_locked_keys()


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["true", 1, None])
async def test_panel_rejects_non_boolean_capacity_fast_fail(invalid):
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(
                config={"geminicli_capacity_fast_fail_enabled": invalid}
            ),
            token="test",
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_panel_hot_updates_capacity_fast_fail(monkeypatch):
    stored = {}
    reload_calls = []

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def reload_config(**kwargs):
        reload_calls.append(kwargs)

    async def password():
        return "pwd"

    async def reconfigure():
        return None

    monkeypatch.delenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", raising=False)
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", reload_config)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)

    response = await config_routes.save_config(
        ConfigSaveRequest(
            config={"geminicli_capacity_fast_fail_enabled": True}
        ),
        token="test",
    )
    payload = json.loads(response.body)
    assert stored == {"geminicli_capacity_fast_fail_enabled": True}
    assert reload_calls == [
        {
            "reload_stream_diagnostics": True,
            "reload_capacity_fast_fail": True,
            "reload_stream_header_hedge": True,
        }
    ]
    assert payload["hot_updated"] == ["geminicli_capacity_fast_fail_enabled"]


@pytest.mark.asyncio
@pytest.mark.parametrize(("env_value", "expected"), [("true", True), ("false", False)])
async def test_stream_header_hedge_environment_value_wins_and_locks(
    monkeypatch, env_value, expected
):
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(
        config,
        "_config_cache",
        {"geminicli_stream_header_hedge_enabled": not expected},
    )
    monkeypatch.setattr(
        config,
        "_geminicli_stream_header_hedge_enabled_cache",
        not expected,
    )
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", env_value)

    assert await config.get_geminicli_stream_header_hedge_enabled() is expected
    assert config.is_geminicli_stream_header_hedge_enabled() is expected
    assert "geminicli_stream_header_hedge_enabled" in get_env_locked_keys()


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["true", 1, None])
async def test_panel_rejects_non_boolean_stream_header_hedge(invalid):
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(
                config={"geminicli_stream_header_hedge_enabled": invalid}
            ),
            token="test",
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_panel_hot_updates_stream_header_hedge(monkeypatch):
    stored = {}
    reload_calls = []

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def reload_config(**kwargs):
        reload_calls.append(kwargs)

    async def password():
        return "pwd"

    async def reconfigure():
        return None

    monkeypatch.delenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", raising=False)
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", reload_config)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)

    response = await config_routes.save_config(
        ConfigSaveRequest(
            config={"geminicli_stream_header_hedge_enabled": True}
        ),
        token="test",
    )
    payload = json.loads(response.body)
    assert stored == {"geminicli_stream_header_hedge_enabled": True}
    assert reload_calls == [
        {
            "reload_stream_diagnostics": True,
            "reload_capacity_fast_fail": True,
            "reload_stream_header_hedge": True,
        }
    ]
    assert payload["hot_updated"] == ["geminicli_stream_header_hedge_enabled"]


@pytest.mark.asyncio
async def test_panel_requires_restart_for_stream_header_hedge_with_multiple_workers(
    monkeypatch,
):
    stored = {}
    reload_calls = []

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def reload_config(**kwargs):
        reload_calls.append(kwargs)

    async def password():
        return "pwd"

    async def reconfigure():
        return None

    monkeypatch.delenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", raising=False)
    monkeypatch.setenv("WORKERS", "2")
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", reload_config)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)

    response = await config_routes.save_config(
        ConfigSaveRequest(
            config={"geminicli_stream_header_hedge_enabled": True}
        ),
        token="test",
    )
    payload = json.loads(response.body)

    assert stored == {"geminicli_stream_header_hedge_enabled": True}
    assert reload_calls == [
        {
            "reload_stream_diagnostics": False,
            "reload_capacity_fast_fail": False,
            "reload_stream_header_hedge": False,
        }
    ]
    assert payload["hot_updated"] == []
    assert payload["restart_required"] == [
        "geminicli_stream_header_hedge_enabled"
    ]
    assert "restart_notice" in payload


@pytest.mark.asyncio
async def test_hedge_cost_config_environment_wins_and_locks(monkeypatch):
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(
        config,
        "_config_cache",
        {
            "geminicli_stream_header_hedge_sample_rate": 0.8,
            "geminicli_stream_header_hedge_daily_budget": 99,
        },
    )
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE", "0.05")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_DAILY_BUDGET", "10")

    assert await config.get_geminicli_stream_header_hedge_sample_rate() == 0.05
    assert await config.get_geminicli_stream_header_hedge_daily_budget() == 10
    locked = get_env_locked_keys()
    assert "geminicli_stream_header_hedge_sample_rate" in locked
    assert "geminicli_stream_header_hedge_daily_budget" in locked


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", [-0.1, 1.1, "0.5", True, None])
async def test_panel_rejects_invalid_hedge_sample_rate(invalid):
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(
                config={
                    "geminicli_stream_header_hedge_sample_rate": invalid
                }
            ),
            token="test",
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", [-1, 1001, 1.5, "10", True, None])
async def test_panel_rejects_invalid_hedge_daily_budget(invalid):
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(
                config={
                    "geminicli_stream_header_hedge_daily_budget": invalid
                }
            ),
            token="test",
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_panel_hot_updates_hedge_sample_rate_and_budget(monkeypatch):
    stored = {}
    reload_calls = []

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def reload_config(**kwargs):
        reload_calls.append(kwargs)

    async def password():
        return "pwd"

    async def reconfigure():
        return None

    monkeypatch.delenv(
        "GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE", raising=False
    )
    monkeypatch.delenv(
        "GEMINICLI_STREAM_HEADER_HEDGE_DAILY_BUDGET", raising=False
    )
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", reload_config)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)

    response = await config_routes.save_config(
        ConfigSaveRequest(
            config={
                "geminicli_stream_header_hedge_sample_rate": 0.05,
                "geminicli_stream_header_hedge_daily_budget": 10,
            }
        ),
        token="test",
    )
    payload = json.loads(response.body)
    assert stored == {
        "geminicli_stream_header_hedge_sample_rate": 0.05,
        "geminicli_stream_header_hedge_daily_budget": 10,
    }
    assert payload["hot_updated"] == [
        "geminicli_stream_header_hedge_sample_rate",
        "geminicli_stream_header_hedge_daily_budget",
    ]
    assert reload_calls == [
        {
            "reload_stream_diagnostics": True,
            "reload_capacity_fast_fail": True,
            "reload_stream_header_hedge": True,
        }
    ]
