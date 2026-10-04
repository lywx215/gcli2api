"""Strict attribution, target proofs, and unbounded namespace protection."""

import pytest
from src.model_routing.compiler import compile_channel,parse_route_table,validate_table,_cli_closure_equal
from src.model_routing.policy import build_policy_snapshot


@pytest.fixture(scope="module")
def policy():
    return build_policy_snapshot()


def row(public="public-alpha",target="opaque-target",channel="geminicli",enabled=True):
    return dict(channel=channel,public_name=public,upstream_name=target,enabled=enabled)


def compile_rows(rows,policy,channel="geminicli"):
    return compile_channel(channel,parse_route_table({"routes":rows}),policy)


@pytest.mark.parametrize("raw",[None,[],"broken",{}, {"routes":None},{"routes":{},"extra":3}, {"routes":[{}]}, {"routes":[row(channel="vertex")]}])
def test_global_corruption_never_becomes_empty_table(raw,policy):
    parsed=parse_route_table(raw)
    assert parsed.global_error
    assert all(not compile_channel(ch,parsed,policy).valid for ch in ("geminicli","antigravity"))


@pytest.mark.parametrize("invalid",["yes",0,1,None,{},[]])
def test_enabled_requires_exact_json_bool_and_keeps_scope(invalid,policy):
    parsed=parse_route_table({"routes":[row(channel="antigravity",enabled=invalid),row()]})
    assert not parsed.global_error
    assert parsed.issues[0].row==0 and parsed.issues[0].reason=="INVALID_FIELD_TYPE"
    assert compile_channel("geminicli",parsed,policy).valid
    assert not compile_channel("antigravity",parsed,policy).valid
    assert parsed.valid_rows[0].row_index==1


@pytest.mark.parametrize("name",["", "a b","a\t","a\x00","a\x7f","https://example.invalid/x","a/b","a\\b","a*","a?","[a]",".","..","a#b","a%2fb"])
def test_actual_invalid_names(name,policy):
    result=compile_rows([row(public=name)],policy)
    assert any(issue.reason=="INVALID_NAME" for issue in result.issues)


def test_unknown_fields_row_local_and_top_global(policy):
    bad=row(channel="antigravity");bad["secret"]="fixture"
    parsed=parse_route_table({"routes":[bad,row()]})
    assert not parsed.global_error and compile_channel("geminicli",parsed,policy).valid
    assert compile_channel("antigravity",parsed,policy).issues[0].reason=="UNKNOWN_FIELD"
    assert parse_route_table({"routes":[],"secret":"fixture"}).global_error


@pytest.mark.parametrize("target",["opaque-high","gemini-3.8-flash-high","opaque-thinking-low"])
def test_cli_target_stripped_suffix_is_ambiguous_even_when_disabled(target,policy):
    result=compile_rows([row(target=target,enabled=False)],policy)
    assert result.issues[0].reason=="AMBIGUOUS_TARGET_NAME"


@pytest.mark.parametrize("channel,target",[("geminicli","gemini-3.5-flash-preview"),
    ("antigravity","gemini-3.1-pro-high"),("antigravity","gemini-3.8-flash"),
    ("antigravity","gemini-3.1-pro-unknown"),("antigravity","gemini-3.5-flash-unknown"),
    ("antigravity","claude-haiku"),("antigravity","GEMINI-3.8-FLASH-HIGH"),("antigravity","my-image-model")])
def test_actual_unstable_targets(channel,target,policy):
    result=compile_rows([row(channel=channel,target=target)],policy,channel)
    assert any(issue.reason=="UNSTABLE_TARGET_DISPATCH" for issue in result.issues)


@pytest.mark.parametrize("target",["opaque-high","gemini-3.8-flash-high","gemini-3.8-flash-tiered","gemini-pro-agent", "gemini-3-flash",
    "claude-sonnet-4-6","claude-opus-5-5-low","claude-opus-5-5-medium","claude-opus-5-5-high","gemini-3.1-flash-image","gemini-unknown-transparent"])
def test_ag_stable_native_and_transparent_targets(target,policy):
    result=compile_rows([row(channel="antigravity",target=target)],policy,"antigravity")
    assert result.valid,result.issues
    assert not result.compiled.profiles["public-alpha"].capabilities["availability_verified"]


