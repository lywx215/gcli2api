"""Differential checks against real converters and legacy normalizers."""

import copy
import itertools
import socket
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from src.router.model_api_errors import ModelApiErrorException

from src.converter.gemini_fix import normalize_gemini_request
from src.converter.antigravity_fix import normalize_antigravity_request
from src.converter.openai2gemini import convert_openai_to_gemini_request
from src.converter.anthropic2gemini import anthropic_to_gemini_request
from src.utils import get_base_model_from_feature_model, normalize_geminicli_model_alias, normalize_antigravity_model_alias
from src.model_routing.compiler import compile_channel,parse_route_table
from src.model_routing.policy import build_policy_snapshot, CLI_BASES
from src.model_routing.projection import project_request
from src.model_routing.routing import resolve
from src.model_routing.types import FeatureSnapshot, ModelApiProtocol, ModelRouteContext, thaw


@pytest.fixture(scope="module")
def policy():
    return build_policy_snapshot()


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setattr("config.get_return_thoughts_to_frontend",AsyncMock(return_value=True))
    monkeypatch.setattr("config.get_compatibility_mode_enabled",AsyncMock(return_value=False))
    original_connect=socket.socket.connect
    original_create=socket.create_connection
    def connect(sock,address):
        if isinstance(address,tuple) and address[0] in ("127.0.0.1","::1"):
            # Windows asyncio constructs its self-pipe with loopback socketpair.
            return original_connect(sock,address)
        raise AssertionError("External calls are forbidden in routing tests.")
    def create(address,*args,**kwargs):
        if isinstance(address,tuple) and address[0] in ("127.0.0.1","::1"):
            return original_create(address,*args,**kwargs)
        raise AssertionError("External calls are forbidden in routing tests.")
    monkeypatch.setattr(socket.socket,"connect",connect)
    monkeypatch.setattr(socket,"create_connection",create)


def raw(protocol, params):
    if protocol=="gemini":
        return {"contents":[{"role":"user","parts":[{"text":"Synthetic request"}]}],"generationConfig":params}
    source={"messages":[{"role":"user","content":"Synthetic request"}]}
    if protocol=="openai":
        source["n"]=1
        source.update(params)
    else:
        source["max_tokens"]=64
        source.update(params)
    return source


async def legacy(channel,protocol,name,payload):
    name=get_base_model_from_feature_model(name)
    name=normalize_geminicli_model_alias(name) if channel=="geminicli" else normalize_antigravity_model_alias(name)
    payload=copy.deepcopy(payload)
    payload["model"]=name
    if protocol=="openai":
        payload=await convert_openai_to_gemini_request(payload)
    elif protocol=="claude":
        payload=await anthropic_to_gemini_request(payload)
    payload["model"]=name
    return await (normalize_gemini_request(payload) if channel=="geminicli" else normalize_antigravity_request(payload))


CLI_NAMES=tuple(CLI_BASES)+("gemini-3-flash","opaque-target","PRO-opaque","gemini-3.5-flash-preview-high", "gemini-3.5-flash-preview-high-low-search",
    "gemini-3.8-flash-high-search","gemini-3.8-flash-medium-low", "gemini-3.8-flash-nothinking-high",
    "gemini-2.5-pro-low-max-maxthinking", "假流式/gemini-3.8-flash-low", "流式抗截断/opaque-target")
AG_NAMES=("gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.1-pro-high", "gemini-pro-agent", "gemini-3.5-flash", "gemini-3.5-flash-minimal",
    "gemini-3-flash", "gemini-3-flash-preview", "claude-haiku-opaque", "claude-opus-4-6",
    "claude-opus-5-5", "claude-opus-5-5-thinking", "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high",
    "claude-sonnet-4-6-thinking", "gpt-oss-120b",
    "opaque-high", "public-alpha-search", "假流式/claude-sonnet-4-6", "gemini-3.1-pro-weird", "gemini-3.5-flash-weird",
    "gemini-3.1-flash-image", "custom-image-4k-16x9", "gemini-3-flash-claude-opus", "claude-sonnet-haiku")


