import re
from pathlib import Path


def test_stats_refresh_timer_has_a_real_declaration():
    common_js = (Path(__file__).parent / "front" / "common.js").read_text(encoding="utf-8")

    assert re.search(r"^let _statsAutoRefreshTimer = null;$", common_js, re.MULTILINE)
    assert r"\nlet _statsAutoRefreshTimer" not in common_js


def test_control_panels_do_not_contain_duplicate_ids():
    front_dir = Path(__file__).parent / "front"

    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        ids = re.findall(r'\bid="([^"]+)"', html)
        assert len(ids) == len(set(ids)), f"duplicate id in {filename}"


def test_stream_diagnostics_control_exists_on_both_panels():
    front_dir = Path(__file__).parent / "front"

    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        assert html.count('id="streamDiagnosticsEnabled"') == 1
        assert html.count('id="streamDiagnosticsEnabledEnvLock"') == 1
        assert "流式 TTFT 诊断" in html


def test_stream_diagnostics_common_script_loads_saves_and_locks():
    common_js = (Path(__file__).parent / "front" / "common.js").read_text(
        encoding="utf-8"
    )

    assert "function setConfigCheckbox(fieldId, configKey, value)" in common_js
    assert "AppState.envLockedFields.has(configKey)" in common_js
    assert "c.stream_diagnostics_enabled" in common_js
    assert "stream_diagnostics_enabled: getChecked('streamDiagnosticsEnabled')" in common_js


def test_capacity_fast_fail_control_exists_and_uses_common_locking():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        assert html.count('id="geminicliCapacityFastFailEnabled"') == 1
        assert html.count('id="geminicliCapacityFastFailEnabledEnvLock"') == 1
        assert "GeminiCLI 模型容量快速失败" in html

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "c.geminicli_capacity_fast_fail_enabled" in common_js
    assert (
        "geminicli_capacity_fast_fail_enabled: "
        "getChecked('geminicliCapacityFastFailEnabled')"
    ) in common_js


def test_stream_header_hedge_control_exists_and_uses_common_locking():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        assert html.count('id="geminicliStreamHeaderHedgeEnabled"') == 1
        assert html.count('id="geminicliStreamHeaderHedgeEnabledEnvLock"') == 1
        assert "GeminiCLI 流式响应头对冲" in html

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "c.geminicli_stream_header_hedge_enabled" in common_js
    assert (
        "geminicli_stream_header_hedge_enabled: "
        "getChecked('geminicliStreamHeaderHedgeEnabled')"
    ) in common_js


def test_hedge_cost_controls_and_card_exist_on_both_panels():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        assert html.count('id="geminicliStreamHeaderHedgeSampleRate"') == 1
        assert html.count('id="geminicliStreamHeaderHedgeDailyBudget"') == 1
        assert html.count('id="hedgeStatsCard"') == 1
        assert "今日对冲成本" in html
        assert "预计" in html

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "async function refreshHedgeStats()" in common_js
    assert "./creds/hedge-stats?days=7" in common_js
    assert "geminicli_stream_header_hedge_sample_rate:" in common_js
    assert "geminicli_stream_header_hedge_daily_budget:" in common_js


def test_stream_latency_advanced_controls_exist_on_both_panels():
    front_dir = Path(__file__).parent / "front"
    required_ids = (
        "streamLatencyGuardEnabled",
        "upstreamResponseHeaderTimeout",
        "upstreamFirstEventTimeout",
        "streamFirstContentTimeout",
        "upstreamStreamIdleTimeout",
        "streamTransportMaxAttempts",
        "nonstreamTransportMaxAttempts",
        "streamPerfLogSampleRate",
        "upstreamHttp2Enabled",
        "upstreamHttp2ClientMaxAge",
        "geminicliStreamHeaderHedgeDelay",
        "geminicliStreamHeaderHedgeMaxInflight",
    )
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        for field_id in required_ids:
            assert html.count(f'id="{field_id}"') == 1
        assert "流式首字延迟保护（全部渠道）" in html
        assert "额外状态码重试次数" in html

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "function updateStreamLatencyUiState()" in common_js
    assert "stream_latency_guard_enabled:" in common_js
    assert "upstream_response_header_timeout:" in common_js
    assert "upstream_http2_enabled:" in common_js