def test_duplicate_names_full_indexes_related_rows_and_cross_channel_allowed(policy):
    result=compile_rows([row(),row(public="ag-name",channel="antigravity"),row(target="other-target")],policy)
    assert [(issue.row,issue.related_rows) for issue in result.issues if issue.reason=="DUPLICATE_PUBLIC_NAME"]==[(2,(0,))]
    assert compile_rows([row(),row(channel="antigravity")],policy).valid


def test_multiple_aliases_one_target_allowed_but_chains_and_cycles_rejected(policy):
    assert compile_rows([row("public-a"),row("public-b")],policy).valid
    for rows in ([row("public-a","public-b"),row("public-b","public-c")],
                 [row("public-a","public-b"),row("public-b","public-a")]):
        result=compile_rows(rows,policy)
        assert any(issue.reason=="PROTECTED_ENTRY_CAPTURE" and issue.related_rows for issue in result.issues)
    assert compile_rows([row("public-a","public-b"),row("public-b","public-c",enabled=False)],policy).valid


@pytest.mark.parametrize("channel,public",[("geminicli","gemini-3.8-flash"),("geminicli","gemini-3-flash"),
    ("antigravity","gemini-3.8-flash-tiered"),("antigravity","chat_23310"),("antigravity","gemini-2.5-pro")])
def test_every_known_static_entry_is_protected_even_if_hidden(channel,public,policy):
    result=compile_rows([row(public,"opaque-target",channel)],policy,channel)
    assert any(issue.reason=="PROTECTED_ENTRY_CAPTURE" for issue in result.issues)


def test_same_name_genuine_identity_and_infinite_closure(policy):
    result=compile_rows([row("gemini-3.8-flash","gemini-3.8-flash")],policy)
    assert result.valid,result.issues
    proof=result.compiled.profiles["gemini-3.8-flash"].proofs["namespace"]
    assert proof["language"]=="T*" and proof["reachable_states"]>10
    equal,states=_cli_closure_equal("opaque-target","opaque-target",policy)
    assert equal and states>10


def test_legacy_alias_finite_rewrite_does_not_prove_infinite_language(policy):
    result=compile_rows([row("gemini-3.5-flash-preview","gemini-3-flash")],policy)
    assert any(issue.reason=="PROTECTED_ENTRY_CAPTURE" for issue in result.issues)


def test_ag_equal_dispatch_unequal_parameter_profile_is_rejected(policy):
    result=compile_rows([row("gemini-3.1-pro-high","gemini-pro-agent","antigravity")],policy,"antigravity")
    assert any(issue.reason=="PROTECTED_ENTRY_CAPTURE" for issue in result.issues)


def test_ag_true_keyword_alias_identity_preserves_final_cleanup_profile(policy):
    result=compile_rows([row("claude-arbitrary-alias","claude-sonnet-4-6","antigravity")],policy,"antigravity")
    assert result.valid,result.issues


@pytest.mark.parametrize("target,capture",[("gemini-3-flash-agent","gemini-3-flash-claude-opus"),
                                         ("claude-sonnet-4-6","claude-sonnet-haiku")])
def test_ag_real_selector_order_cannot_bypass_protected_target_aliases(target,capture,policy):
    result=compile_rows([row("public-alpha",target,"antigravity"),row(capture,"opaque-target","antigravity")],policy,"antigravity")
    assert not result.valid and any(issue.row==1 and issue.reason=="PROTECTED_ENTRY_CAPTURE" for issue in result.issues)


def test_ag_same_final_model_different_converter_schema_is_not_identity(policy):
    result=compile_rows([row("gemini-2.5-flash-claude-haiku","gemini-2.5-flash","antigravity")],policy,"antigravity")
    assert not result.valid and any(issue.reason=="PROTECTED_ENTRY_CAPTURE" for issue in result.issues)


def test_saved_bad_row_cannot_be_dropped_to_make_channel_valid(policy):
    parsed=parse_route_table({"routes":[row(),row(channel="geminicli",enabled=0)]})
    assert not compile_channel("geminicli",parsed,policy).valid
    assert compile_channel("antigravity",parsed,policy).valid
    assert validate_table(parsed,policy)
