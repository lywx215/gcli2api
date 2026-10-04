import asyncio
import json
from pathlib import Path

import pytest

import src.panel.version as panel_version
import src.versioning as versioning
from src.versioning import (
    format_panel_display_version,
    get_asset_version,
    load_panel_version_metadata,
    load_version_metadata,
)


def _write_version_file(root: Path) -> None:
    (root / "version.txt").write_text(
        "full_hash=1234567890abcdef\n"
        "short_hash=1234567\n"
        "message=test commit\n"
        "date=2026-07-17 12:00:00 +0800\n",
        encoding="utf-8",
    )


def test_version_metadata_falls_back_to_version_file(tmp_path: Path):
    _write_version_file(tmp_path)

    metadata = load_version_metadata(project_root=tmp_path, environ={})

    assert metadata == {
        "version": "1234567",
        "full_hash": "1234567890abcdef",
        "message": "test commit",
        "date": "2026-07-17 12:00:00 +0800",
    }


def test_release_build_metadata_overrides_file(tmp_path: Path):
    _write_version_file(tmp_path)
    environ = {
        "GCLI2API_VERSION": "v2.4.1",
        "GCLI2API_REVISION": "abcdef0123456789",
        "GCLI2API_BUILD_DATE": "2026-07-18T00:00:00Z",
    }

    metadata = load_version_metadata(project_root=tmp_path, environ=environ)

    assert metadata["version"] == "2.4.1"
    assert metadata["full_hash"] == "abcdef0123456789"
    assert metadata["date"] == "2026-07-18T00:00:00Z"


def test_branch_build_uses_revision_and_asset_cache_key(tmp_path: Path):
    _write_version_file(tmp_path)
    (tmp_path / "front").mkdir()
    (tmp_path / "front" / "common.js").write_text("console.log('v1');", encoding="utf-8")
    environ = {
        "GCLI2API_VERSION": "master",
        "GCLI2API_REVISION": "fedcba9876543210",
    }

    metadata = load_version_metadata(project_root=tmp_path, environ=environ)

    assert metadata["version"] == "fedcba9"
    first_asset_version = get_asset_version(project_root=tmp_path, environ=environ)
    assert first_asset_version.startswith("fedcba9876543210-")

    (tmp_path / "front" / "common.js").write_text("console.log('v2');", encoding="utf-8")
    assert get_asset_version(project_root=tmp_path, environ=environ) != first_asset_version


def test_panel_branch_version_uses_beijing_commit_minute():
    assert format_panel_display_version(
        "dev8", "2026-09-07T04:16:59Z"
    ) == "dev8-20260907-1216"
    assert format_panel_display_version(
        "refs/heads/feature/version ui", "2026-09-07T12:16:00+08:00"
    ) == "feature-version-ui-20260907-1216"


def test_panel_release_version_keeps_semver_without_timestamp():
    assert format_panel_display_version(
        "v1.3.0", "2026-09-07T12:16:00+08:00", source_type="tag"
    ) == "v1.3.0"
    assert format_panel_display_version(
        "1.3.0-rc.1", "2026-09-07T12:16:00+08:00", source_type="tag"
    ) == "v1.3.0-rc.1"


def test_semver_shaped_branch_is_not_treated_as_release_tag():
    assert format_panel_display_version(
        "v1.3.0", "2026-09-07T12:16:00+08:00", source_type="branch"
    ) == "v1.3.0-20260907-1216"


def test_panel_metadata_recognizes_an_exact_git_release_tag(tmp_path: Path, monkeypatch):
    _write_version_file(tmp_path)
    monkeypatch.setattr(
        versioning,
        "_read_git_metadata",
        lambda _root: {
            "source_ref": "v1.3.0",
            "source_type": "tag",
            "commit_date": "2026-09-07T12:16:00+08:00",
            "full_hash": "abcdef0123456789",
            "message": "release 1.3.0",
        },
    )

    metadata = load_panel_version_metadata(project_root=tmp_path, environ={})

    assert metadata["display_version"] == "v1.3.0"
    assert metadata["source_ref"] == "v1.3.0"


