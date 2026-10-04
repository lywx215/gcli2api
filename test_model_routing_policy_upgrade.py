"""Source/policy drift is isolated and re-proved instead of using stale caches."""

from dataclasses import replace
from unittest.mock import patch

from src.model_routing.compiler import parse_route_table,compile_channel
from src.model_routing.policy import build_policy_snapshot,digest,_source_digests
from src.model_routing.types import thaw


def table():
    return parse_route_table({"routes":[{"channel":ch,"public_name":"public-alpha","upstream_name":"opaque-target","enabled":True}
                                      for ch in ("geminicli","antigravity")]})


def test_channel_local_alias_upgrade_invalidates_only_affected_target():
    original=build_policy_snapshot(); rules=thaw(original.static_rules)
    rules["ag_aliases"]["opaque-target"]="other-target"
    changed=replace(original,static_rules=rules,digest=digest(rules))
    assert compile_channel("geminicli",table(),changed).valid
    invalid=compile_channel("antigravity",table(),changed)
    assert not invalid.valid and invalid.issues[0].reason=="UNSTABLE_TARGET_DISPATCH"


def test_unknown_operator_or_proof_version_fails_closed():
    original=build_policy_snapshot()
    changed=replace(original,proof_version="unproven-v2")
    assert all(not compile_channel(ch,table(),changed).valid for ch in ("geminicli","antigravity"))


def test_alias_upgrade_inside_suffix_language_requires_new_proof():
    original=build_policy_snapshot();rules=thaw(original.static_rules)
    rules["cli_aliases"]["opaque-target-high"]="other-target"
    changed=replace(original,static_rules=rules,digest=digest(rules))
    assert not compile_channel("geminicli",table(),changed).valid
    assert compile_channel("antigravity",table(),changed).valid


def test_policy_digest_tracks_actual_source_without_executing_source():
    original=build_policy_snapshot()
    from pathlib import Path
    original_read=Path.read_text
    def changed(path,*args,**kwargs):
        source=original_read(path,*args,**kwargs)
        if path.name=="antigravity_fix.py":
            return source.replace('return "think" in model_name.lower()', 'return "new-think-rule" in model_name.lower()')
        return source
    with patch.object(Path,"read_text",changed):
        _source_digests.cache_clear()  # Simulate a new process with new sources.
        try:
            candidate=build_policy_snapshot()
        finally:
            _source_digests.cache_clear()
    assert candidate.digest!=original.digest
    assert compile_channel("geminicli",table(),candidate).valid
    result=compile_channel("antigravity",table(),candidate)
    assert not result.valid and result.issues[0].reason=="AMBIGUOUS_COMPATIBILITY"


def test_no_dynamic_listing_fields_in_policy_and_config_digest_stable():
    policy=build_policy_snapshot()
    assert not any("listing" in key or "credential" in key for key in policy.static_rules)
    assert compile_channel("geminicli",table(),policy).compiled.config_digest==compile_channel("geminicli",table(),policy).compiled.config_digest


def test_missing_proven_source_fingerprint_is_never_implicitly_trusted():
    original=build_policy_snapshot();rules=thaw(original.static_rules)
    del rules["source_digests"]["src/models.py"]
    candidate=replace(original,static_rules=rules,digest=digest(rules))
    assert all(not compile_channel(ch,table(),candidate).valid for ch in ("geminicli","antigravity"))


def test_image_helper_and_static_ratio_changes_also_change_policy_and_fail_proof():
    original=build_policy_snapshot()
    from pathlib import Path
    original_read=Path.read_text
    def changed(path,*args,**kwargs):
        source=original_read(path,*args,**kwargs)
        if path.name=="antigravity_fix.py":
            return source.replace('max_dim <= 1280','max_dim <= 1024')
        return source
    with patch.object(Path,"read_text",changed):
        _source_digests.cache_clear()  # Source upgrade, not per-request reread.
        try:
            candidate=build_policy_snapshot()
        finally:
            _source_digests.cache_clear()
    assert candidate.digest!=original.digest
    assert compile_channel("geminicli",table(),candidate).valid
    assert not compile_channel("antigravity",table(),candidate).valid


def test_empty_channel_does_not_need_a_target_proof_after_source_drift():
    original=build_policy_snapshot();rules=thaw(original.static_rules)
    rules["source_digests"]["src/models.py"]="unreviewed-source"
    candidate=replace(original,static_rules=rules,digest=digest(rules))
    empty=parse_route_table({"routes":[]})
    assert all(compile_channel(ch,empty,candidate).valid for ch in ("geminicli","antigravity"))
    # A disabled target is still a configured target requiring admission.
    disabled=parse_route_table({"routes":[{"channel":"geminicli","public_name":"public-alpha",
                                        "upstream_name":"opaque-target","enabled":False}]})
    assert not compile_channel("geminicli",disabled,candidate).valid
    assert compile_channel("antigravity",disabled,candidate).valid
    # A rejected row must not be silently mistaken for an empty channel.
    invalid=parse_route_table({"routes":[{"channel":"geminicli","public_name":"public-alpha",
                                       "upstream_name":"opaque-target","enabled":"false"}]})
    assert not compile_channel("geminicli",invalid,candidate).valid
    assert compile_channel("antigravity",invalid,candidate).valid
    assert all(not compile_channel(ch,parse_route_table({"routes":[None]}),candidate).valid
               for ch in ("geminicli","antigravity"))


def test_installed_source_ast_is_read_once_per_process():
    from pathlib import Path
    _source_digests.cache_clear()
    original_read=Path.read_text
    reads=[]
    def read(path,*args,**kwargs):
        reads.append(str(path))
        return original_read(path,*args,**kwargs)
    try:
        with patch.object(Path,"read_text",read):
            first=build_policy_snapshot()
            second=build_policy_snapshot()
        assert first==second and len(reads)==len(first.static_rules["source_digests"])==11
    finally:
        _source_digests.cache_clear()