@pytest.mark.parametrize("channel,names",[("geminicli",CLI_NAMES),("antigravity",AG_NAMES)])
@pytest.mark.parametrize("protocol",["gemini","openai","claude"])
async def test_empty_table_and_unmatched_differential(channel,names,protocol,policy):
    empty=compile_channel(channel,parse_route_table({"routes":[]}),policy).compiled
    if protocol=="gemini":
        inputs=[{}, {"temperature":.3}, {"thinkingConfig":{"thinkingBudget":0}},
                {"thinkingConfig":{"thinkingBudget":12000,"thinkingLevel":"low","includeThoughts":False}},
                {"thinkingConfig":{"thinkingLevel":"HIGH"}},{"thinkingConfig":{"thinkingLevel":"nonsense"}},
                {"thinkingConfig":None},{"thinkingConfig":[]},{"thinkingConfig":{"thinkingBudget":False}}]
    else:
        inputs=[{}, {"max_completion_tokens":0,"max_tokens":13}, {"temperature":.2,"top_p":.8},
                {"thinking":{"type":"enabled","budget_tokens":0}}, {"thinking":{"type":"enabled"}},
                {"thinking":{"type":"disabled"}}, {"stop_sequences":["stop"]},
                {"response_format":{"type":"json_schema"}}, {"response_format":{"type":"json_schema","json_schema":[]}}]
    for name,params in itertools.product(names,inputs):
        payload=raw(protocol,params)
        result=resolve(channel,protocol,name,project_request(channel,protocol,name,payload,FeatureSnapshot()),empty,policy,FeatureSnapshot())
        try:
            expected=await legacy(channel,protocol,name,payload)
        except ModelApiErrorException as exc:
            assert not result.accepted and result.error.status==exc.error.status, (name,params)
        except HTTPException as exc:
            assert not result.accepted and result.error.status==exc.status_code, (name,params)
        except (AttributeError,TypeError,ValueError,OverflowError):
            assert not result.accepted and result.error.status==500, (name,params)
        else:
            assert result.accepted,(name,params,result.error)
            assert result.dispatch_model==expected["model"],(name,params)
            assert thaw(result.features["generation_config"])==expected.get("generationConfig",{}),(name,params,result.features)


def configured(channel,target,policy,public="public-alpha"):
    result=compile_channel(channel,parse_route_table({"routes":[{"channel":channel,"public_name":public,"upstream_name":target,"enabled":True}]}),policy)
    assert result.valid,result.issues
    return result.compiled


@pytest.mark.parametrize("protocol",["gemini","openai","claude"])
async def test_explicit_target_uses_target_family_and_full_request_identity(protocol,policy):
    channel="geminicli"
    table=configured(channel,"gemini-3.8-flash",policy)
    name="假流式/public-alpha-high-search"
    payload=raw(protocol,{"temperature":.2})
    out=resolve(channel,protocol,name,project_request(channel,protocol,name,payload,FeatureSnapshot()),table,policy,FeatureSnapshot())
    assert out.requested_model==name and out.dispatch_model=="gemini-3.8-flash"
    assert out.features["normalizer_input_model"]=="gemini-3.8-flash-high-search"
    expected=await legacy(channel,protocol,"gemini-3.8-flash-high-search",payload)
    assert thaw(out.features["generation_config"])==expected.get("generationConfig",{})
    assert out.features["add_google_search"] and out.features["fake_streaming"]


def test_ag_matches_only_opaque_whole_name_and_never_derives_search(policy):
    table=configured("antigravity","gemini-3.8-flash-high",policy)
    for name,matched in (("public-alpha",True),("public-alpha-search",False),("public-alpha-high",False)):
        payload=raw("gemini",{})
        out=resolve("antigravity","gemini",name,project_request("antigravity","gemini",name,payload,FeatureSnapshot()),table,policy,FeatureSnapshot())
        assert out.explicit_target is matched
        assert not out.features["add_google_search"]


