import json

from src.storage._stats_common import has_active_model_cooldown


def test_active_cooldown_detection_accepts_persisted_and_parsed_values():
    assert has_active_model_cooldown({"gemini-pro": 200}, current_time=100)
    assert has_active_model_cooldown(
        json.dumps({"gemini-pro": 200}), current_time=100
    )
    assert not has_active_model_cooldown({"gemini-pro": 100}, current_time=100)


def test_active_cooldown_detection_treats_invalid_history_as_not_in_cooldown():
    for value in (None, "", "not-json", [], {"gemini-pro": "200"}, {"x": True}):
        assert not has_active_model_cooldown(value, current_time=100)
