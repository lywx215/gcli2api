"""Opt-in snapshots do not change Vertex or default normalizer contracts."""

from types import SimpleNamespace

import pytest

import config
from src.converter.gemini_fix import normalize_gemini_request
from src.converter.antigravity_fix import normalize_antigravity_request
from src.model_routing.types import FeatureSnapshot


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
async def test_snapshot_avoids_configuration_reread(monkeypatch, channel):
    async def forbidden():
        raise AssertionError("Feature snapshot must be consumed without rereading configuration")

    monkeypatch.setattr(config, "get_return_thoughts_to_frontend", forbidden)
    context = SimpleNamespace(feature_snapshot=FeatureSnapshot(return_thoughts=False),
                              resolution=SimpleNamespace(explicit_target=False))
    request = {"model": "opaque-target", "contents": [{"role": "user", "parts": [{"text": "hello"}]}]}
    if channel == "geminicli":
        result = await normalize_gemini_request(request, route_context=context)
    else:
        result = await normalize_antigravity_request(request, route_context=context)
    assert result["model"] == "opaque-target"


@pytest.mark.asyncio
async def test_default_and_vertex_continue_existing_getter(monkeypatch):
    calls = []

    async def getter():
        calls.append(True)
        return False

    monkeypatch.setattr(config, "get_return_thoughts_to_frontend", getter)
    request = {"model": "opaque-target", "contents": [{"role": "user", "parts": [{"text": "hello"}]}]}
    default = await normalize_gemini_request(request)
    context = SimpleNamespace(feature_snapshot=FeatureSnapshot(return_thoughts=True))
    vertex = await normalize_gemini_request(request, mode="vertex", route_context=context)
    await normalize_antigravity_request(request)
    assert len(calls) == 3
    assert default["model"] == vertex["model"] == "opaque-target"


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("compatibility", [False, True])
async def test_converter_consumes_one_compatibility_snapshot(monkeypatch, protocol, compatibility):
    async def forbidden():
        raise AssertionError("Compatibility snapshot must not be reread")

    monkeypatch.setattr(config, "get_compatibility_mode_enabled", forbidden)
    context = SimpleNamespace(feature_snapshot=FeatureSnapshot(compatibility_mode=compatibility))
    body = {"model": "opaque-target", "messages": [{"role": "system", "content": "system"},
             {"role": "user", "content": "hello"}], "max_tokens": 20}
    if protocol == "openai":
        from src.converter.openai2gemini import convert_openai_to_gemini_request
        result = await convert_openai_to_gemini_request(body, route_context=context)
    else:
        from src.converter.anthropic2gemini import anthropic_to_gemini_request
        result = await anthropic_to_gemini_request(body, route_context=context)
    assert bool(result.get("systemInstruction")) is not compatibility
