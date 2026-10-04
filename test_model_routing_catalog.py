"""Projection consumes already filtered catalogs and never calls listing."""

import copy
import pytest
from src.model_routing.compiler import parse_route_table,compile_channel
from src.model_routing.policy import build_policy_snapshot
from src.model_routing.catalog import project_catalog
from src.model_routing.projection import project_request
from src.model_routing.routing import resolve
from src.model_routing.types import FeatureSnapshot


@pytest.fixture(scope="module")
def policy():
    return build_policy_snapshot()


def compiled(policy,channel,rows):
    result=compile_channel(channel,parse_route_table({"routes":[dict(channel=channel,public_name=public,upstream_name=target,enabled=enabled) for public,target,enabled in rows]}),policy)
    assert result.valid,result.issues
    return result.compiled


@pytest.mark.parametrize("channel",["geminicli","antigravity"])
@pytest.mark.parametrize("protocol",["gemini","openai","claude"])
def test_empty_and_disabled_tables_deep_equal_filtered_input(channel,protocol,policy):
    source=[{"id":"legacy","created":0,"details":{"unchanged":False}},{"id":"legacy"}]
    for rows in ([],[("public-alpha","opaque-target",False)]):
        result=project_catalog(channel,protocol,source,compiled(policy,channel,rows),policy,FeatureSnapshot())
        assert result==source and result is not source
        result[0]["details"]["unchanged"]=True
        assert not source[0]["details"]["unchanged"]


@pytest.mark.parametrize("protocol",["gemini","openai","claude"])
def test_cli_hidden_variants_public_description_and_resolver_agree(protocol,policy):
    table=compiled(policy,"geminicli",[("public-alpha","gemini-3.8-flash",True),("public-beta","gemini-3.8-flash",True)])
    source=[{"id":"gemini-3.8-flash-high-search","description":"hidden target"},
            {"id":"假流式/gemini-3.8-flash"},{"id":"legacy","description":"legacy description"}]
    result=project_catalog("geminicli",protocol,source,table,policy,FeatureSnapshot())
    assert result[0]==source[2]
    for item in result[1:]:
        name=item.get("id",item.get("name")).removeprefix("models/")
        assert "gemini-3.8-flash" not in repr(item)
        projection=project_request("geminicli",protocol,name,{},FeatureSnapshot())
        outcome=resolve("geminicli",protocol,name,projection,table,policy,FeatureSnapshot())
        assert outcome.explicit_target and outcome.dispatch_model=="gemini-3.8-flash" and outcome.accepted
    assert len(result)==49


def test_ag_independent_suffix_model_not_hidden_by_base_mapping(policy):
    table=compiled(policy,"antigravity",[("public-alpha","opaque-target",True)])
    source=[{"id":"opaque-target"},{"id":"opaque-target-high"},{"id":"假流式/opaque-target"},{"id":"opaque-target-search"}]
    result=project_catalog("antigravity","openai",source,table,policy,FeatureSnapshot())
    ids=[item["id"] for item in result]
    assert ids[:2]==["opaque-target-high","opaque-target-search"]
    assert "public-alpha-search" not in ids and "public-alpha-high" not in ids


@pytest.mark.parametrize("target",["opaque-target","gemini-3-opaque","gemini-3.8-flash-v2","gemini-2.5-flash-custom"])
def test_unknown_transparent_target_does_not_invent_dynamic_capabilities(policy,target):
    table=compiled(policy,"geminicli",[("public-alpha",target,True)])
    result=project_catalog("geminicli","openai",[],table,policy,FeatureSnapshot())
    assert [item["id"] for item in result]==["public-alpha","假流式/public-alpha","抗截断/public-alpha"]


def test_legacy_nonidentity_redirect_preserved_and_identity_once(policy):
    table=compiled(policy,"antigravity",[("gemini-3.8-flash-high","gemini-3.8-flash-high",True)])
    source=[{"id":"gemini-3.1-pro-high","details":False},{"id":"gemini-3.8-flash-high"}]
    result=project_catalog("antigravity","openai",source,table,policy,FeatureSnapshot())
    assert result[0]==source[0]
    assert sum(item["id"]=="gemini-3.8-flash-high" for item in result)==1


def test_dynamic_changes_do_not_change_compile_or_policy_digest(policy):
    table=compiled(policy,"antigravity",[("public-alpha","opaque-target",True)])
    first=project_catalog("antigravity","openai",[],table,policy,FeatureSnapshot())
    second=project_catalog("antigravity","openai",[{"id":"visible-model"}],table,policy,FeatureSnapshot())
    assert first!=second
    assert table.policy_digest==policy.digest and compiled(policy,"antigravity",[("public-alpha","opaque-target",True)]).config_digest==table.config_digest
