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


def test_api_address_and_credential_help_are_collapsed_by_default():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        for panel in ("gcli", "antigravity"):
            details = re.search(
                rf'<details(?P<attrs>[^>]*)data-panel-help="{panel}"[^>]*>(?P<body>.*?)</details>',
                html,
                re.DOTALL,
            )
            assert details is not None, f"missing collapsed help for {panel} in {filename}"
            assert " open" not in details.group("attrs")
            assert "API地址（点击复制）" in details.group("body")
            assert "检验功能说明" in details.group("body")


def test_credential_stats_include_compact_cooldown_counts():
    front_dir = Path(__file__).parent / "front"
    expected_ids = (
        "statNoCooldown",
        "statInCooldown",
        "antigravityStatNoCooldown",
        "antigravityStatInCooldown",
    )
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        for element_id in expected_ids:
            assert f'id="{element_id}"' in html
        assert ">未CD</span>" in html
        assert ">CD中</span>" in html

    desktop = (front_dir / "control_panel.html").read_text(encoding="utf-8")
    assert "min-width: 100px" in desktop
    assert "font-size: 24px" in desktop
    mobile = (front_dir / "control_panel_mobile.html").read_text(encoding="utf-8")
    assert "minmax(85px, 1fr)" in mobile
    assert "font-size: 20px" in mobile

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "this.statsData.no_cooldown" in common_js
    assert "this.statsData.in_cooldown" in common_js
    assert """else {
                    this.statsData.normal++;
                    if (Object.keys(credInfo.model_cooldowns || {}).length > 0) {
                        this.statsData.in_cooldown++;
                    } else {
                        this.statsData.no_cooldown++;
                    }
                }""" in common_js


def test_credential_page_size_and_selected_email_copy_are_wired_for_both_panels():
    front_dir = Path(__file__).parent / "front"
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        for select_id in ("pageSizeSelect", "antigravityPageSizeSelect"):
            select = re.search(
                rf'<select[^>]+id="{select_id}"[^>]*>(.*?)</select>',
                html,
                re.DOTALL,
            )
            assert select is not None, f"missing {select_id} in {filename}"
            assert '<option value="25" selected>25</option>' in select.group(1)

        assert 'id="batchCopyEmailsBtn"' in html
        assert 'onclick="copySelectedEmails()"' in html
        assert 'id="antigravityBatchCopyEmailsBtn"' in html
        assert 'onclick="copySelectedAntigravityEmails()"' in html

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "pageSize: 25" in common_js
    assert "emailByFilename: new Map()" in common_js
    assert "this.emailByFilename.get(filename)" in common_js
    assert "navigator.clipboard.writeText(emails.join('\\n'))" in common_js


def test_classified_403_filters_are_wired_for_both_panels():
    front_dir = Path(__file__).parent / "front"
    expected_options = (
        '<option value="403">403（全部）</option>',
        '<option value="403_tos_violation">403（封）</option>',
        '<option value="403_subscription_required">403（赋权）</option>',
        '<option value="403_other">403（其他）</option>',
    )
    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (front_dir / filename).read_text(encoding="utf-8")
        for select_id in ("errorCodeFilter", "antigravityErrorCodeFilter"):
            select = re.search(
                rf'<select[^>]+id="{select_id}"[^>]*>(.*?)</select>',
                html,
                re.DOTALL,
            )
            assert select is not None, f"missing {select_id} in {filename}"
            for option in expected_options:
                assert option in select.group(1)

    common_js = (front_dir / "common.js").read_text(encoding="utf-8")
    assert "error_classifications: item.error_classifications || {}" in common_js
    assert "tos_violation: '403（封）'" in common_js
    assert "subscription_required: '403（赋权）'" in common_js
    assert "other: '403（其他）'" in common_js


def test_panel_header_uses_display_version_without_adding_a_prefix():
    common_js = (Path(__file__).parent / "front" / "common.js").read_text(
        encoding="utf-8"
    )

    assert "const displayVersion = data.display_version || `v${data.version}`;" in common_js
    assert "versionText.textContent = displayVersion;" in common_js
    assert "来源: ${data.source_ref || '未知'}" in common_js
    assert "提交时间: ${data.commit_date || data.date}" in common_js
