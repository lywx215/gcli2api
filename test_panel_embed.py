from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.embed_policy import (
    EMBED_ALLOWED_ORIGINS_ENV,
    frame_ancestors_policy,
    parse_embed_allowed_origins,
)
from src.panel.root import router


@pytest.mark.parametrize(
    "value",
    (
        "http://manager.example.com",
        "https://manager.example.com/",
        "https://manager.example.com/path",
        "https://manager.example.com?query=yes",
        "https://manager.example.com#fragment",
        "https://user@manager.example.com",
        "https://*.example.com",
        "https://MANAGER.example.com",
        "https://manager.example.com:443",
        "https://manager.example.com,",
        " https://manager.example.com",
        "https://manager.example.com,https://manager.example.com",
    ),
)
def test_embed_origin_parser_rejects_noncanonical_configuration(value: str) -> None:
    parsed = parse_embed_allowed_origins(value)

    assert parsed.valid is False
    assert parsed.enabled is False
    assert parsed.origins == ()
    assert frame_ancestors_policy(parsed) == "frame-ancestors 'none'"


def test_embed_origin_parser_accepts_only_exact_https_origins() -> None:
    parsed = parse_embed_allowed_origins(
        "https://manager.example.com,https://console.example.net:8443"
    )

    assert parsed.valid is True
    assert parsed.enabled is True
    assert parsed.origins == (
        "https://manager.example.com",
        "https://console.example.net:8443",
    )
    assert frame_ancestors_policy(parsed) == (
        "frame-ancestors https://manager.example.com "
        "https://console.example.net:8443"
    )


def _panel_client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_panel_response_uses_exact_http_csp_and_no_x_frame_options(monkeypatch) -> None:
    monkeypatch.setenv(
        EMBED_ALLOWED_ORIGINS_ENV,
        "https://manager.example.com,https://console.example.net:8443",
    )

    response = _panel_client().get("/", headers={"user-agent": "desktop-test"})

    assert response.status_code == 200
    assert response.headers["content-security-policy"] == (
        "frame-ancestors https://manager.example.com "
        "https://console.example.net:8443"
    )
    assert "x-frame-options" not in response.headers
    assert "fixture-management-token" not in response.text
    match = re.search(
        r'<meta name="gcli-embed-allowed-origins" content="([^"]+)">',
        response.text,
    )
    assert match is not None
    assert json.loads(
        match.group(1).replace("&quot;", '"')
    ) == ["https://manager.example.com", "https://console.example.net:8443"]


@pytest.mark.parametrize(
    "value",
    (None, "", "http://manager.example.com", "https://manager.example.com/path"),
)
def test_panel_response_denies_all_ancestors_when_embedding_is_unavailable(
    monkeypatch, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv(EMBED_ALLOWED_ORIGINS_ENV, raising=False)
    else:
        monkeypatch.setenv(EMBED_ALLOWED_ORIGINS_ENV, value)

    response = _panel_client().get("/")

    assert response.status_code == 200
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"
    assert "x-frame-options" not in response.headers
    assert 'content="[]"' in response.text


def test_manage_hash_contract_covers_login_refresh_fallback_and_safe_ready_message() -> None:
    root = Path(__file__).parent
    common_js = (root / "front" / "common.js").read_text(encoding="utf-8")

    assert "const PANEL_DEFAULT_TAB = 'oauth';" in common_js
    assert "'manage'," in common_js
    assert "PANEL_TAB_HASHES.has(requested)" in common_js
    assert common_js.count("activateRequestedPanelTab();") >= 2
    assert "function switchTab(tabName, eventOrTarget = null)" in common_js
    assert "event && event.target ? event.target" not in common_js
    assert "syncPanelHash(safeTabName);" in common_js
    assert "!AppState.authToken" in common_js

    ready_payload = re.search(
        r"window\.parent\.postMessage\(\s*"
        r"\{ type: 'gcli2api\.console\.ready', version: 1, tab: 'manage' \},\s*"
        r"parentOrigin\s*\)",
        common_js,
    )
    assert ready_payload is not None
    for forbidden in (
        "access_token",
        "refresh_token",
        "client_secret",
        "panel_password",
        "management_token",
    ):
        assert forbidden not in ready_payload.group(0).lower()

    for filename in ("control_panel.html", "control_panel_mobile.html"):
        html = (root / "front" / filename).read_text(encoding="utf-8")
        assert 'data-tab="manage" onclick="switchTab(\'manage\', this)"' in html
        assert "__GCLI_EMBED_ALLOWED_ORIGINS__" in html
