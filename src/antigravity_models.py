"""Canonical Antigravity model catalog and compatibility metadata.

The public catalog follows the model slugs exposed by the Antigravity CLI.
The upstream ``fetchAvailableModels`` response contains additional service
models; those remain routable and visible in quota details, but are not
advertised through the public model-list endpoints.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass(frozen=True)
class AntigravityModelMetadata:
    id: str
    display_name: str
    family: str
    tier: str


PUBLIC_ANTIGRAVITY_MODELS: tuple[AntigravityModelMetadata, ...] = (
    AntigravityModelMetadata(
        "gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", "gemini-3.8-flash", "high"
    ),
    AntigravityModelMetadata(
        "gemini-3.8-flash-medium",
        "Gemini 3.8 Flash (Medium)",
        "gemini-3.8-flash",
        "medium",
    ),
    AntigravityModelMetadata(
        "gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)", "gemini-3.8-flash", "low"
    ),
    AntigravityModelMetadata(
        "gemini-3.7-flash-high", "Gemini 3.7 Flash (High)", "gemini-3.7-flash", "high"
    ),
    AntigravityModelMetadata(
        "gemini-3.7-flash-medium",
        "Gemini 3.7 Flash (Medium)",
        "gemini-3.7-flash",
        "medium",
    ),
    AntigravityModelMetadata(
        "gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)", "gemini-3.7-flash", "low"
    ),
    AntigravityModelMetadata(
        "gemini-3.6-flash-high", "Gemini 3.6 Flash (High)", "gemini-3.6-flash", "high"
    ),
    AntigravityModelMetadata(
        "gemini-3.6-flash-medium",
        "Gemini 3.6 Flash (Medium)",
        "gemini-3.6-flash",
        "medium",
    ),
    AntigravityModelMetadata(
        "gemini-3.6-flash-low", "Gemini 3.6 Flash (Low)", "gemini-3.6-flash", "low"
    ),
    AntigravityModelMetadata(
        "gemini-3.1-pro-high", "Gemini 3.1 Pro (High)", "gemini-3.1-pro", "high"
    ),
    AntigravityModelMetadata(
        "gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)", "gemini-3.1-pro", "low"
    ),
    AntigravityModelMetadata(
        "claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", "claude-sonnet-4-6", "thinking"
    ),
    AntigravityModelMetadata(
        "claude-opus-4-6-thinking",
        "Claude Opus 4.6 (Thinking)",
        "claude-opus-4-6",
        "thinking",
    ),
    AntigravityModelMetadata(
        "gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", "gpt-oss-120b", "medium"
    ),
)

PUBLIC_ANTIGRAVITY_MODEL_IDS: tuple[str, ...] = tuple(
    model.id for model in PUBLIC_ANTIGRAVITY_MODELS
)
_PUBLIC_MODEL_BY_ID = {model.id: model for model in PUBLIC_ANTIGRAVITY_MODELS}


# Bare names are compatibility conveniences only. They are accepted by the
# request routers but are deliberately absent from the advertised model list.
ANTIGRAVITY_MODEL_ALIASES = {
    "gemini-3.8-flash": "gemini-3.8-flash-medium",
    "gemini-3.7-flash": "gemini-3.7-flash-medium",
    "gemini-3.6-flash": "gemini-3.6-flash-medium",
    "gemini-3.1-pro": "gemini-3.1-pro-high",
    "gemini-3.5-flash": "gemini-3.5-flash-low",
    "claude-sonnet-4-6-thinking": "claude-sonnet-4-6",
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    "gpt-oss-120b": "gpt-oss-120b-medium",
}


# IDs whose final effort suffix is part of the real upstream model name.
# Legacy and service-only IDs stay here so direct requests remain compatible.
ANTIGRAVITY_NATIVE_MODEL_IDS = frozenset(
    {
        *PUBLIC_ANTIGRAVITY_MODEL_IDS,
        "gemini-3.8-flash-tiered",
        "gemini-3.7-flash-tiered",
        "gemini-3.6-flash-tiered",
        "gemini-3.5-flash-high",
        "gemini-3.5-flash-medium",
        "gemini-3.5-flash-low",
        "gemini-3.5-flash-extra-low",
    }
)


def select_public_model_ids(upstream_model_ids: Iterable[str]) -> list[str]:
    """Return the public/upstream intersection in stable CLI catalog order."""
    available = set(upstream_model_ids)
    return [model_id for model_id in PUBLIC_ANTIGRAVITY_MODEL_IDS if model_id in available]


def get_public_model_metadata(model_id: str) -> Optional[AntigravityModelMetadata]:
    return _PUBLIC_MODEL_BY_ID.get(model_id)


def describe_antigravity_model(model_id: str) -> dict[str, object]:
    """Build safe display metadata for a raw upstream quota model."""
    public_model = get_public_model_metadata(model_id)
    if public_model is not None:
        return {
            "displayName": public_model.display_name,
            "rawModelId": model_id,
            "public": True,
            "family": public_model.family,
            "tier": public_model.tier,
            "testModel": model_id,
        }

    family = model_id
    tier = "internal"
    for suffix in ("-extra-low", "-tiered", "-medium", "-high", "-low", "-thinking"):
        if model_id.endswith(suffix):
            family = model_id[: -len(suffix)]
            tier = suffix[1:]
            break

    return {
        "displayName": model_id,
        "rawModelId": model_id,
        "public": False,
        "family": family,
        "tier": tier,
        "testModel": model_id,
    }
