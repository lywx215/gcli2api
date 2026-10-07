"""Timing samples cannot carry arbitrary labels or exception contents."""
import pytest
from src import antigravity_panel_metrics as metrics


def test_default_is_one_percent_and_invalid_rate_is_safe(monkeypatch):
    monkeypatch.delenv("ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE", raising=False)
    assert metrics._sample_rate() == .01
    for value in ("NaN", "inf", "-1", "2", "bad"):
        monkeypatch.setenv("ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE", value)
        assert metrics._sample_rate() == .01


def test_logs_only_allowed_data_even_when_exception_contains_secret(monkeypatch):
    output = []
    monkeypatch.setenv("ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE", "1")
    monkeypatch.setattr(metrics.log, "info", output.append)
    with pytest.raises(ValueError):
        with metrics.trace_phase("quota_google", 10):
            raise ValueError("synthetic-private-token")
    assert len(output) == 1
    assert "stage=quota_google outcome=error" in output[0] and "rows=10" in output[0]
    assert "synthetic-private-token" not in output[0] and "ValueError" not in output[0]
    with pytest.raises(ValueError):
        with metrics.trace_phase("synthetic-private-token"):
            pass
    assert len(output) == 1


def test_zero_sampling_is_silent(monkeypatch):
    monkeypatch.setenv("ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE", "0")
    monkeypatch.setattr(metrics.log, "info", lambda _: pytest.fail("unexpected log"))
    with metrics.trace_phase("list_scan", 500):
        pass
