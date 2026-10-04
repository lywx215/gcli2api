"""MR00 shared-contract gate: containers cannot mutate across requests."""

from dataclasses import FrozenInstanceError

import pytest

from src.model_routing.types import (
    CompileResult, FeatureSnapshot, ModelApiProtocol, ParsedRouteTable,
    RequestProjection, RouteRow, RoutingConfigReadError, RoutingConfigSnapshot,
    ValidationIssue, thaw,
)


def test_recursively_frozen_and_defensively_copied():
    source = {"nested": [{"budget": 0, "flag": False}]}
    value = FeatureSnapshot(values=source)
    source["nested"][0]["budget"] = 9
    assert value.values["nested"][0]["budget"] == 0
    with pytest.raises(TypeError):
        value.values["nested"][0]["budget"] = 5
    with pytest.raises(FrozenInstanceError):
        value.return_thoughts = False
    fresh = thaw(value.values)
    fresh["nested"][0]["budget"] = 5
    assert value.values["nested"][0]["budget"] == 0


def test_invalid_rows_keep_scope_and_full_table_indexes():
    issue = ValidationIssue("antigravity", 7, "enabled", "INVALID_FIELD_TYPE")
    parsed = ParsedRouteTable((RouteRow("geminicli", "public-a", "opaque-target", row_index=3),), (issue,))
    assert parsed.valid_rows[0].row_index == 3
    assert parsed.issues[0].row == 7
    assert not parsed.global_error
    assert not CompileResult().valid


def test_missing_value_is_distinct_from_read_failure():
    assert RoutingConfigSnapshot().exists is False
    assert RoutingConfigSnapshot(exists=True, raw_table=None).exists is True
    assert str(RoutingConfigReadError()) == "Model routing configuration is unavailable."


def test_protocol_reuses_existing_enum():
    from src.router.model_api_errors import ModelApiProtocol as ExistingProtocol
    assert ModelApiProtocol is ExistingProtocol
    projection = RequestProjection(ModelApiProtocol.CLAUDE, fields={"x": [0, False]})
    assert projection.fields["x"] == (0, False)
