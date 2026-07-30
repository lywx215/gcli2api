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