def test_panel_metadata_uses_current_branch_instead_of_saved_label(tmp_path: Path, monkeypatch):
    _write_version_file(tmp_path)
    (tmp_path / "panel-version.txt").write_text(
        "display_version=dev8-20260907-1216\n"
        "source_ref=dev8\n"
        "commit_date=2026-09-07T04:16:00Z\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        versioning,
        "_read_git_metadata",
        lambda _root: {
            "source_ref": "local-branch",
            "source_type": "branch",
            "commit_date": "2026-09-08T00:00:00+08:00",
            "full_hash": "abcdef0123456789",
        },
    )

    metadata = load_panel_version_metadata(project_root=tmp_path, environ={})

    assert metadata["display_version"] == "local-branch-20260908-0000"
    assert metadata["source_ref"] == "local-branch"
    assert metadata["commit_date"] == "2026-09-08T00:00:00+08:00"
    assert metadata["version"] == "abcdef0"
    assert metadata["full_hash"] == "abcdef0123456789"
    assert "source_ref=dev8" in (tmp_path / "panel-version.txt").read_text()


def test_panel_metadata_uses_local_git_and_detached_fallback(tmp_path: Path, monkeypatch):
    _write_version_file(tmp_path)
    monkeypatch.setattr(
        versioning,
        "_read_git_metadata",
        lambda _root: {
            "source_ref": "detached-fedcba9",
            "source_type": "detached",
            "commit_date": "2026-09-07T12:16:00+08:00",
            "full_hash": "fedcba9876543210",
            "message": "local commit",
        },
    )

    metadata = load_panel_version_metadata(project_root=tmp_path, environ={})

    assert metadata["display_version"] == "detached-fedcba9-20260907-1216"
    assert metadata["full_hash"] == "fedcba9876543210"
    assert metadata["message"] == "local commit"


