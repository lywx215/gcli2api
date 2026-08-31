import re
from pathlib import Path

import config


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


def test_quota_fallback_cooldown_field_is_wired_for_both_panels():
    front_dir = Path(__file__).parent / "front"

    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        field = re.search(
            r'<input[^>]+id="quotaFallbackCooldownMinutes"[^>]*>', html
        )
        assert field is not None, f"missing quota fallback field in {filename}"
        assert 'min="1"' in field.group(0)
        assert 'max="1440"' in field.group(0)
        assert 'value="30"' in field.group(0)

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "c.quota_fallback_cooldown_minutes || 30" in common_js
    assert "quota_fallback_cooldown_minutes: getInt('quotaFallbackCooldownMinutes', 30)" in common_js
    assert config.ENV_MAPPINGS["QUOTA_FALLBACK_COOLDOWN_MINUTES"] == (
        "quota_fallback_cooldown_minutes"
    )


def test_management_security_fields_are_wired_for_both_panels():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        assert 'id="nodeManagementToken"' in html
        assert 'type="password"' in html
        assert 'id="gcliEmbedMode"' in html
        assert 'id="gcliEmbedPolicyStatus"' in html
        assert 'value="any_https"' in html
        assert 'id="gcliEmbedAllowedOrigins"' in html

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "window.crypto.getRandomValues(bytes)" in common_js
    assert "method: 'PUT'" in common_js
    assert "method: 'DELETE'" in common_js
    assert config.ENV_MAPPINGS["GCLI_EMBED_ALLOWED_ORIGINS"] == (
        "gcli_embed_allowed_origins"
    )


def test_project_info_and_system_status_are_not_navigation_items():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        assert 'data-tab="about"' not in html
        assert '>项目信息</button>' not in html
        assert 'data-tab="status"' not in html
        assert '>系统状态</button>' not in html
