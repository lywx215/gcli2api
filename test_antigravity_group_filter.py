"""Pure quota projection: fixed clock, persisted legacy aliases and fail-closed data."""
import copy
import pytest
from src import antigravity_quota as quota
from src.storage.antigravity_quota import _decode

NOW = 2000000000
C, G = 'claude-gpt-shared', 'gemini-shared'


def policy(state='blocked_unknown', revision=1):
    return {'state': state, 'revision': revision}


def test_mixed_aliases_expiry_override_and_unknown_group():
    cooldowns = {'claude-opus-4-6-thinking': NOW + 60,
                 'claude-opus-5-5-high': NOW + 120,
                 'gemini-3-pro-high': NOW, 'independent-model': NOW + 30}
    states = {G: policy(), C: policy('manual_override')}
    before = copy.deepcopy((cooldowns, states))
    result = quota.quota_summary(cooldowns, states, NOW)
    assert result['quota_groups'][C] == {'cooldownUntil': NOW + 120, 'blockedUnknown': False, 'restricted': True}
    assert result['quota_groups'][G] == {'cooldownUntil': 0, 'blockedUnknown': True, 'restricted': True}
    assert result['quota_groups']['independent-model']['restricted']
    assert not result['quota_state_invalid']
    assert (cooldowns, states) == before
    expired = quota.quota_summary(cooldowns, {C: policy('manual_override')}, NOW + 120)
    assert quota.matches_quota_filter(expired, 'all_unrestricted')
    assert expired['quota_groups'][C]['cooldownUntil'] == 0


@pytest.mark.parametrize('cooldowns,states,restricted', [
    ({}, {}, set()),
    ({'claude-opus-4-6': NOW + 1}, {}, {C}),
    ({'gemini-3-flash': NOW + 1}, {}, {G}),
    ({}, {G: policy()}, {G}),
    ({}, {C: policy('manual_override')}, set()),
    ({'unknown-model': NOW + 1}, {}, {'unknown-model'}),
])
def test_six_filters_have_independent_group_semantics(cooldowns, states, restricted):
    result = quota.quota_summary(cooldowns, states, NOW)
    expected = {'any_restricted': bool(restricted), 'all_unrestricted': not restricted,
                'gemini_restricted': G in restricted, 'gemini_unrestricted': G not in restricted,
                'claude_gpt_restricted': C in restricted, 'claude_gpt_unrestricted': C not in restricted}
    assert set(quota.GROUP_FILTERS) == set(expected)
    for name, matches in expected.items():
        assert bool(quota.matches_quota_filter(result, name)) == bool(matches)


@pytest.mark.parametrize('cooldowns,states', [
    ('broken-json', {}), ({}, 'broken-json'), ([], {}), ({}, []),
    ({'gemini-shared': True}, {}), ({'gemini-shared': '2000000001'}, {}),
    ({'gemini-shared': float('nan')}, {}), ({'gemini-shared': float('inf')}, {}),
    ({'gemini-shared': 10**400}, {}),
    ({}, {G: policy(revision=True)}), ({}, {G: policy(revision=0)}),
    ({}, {G: policy(revision='1')}), ({}, {G: policy('normal')}),
    ({}, {'unknown-model': policy(revision=-1)}),
])
def test_invalid_state_matches_admission_validation_and_restricts_both_groups(cooldowns, states):
    with pytest.raises(quota.InvalidQuotaState):
        quota.decode_quota_fields(states, cooldowns)
    with pytest.raises(quota.InvalidQuotaState):
        _decode({'quota_group_states': states, 'model_cooldowns': cooldowns})
    result = quota.quota_summary(cooldowns, states, NOW)
    assert result['quota_state_invalid']
    assert all(result['quota_groups'][group]['restricted'] for group in (C, G))
    assert not quota.matches_quota_filter(result, 'all_unrestricted')


def test_next_expiry_uses_group_max_then_min_across_groups_and_rows():
    cooldowns={'claude-opus-4-6': NOW+10,'claude-opus-5-5-high':NOW+100,G:NOW+80}
    stats=quota.empty_quota_stats()
    assert stats['quota_next_expiry']==0
    quota.count_quota_summary(stats,quota.quota_summary(cooldowns,{},NOW))
    assert stats['quota_next_expiry']==NOW+80
    quota.count_quota_summary(stats,quota.quota_summary({'unknown-model':NOW+60},{},NOW))
    assert stats['quota_next_expiry']==NOW+60
    for now,expected in ((NOW+80,NOW+100),(NOW+100,0)):
        current=quota.empty_quota_stats()
        quota.count_quota_summary(current,quota.quota_summary(cooldowns,{},now))
        assert current['quota_next_expiry']==expected