def test_public_name_keywords_do_not_control_profile(policy):
    table=configured("geminicli","opaque-target",policy,public="show-searchable-pro-thinker")
    name="show-searchable-pro-thinker"
    out=resolve("geminicli","gemini",name,project_request("geminicli","gemini",name,raw("gemini",{}),FeatureSnapshot()),table,policy,FeatureSnapshot())
    assert not out.features["add_google_search"]
    assert not out.features["generation_config"]


@pytest.mark.parametrize("return_thoughts",[False,True])
def test_feature_snapshots_do_not_mutate_or_read_globals(return_thoughts,policy):
    table=configured("geminicli","gemini-2.5-pro",policy)
    features=FeatureSnapshot(return_thoughts=return_thoughts)
    projection=project_request("geminicli","gemini","public-alpha",raw("gemini",{}),features)
    out=resolve("geminicli","gemini","public-alpha",projection,table,policy,features)
    assert out.features["generation_config"]["thinkingConfig"]["includeThoughts"] is return_thoughts


@pytest.mark.parametrize("channel,target",[("geminicli","gemini-2.5-pro"),("antigravity","gemini-3.8-flash-high")])
@pytest.mark.parametrize("protocol",["gemini","openai","claude"])
@pytest.mark.parametrize("compatibility",[False,True])
async def test_reviewed_candidate_consumes_one_snapshot_without_config_reads(channel,target,protocol,compatibility,policy,monkeypatch):
    table=configured(channel,target,policy)
    features=FeatureSnapshot(compatibility_mode=compatibility,return_thoughts=False)
    payload=raw(protocol,{})
    if protocol!="gemini":
        payload["messages"].insert(0,{"role":"system","content":"Synthetic system request"})
    projection=project_request(channel,protocol,"public-alpha",payload,features)
    out=resolve(channel,protocol,"public-alpha",projection,table,policy,features)
    context=ModelRouteContext(channel,ModelApiProtocol(protocol),"public-alpha",projection,features,out,table.config_digest,policy.digest)
    reads=AsyncMock(side_effect=AssertionError("Candidate must use its captured feature snapshot."))
    monkeypatch.setattr("config.get_return_thoughts_to_frontend",reads)
    monkeypatch.setattr("config.get_compatibility_mode_enabled",reads)
    prepared=copy.deepcopy(payload); prepared["model"]=out.features["normalizer_input_model"]
    if protocol=="openai":
        prepared=await convert_openai_to_gemini_request(prepared,route_context=context)
    elif protocol=="claude":
        prepared=await anthropic_to_gemini_request(prepared,route_context=context)
    prepared["model"]=out.features["normalizer_input_model"]
    normalized=await (normalize_gemini_request(prepared,route_context=context) if channel=="geminicli" else normalize_antigravity_request(prepared,route_context=context))
    assert normalized["model"]==target
    assert normalized["generationConfig"]["thinkingConfig"]["includeThoughts"] is False
    if protocol!="gemini":
        assert ("systemInstruction" in normalized) is not compatibility
    assert not reads.await_count


@pytest.mark.parametrize("size",["1024x1536","2560*1440","4096X4096","bad-size",0,False,None,17])
async def test_image_size_profile_and_invalid_types_follow_real_normalizer(size,policy):
    table=configured("antigravity","gemini-3.1-flash-image",policy)
    payload=raw("gemini",{}); payload["size"]=size
    projection=project_request("antigravity","gemini","public-alpha",payload,FeatureSnapshot())
    result=resolve("antigravity","gemini","public-alpha",projection,table,policy,FeatureSnapshot())
    try:
        expected=await legacy("antigravity","gemini","gemini-3.1-flash-image",payload)
    except (AttributeError,TypeError,ValueError,OverflowError):
        assert not result.accepted and result.error.status==500
    else:
        assert result.accepted
        assert thaw(result.features["generation_config"])==expected["generationConfig"]