def test_panel_metadata_handles_invalid_manual_version_and_legacy_fallback(
    tmp_path: Path, monkeypatch
):
    _write_version_file(tmp_path)
    (tmp_path / "panel-version.txt").write_text(
        "display_version=<invalid>\nsource_ref=dev8\ncommit_date=not-a-date\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(versioning, "_read_git_metadata", lambda _root: {})

    metadata = load_panel_version_metadata(
        project_root=tmp_path,
        environ={"GCLI2API_VERSION": "dev8"},
    )

    assert metadata["display_version"] == "dev8"
    assert metadata["version"] == "unknown"
    assert metadata["full_hash"] == ""
    assert metadata["commit_date"] == ""
    assert "display_version" not in load_version_metadata(
        project_root=tmp_path,
        environ={"GCLI2API_VERSION": "dev8"},
    )


def test_panel_metadata_keeps_release_environment_version(tmp_path: Path, monkeypatch):
    _write_version_file(tmp_path)
    monkeypatch.setattr(versioning, "_read_git_metadata", lambda _root: {})

    metadata = load_panel_version_metadata(
        project_root=tmp_path,
        environ={"GCLI2API_VERSION": "v2.4.1"},
    )

    assert metadata["display_version"] == "v2.4.1"


def test_panel_version_info_adds_display_fields_without_replacing_legacy_fields(
    monkeypatch,
):
    monkeypatch.setattr(
        panel_version,
        "load_panel_version_metadata",
        lambda: {
            "version": "abcdef0",
            "full_hash": "abcdef0123456789",
            "message": "test commit",
            "date": "2026-09-07T12:16:00+08:00",
            "display_version": "dev8-20260907-1216",
            "source_ref": "dev8",
            "commit_date": "2026-09-07T12:16:00+08:00",
        },
    )

    response = asyncio.run(panel_version.get_version_info())
    payload = json.loads(response.body)

    assert payload["version"] == "abcdef0"
    assert payload["full_hash"] == "abcdef0123456789"
    assert payload["message"] == "test commit"
    assert payload["date"] == "2026-09-07T12:16:00+08:00"
    assert payload["display_version"] == "dev8-20260907-1216"
    assert payload["source_ref"] == "dev8"
    assert payload["commit_date"] == "2026-09-07T12:16:00+08:00"


def test_zeabur_source_build_without_git_uses_deployed_branch_and_commit(tmp_path, monkeypatch):
    _write_version_file(tmp_path)
    (tmp_path / "panel-version.txt").write_text(
        "display_version=dev8-20260907-1339\nsource_ref=dev8\n"
        "commit_date=2026-09-07T13:39:30+08:00\n"
    )

    def git_not_available(_root):
        raise AssertionError("Source build metadata must not need Git in the image")

    monkeypatch.setattr(versioning, "_read_git_metadata", git_not_available)
    metadata = load_panel_version_metadata(project_root=tmp_path, environ={
        "ZEABUR_GIT_BRANCH": "d1004-1",
        "ZEABUR_GIT_COMMIT_SHA": "0c589f423e10b033bbc430705e9038685f38b7fa",
        "GCLI2API_VERSION": "unknown",
        "GCLI2API_REVISION": "unknown",
        "GCLI2API_BUILD_DATE": "unknown",
    })

    assert metadata["display_version"] == "d1004-1-0c589f4"
    assert metadata["source_ref"] == "d1004-1"
    assert metadata["version"] == "0c589f4"
    assert metadata["full_hash"] == "0c589f423e10b033bbc430705e9038685f38b7fa"
    assert metadata["commit_date"] == metadata["date"] == metadata["message"] == ""


@pytest.mark.parametrize("branch", ["master", "d1004-1", "feature/panel"])
def test_explicit_build_branch_and_commit_date_override_old_files(tmp_path, branch):
    _write_version_file(tmp_path)
    metadata = load_panel_version_metadata(project_root=tmp_path, environ={
        "GCLI2API_SOURCE_REF": branch,
        "GCLI2API_REVISION": "abcdef0123456789",
        "GCLI2API_COMMIT_DATE": "2026-10-04T12:00:00Z",
    })
    assert metadata["source_ref"] == branch.replace("/", "-")
    assert metadata["display_version"] == f"{branch.replace('/', '-')}-20261004-2000"
    assert metadata["version"] == "abcdef0"
    assert metadata["date"] == "2026-10-04T20:00:00+08:00"


def test_explicit_branch_is_not_relabelled_as_a_release(tmp_path):
    metadata = load_panel_version_metadata(project_root=tmp_path, environ={
        "GCLI2API_SOURCE_REF": "feature",
        "GCLI2API_VERSION": "v1.2.3",
        "GCLI2API_REVISION": "abcdef0123456789",
    })
    assert metadata["display_version"] == "feature-abcdef0"
    assert metadata["version"] == "abcdef0"


def test_only_revision_is_a_detached_build_without_duplicate_hash(tmp_path):
    metadata = load_panel_version_metadata(project_root=tmp_path, environ={
        "GCLI2API_REVISION": "abcdef0123456789",
    })
    assert metadata["display_version"] == "detached-abcdef0"
    assert metadata["source_ref"] == "detached-abcdef0"


def test_missing_metadata_does_not_claim_saved_dev8_is_current(tmp_path, monkeypatch):
    (tmp_path / "panel-version.txt").write_text(
        "display_version=dev8-20260907-1339\nsource_ref=dev8\n"
        "commit_date=2026-09-07T13:39:30+08:00\n"
    )
    monkeypatch.setattr(versioning, "_read_git_metadata", lambda _root: {})
    metadata = load_panel_version_metadata(project_root=tmp_path, environ={
        "GCLI2API_VERSION": "unknown",
        "GCLI2API_REVISION": "${ZEABUR_GIT_COMMIT_SHA}",
        "ZEABUR_GIT_BRANCH": "${ZEABUR_GIT_BRANCH}",
    })
    assert metadata["display_version"] == "unknown"
    assert metadata["source_ref"] == metadata["full_hash"] == ""


def test_legacy_update_request_does_not_query_another_repository(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import src.httpx_client as httpx_client

    def no_remote_call(*args, **kwargs):
        raise AssertionError("Version info must not make a remote update request")

    monkeypatch.setattr(httpx_client, "get_async", no_remote_call)
    monkeypatch.setattr(panel_version, "load_panel_version_metadata", lambda:
        load_panel_version_metadata(project_root=tmp_path, environ={
            "ZEABUR_GIT_BRANCH": "d1004-1",
            "ZEABUR_GIT_COMMIT_SHA": "abcdef0123456789",
        }))
    app = FastAPI()
    app.include_router(panel_version.router)
    response = TestClient(app).get("/version/info?check_update=true")
    payload = response.json()
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert payload["success"] is True
    assert payload["display_version"] == "d1004-1-abcdef0"
    assert payload["check_update"] is False
    assert "has_update" not in payload
