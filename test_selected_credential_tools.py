import io
import json
import zipfile

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.models import CredFilenameListRequest
from src.panel import creds as creds_panel


class _PanelStorage:
    def __init__(self):
        self.credentials = {
            "alpha.json": {"access_token": "synthetic-alpha"},
            "beta.json": {"access_token": "synthetic-beta"},
            "no-email.json": {"access_token": "synthetic-none"},
        }
        self.states = {
            "alpha.json": {"user_email": "alpha@example.test"},
            "beta.json": {"user_email": "ALPHA@example.test"},
            "no-email.json": {},
        }

    async def get_credential(self, filename, mode="geminicli"):
        return self.credentials.get(filename)

    async def list_credentials(self, mode="geminicli"):
        return list(self.credentials)

    async def get_credential_state(self, filename, mode="geminicli"):
        return self.states.get(filename, {})


def test_selected_credential_request_bounds_and_safe_basenames():
    with pytest.raises(ValidationError):
        CredFilenameListRequest(filenames=[])
    with pytest.raises(ValidationError):
        CredFilenameListRequest(filenames=[f"item-{index}.json" for index in range(101)])

    assert creds_panel._normalize_selected_credential_filenames(
        ["alpha.json", "alpha.json", "beta.json"]
    ) == ["alpha.json", "beta.json"]
    for unsafe in (
        "../alpha.json",
        "..\\alpha.json",
        "/alpha.json",
        "alpha.txt",
        "alpha.json\r\nX-Leak: yes",
    ):
        with pytest.raises(HTTPException) as exc_info:
            creds_panel._normalize_selected_credential_filenames([unsafe])
        assert exc_info.value.status_code == 400


@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_selected_download_zip_and_count_only_headers(monkeypatch, mode):
    storage = _PanelStorage()

    async def fake_storage():
        return storage

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_storage)
    response = await creds_panel.download_selected_creds_common(
        ["alpha.json", "missing.json", "alpha.json"], mode=mode
    )

    assert response.headers["x-selected-count"] == "1"
    assert response.headers["x-missing-count"] == "1"
    assert "alpha.json" not in str(response.headers)
    assert "synthetic-alpha" not in str(response.headers)
    with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
        assert archive.namelist() == ["alpha.json"]
        assert json.loads(archive.read("alpha.json")) == storage.credentials["alpha.json"]


async def test_selected_download_returns_404_when_all_items_are_missing(monkeypatch):
    async def fake_storage():
        return _PanelStorage()

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_storage)
    with pytest.raises(HTTPException) as exc_info:
        await creds_panel.download_selected_creds_common(["missing.json"])
    assert exc_info.value.status_code == 404


async def test_copy_emails_is_deduplicated_and_reports_bounded_missing(monkeypatch):
    storage = _PanelStorage()

    async def fake_storage():
        return storage

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_storage)
    response = await creds_panel.copy_selected_emails_common(
        ["alpha.json", "beta.json", "no-email.json", "missing.json"],
        mode="antigravity",
    )
    payload = json.loads(response.body)

    assert payload == {
        "emails": ["alpha@example.test"],
        "matched_count": 2,
        "missing_count": 2,
        "requested_count": 4,
        "missing": [
            {"filename": "no-email.json", "reason": "email_unavailable"},
            {"filename": "missing.json", "reason": "not_found"},
        ],
    }
    capped_response = await creds_panel.copy_selected_emails_common(
        [f"missing-{index}.json" for index in range(60)]
    )
    capped_payload = json.loads(capped_response.body)
    assert capped_payload["missing_count"] == 60
    assert len(capped_payload["missing"]) == 50


def test_selected_credential_routes_require_panel_authentication():
    app = FastAPI()
    app.include_router(creds_panel.router)
    with TestClient(app) as client:
        for path in ("/creds/download-selected", "/creds/copy-emails"):
            response = client.post(path, json={"filenames": ["alpha.json"]})
            assert response.status_code in {401, 403}


class _ImportedCredentials:
    access_token = "synthetic-access"


class _ImportedCredentialsFactory:
    @staticmethod
    def from_dict(data):
        return _ImportedCredentials()


@pytest.mark.parametrize("tier", ["free", "pro"])
async def test_antigravity_refresh_import_persists_detected_tier(
    monkeypatch, tier
):
    calls = {"added": [], "updated": []}

    async def fake_exchange(**kwargs):
        return {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}

    async def fake_endpoint():
        return "https://antigravity.invalid"

    async def fake_detect(**kwargs):
        return "shared-project", tier

    async def fake_add(filename, data):
        calls["added"].append((filename, dict(data)))

    async def fake_update(filename, state, mode="geminicli"):
        calls["updated"].append((filename, dict(state), mode))
        return True

    monkeypatch.setattr(creds_panel, "_exchange_refresh_token_to_credential", fake_exchange)
    monkeypatch.setattr(creds_panel, "get_antigravity_api_url", fake_endpoint)
    monkeypatch.setattr(creds_panel, "fetch_project_id_and_tier", fake_detect)
    monkeypatch.setattr(creds_panel, "Credentials", _ImportedCredentialsFactory)
    monkeypatch.setattr(
        creds_panel.credential_manager, "add_antigravity_credential", fake_add
    )
    monkeypatch.setattr(
        creds_panel.credential_manager, "update_credential_state", fake_update
    )

    result = await creds_panel._add_credential_by_refresh_token(
        refresh_token="synthetic-refresh",
        client_id="synthetic-client",
        client_secret="synthetic-secret",
        project_id=None,
        custom_filename=None,
        mode="antigravity",
    )

    assert result["subscription_tier"] == tier
    assert result["filename"].startswith("refresh-")
    assert "shared-project" not in result["filename"]
    assert "synthetic-refresh" not in result["filename"]
    assert calls["updated"] == [(result["filename"], {"tier": tier}, "antigravity")]


def test_refresh_import_auto_filenames_are_unique_and_custom_names_stay_compatible():
    generated = {
        creds_panel._build_unique_refresh_filename(None)
        for _ in range(500)
    }
    assert len(generated) == 500
    assert all(name.startswith("refresh-") and name.endswith(".json") for name in generated)
    assert creds_panel._build_unique_refresh_filename("../named") == "named.json"
    assert creds_panel._build_unique_refresh_filename("named.json") == "named.json"
