"""Shared, recursively immutable contracts for model routing.

This module deliberately imports no configuration, adapter, or credential code.
Worker modules reuse the existing model API protocol and safe error contracts.
"""

from dataclasses import dataclass, field, fields
from enum import Enum
from types import MappingProxyType
from typing import Any, Literal, Mapping

from src.router.model_api_errors import ModelApiProtocol

Channel = Literal["geminicli", "antigravity"]
CHANNELS: tuple[Channel, ...] = ("geminicli", "antigravity")
CONTRACT_VERSION = "routing-execution-1"


def freeze(value: Any) -> Any:
    """Defensively copy JSON containers into recursively immutable values."""
    if isinstance(value, Mapping):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(freeze(item) for item in value)
    return value


def thaw(value: Any) -> Any:
    """Return new JSON-compatible containers; never expose shared mutation."""
    if isinstance(value, Mapping):
        return {key: thaw(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [thaw(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [thaw(item) for item in sorted(value, key=repr)]
    if isinstance(value, Enum):
        return value.value
    return value


class ImmutableContract:
    def __post_init__(self) -> None:
        for item in fields(self):
            object.__setattr__(self, item.name, freeze(getattr(self, item.name)))


@dataclass(frozen=True)
class RouteRow(ImmutableContract):
    channel: Channel
    public_name: str
    upstream_name: str
    enabled: bool = True
    row_index: int = 0


@dataclass(frozen=True)
class ValidationIssue(ImmutableContract):
    channel: Channel | None
    row: int | None
    field: str | None
    reason: str
    related_rows: tuple[int, ...] = ()
    message: str = "Invalid model routing configuration."


@dataclass(frozen=True)
class ParsedRouteTable(ImmutableContract):
    valid_rows: tuple[RouteRow, ...] = ()
    issues: tuple[ValidationIssue, ...] = ()
    global_error: bool = False


@dataclass(frozen=True)
class RequestProjection(ImmutableContract):
    protocol: ModelApiProtocol
    fields: Mapping[str, Any] = field(default_factory=dict)
    tools: Mapping[str, Any] = field(default_factory=dict)
    image_context: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FeatureSnapshot(ImmutableContract):
    compatibility_mode: bool = False
    return_thoughts: bool = True
    antigravity_stream2nostream: bool = False
    values: Mapping[str, Any] = field(default_factory=dict)
    antigravity_flash_non_stream_mode: str = "inherit"


@dataclass(frozen=True)
class RoutingPolicySnapshot(ImmutableContract):
    version: str
    digest: str
    chains: Mapping[str, Any] = field(default_factory=dict)
    static_rules: Mapping[str, Any] = field(default_factory=dict)
    parameter_classes: tuple[Any, ...] = ()
    proof_version: str = "routing-proof-1"


@dataclass(frozen=True)
class TargetProfile(ImmutableContract):
    target: str
    parameter_actions: Mapping[str, Any] = field(default_factory=dict)
    proofs: Mapping[str, Any] = field(default_factory=dict)
    capabilities: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CompiledChannel(ImmutableContract):
    channel: Channel
    config_digest: str
    policy_digest: str
    rows: tuple[RouteRow, ...] = ()
    profiles: Mapping[str, TargetProfile] = field(default_factory=dict)
    public_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CompileResult(ImmutableContract):
    compiled: CompiledChannel | None = None
    issues: tuple[ValidationIssue, ...] = ()
    scope: Literal["channel", "global"] = "channel"

    @property
    def valid(self) -> bool:
        return self.compiled is not None and not self.issues


@dataclass(frozen=True)
class ResolutionOutcome(ImmutableContract):
    requested_model: str
    dispatch_model: str
    public_base: str
    features: Mapping[str, Any] = field(default_factory=dict)
    explicit_target: bool = False
    target_profile: TargetProfile | None = None
    accepted: bool = True
    error: Any = None


@dataclass(frozen=True)
class ModelRouteContext(ImmutableContract):
    channel: Channel
    protocol: ModelApiProtocol
    requested_model: str
    request_projection: RequestProjection
    feature_snapshot: FeatureSnapshot
    resolution: ResolutionOutcome
    config_digest: str
    policy_digest: str


@dataclass(frozen=True)
class RoutingConfigSnapshot(ImmutableContract):
    exists: bool = False
    raw_table: Any = None
    digest: str = ""
    channels: Mapping[str, CompileResult] = field(default_factory=dict)


class RoutingConfigReadError(RuntimeError):
    """Authoritative configuration unavailable; contains no backend details."""

    def __init__(self) -> None:
        super().__init__("Model routing configuration is unavailable.")
