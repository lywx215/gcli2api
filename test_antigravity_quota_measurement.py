"""Unit coverage for the Antigravity quota benchmark runner."""

from __future__ import annotations

import json

import httpx
import pytest

from scripts.measure_antigravity_quota import (
    MeasurementError,
    adjust_workload,
    aggregate_usage,
    build_native_payload,
    build_summary,
    execute_valid_request,
    output_tokens,
    parse_usage_payload,
    percent_difference,
    render_markdown,
)


def _success_payload(prompt=10_000, candidates=1_700, thoughts=300):
    return {
        "candidates": [
            {
                "finishReason": "STOP",
                "content": {"parts": [{"text": "amber baker calm"}]},
            }
        ],
        "usageMetadata": {
            "promptTokenCount": prompt,
            "cachedContentTokenCount": 0,
            "candidatesTokenCount": candidates,
            "thoughtsTokenCount": thoughts,
            "totalTokenCount": prompt + candidates + thoughts,
        },
    }


def test_native_payload_contains_no_credentials_and_has_generation_controls():
    payload, metadata = build_native_payload(
        filler_words=20, output_words_count=10, salt="fixture-salt"
    )

    serialized = json.dumps(payload)
    assert "fixture-salt" in serialized
    assert "access_token" not in serialized
    assert payload["generationConfig"]["temperature"] == 0
    assert metadata["filler_words"] == 20
    assert metadata["output_words"] == 10
    assert "SOURCE_NOTES_BEGIN" in serialized
    assert "approximately 10 English words" in serialized


def test_usage_parsing_counts_visible_and_reasoning_output():
    usage, finish_reason, digest, visible_chars = parse_usage_payload(_success_payload())

    assert usage["promptTokenCount"] == 10_000
    assert output_tokens(usage) == 2_000
    assert finish_reason == "STOP"
    assert len(digest) == 16
    assert visible_chars > 0


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"error": {"code": 400}},
        {"usageMetadata": {"promptTokenCount": 1}},
        {
            "usageMetadata": {
                "promptTokenCount": 1,
                "candidatesTokenCount": 1,
            },
            "candidates": [],
        },
    ],
)
def test_invalid_http_200_payloads_are_rejected(payload):
    with pytest.raises(MeasurementError):
        parse_usage_payload(payload)


def test_adjustment_and_aggregation_use_actual_usage():
    settings = {"filler_words": 7_000, "output_words": 1_800}
    usage = _success_payload(prompt=8_000, candidates=900, thoughts=100)[
        "usageMetadata"
    ]
    adjusted = adjust_workload(settings, usage)
    assert adjusted["output_words"] == 3_600
    assert adjusted["filler_words"] == 8_750

    records = [{"usage": usage}, {"usage": usage}]
    totals = aggregate_usage(records)
    assert totals["promptTokenCount"] == 16_000
    assert totals["outputTokenCount"] == 2_000
    assert percent_difference(100_000, 101_000) < 2


def test_retryable_responses_wait_and_do_not_become_valid_samples():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) <= 2:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": {}})
        return httpx.Response(200, json=_success_payload())

    attempt_events = []
    waits = []
    with httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://fixture"
    ) as client:
        record = execute_valid_request(
            client,
            api_headers={"Authorization": "Bearer fixture"},
            model="gemini-3.8-flash-high",
            payload={"contents": []},
            label="fixture",
            stage_deadline=10**12,
            attempt_events=attempt_events,
            sleep_fn=waits.append,
        )

    assert record["attempts"] == 3
    assert waits == [10.0, 60.0]
    assert [event["status"] for event in attempt_events] == [429, 429, 200]


def test_non_retryable_error_stops_stage():
    def handler(request):
        return httpx.Response(500, json={"error": {"code": 500}})

    with httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://fixture"
    ) as client:
        with pytest.raises(MeasurementError, match="non-retryable HTTP 500"):
            execute_valid_request(
                client,
                api_headers={},
                model="gemini-3.1-pro-high",
                payload={},
                label="fixture",
                stage_deadline=10**12,
                attempt_events=[],
                sleep_fn=lambda _: None,
            )


def test_workload_adjustment_scales_input_and_output_independently():
    flash_first = {"filler_words": 9_500, "output_words": 800}
    after_first = adjust_workload(
        flash_first,
        {
            "promptTokenCount": 8_952,
            "candidatesTokenCount": 1_846,
            "thoughtsTokenCount": 2_085,
        },
    )
    assert after_first == {"filler_words": 10_612, "output_words": 407}


def test_formal_sample_can_retarget_output_without_changing_matched_input():
    adjusted = adjust_workload(
        {"filler_words": 9_656, "output_words": 242},
        {
            "promptTokenCount": 10_000,
            "candidatesTokenCount": 1_020,
            "thoughtsTokenCount": 0,
        },
    )

    assert adjusted == {"filler_words": 9_656, "output_words": 475}


def test_summary_and_markdown_include_required_quota_metrics():
    def record(prompt, candidates, thoughts):
        return {
            "usage": {
                "promptTokenCount": prompt,
                "cachedContentTokenCount": 0,
                "candidatesTokenCount": candidates,
                "thoughtsTokenCount": thoughts,
                "totalTokenCount": prompt + candidates + thoughts,
            }
        }

    def snapshot(remaining, offset=None):
        value = {"remaining": remaining}
        if offset is not None:
            value["offset_seconds"] = offset
        return value

    report = {
        "started_at": "start",
        "finished_at": "finish",
        "external_traffic_detected": False,
        "comparison_issue": None,
        "attempt_events": [],
        "flash": {
            "calibration": [],
            "formal": [record(10_000, 1_000, 1_000)],
            "supplements": [],
            "quota_baseline": [snapshot(0.9)],
            "quota_after": [snapshot(0.89, 300), snapshot(0.88, 600)],
        },
        "pro": {
            "calibration": [],
            "formal": [record(10_000, 1_000, 1_000)],
            "supplements": [],
            "quota_baseline": [snapshot(0.8)],
            "quota_after": [snapshot(0.78, 300), snapshot(0.76, 600)],
        },
    }

    report["summary"] = build_summary(report)
    summary = report["summary"]
    assert summary["flash_quota"]["before_panel_percent"] == pytest.approx(90)
    assert summary["flash_rates"][
        "t5_percentage_points_per_million_input_tokens"
    ] == pytest.approx(100)
    assert summary["quota_consumption_ratio_pro_to_flash"]["t5"] == pytest.approx(2)

    markdown = render_markdown(report)
    assert "T+5 consumed pp" in markdown
    assert "pp/1M input" in markdown
    assert "Pro/Flash quota-consumption ratio at final sample: 2.000000x" in markdown
