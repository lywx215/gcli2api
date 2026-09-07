import asyncio
import json
from pathlib import Path

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


def test_panel_metadata_prefers_immutable_build_info(tmp_path: Path, monkeypatch):
    _write_version_file(tmp_path)
    (tmp_path / ".gcli2api-build-info").write_text(
        "source_ref=dev8\nsource_type=branch\ncommit_date=2026-09-07T04:16:00Z\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        versioning,
        "_read_git_metadata",
        lambda _root: {
            "source_ref": "local-branch",
            "source_type": "branch",
            "commit_date": "2026-09-08T00:00:00+08:00",
        },
    )

    metadata = load_panel_version_metadata(project_root=tmp_path, environ={})

    assert metadata["display_version"] == "dev8-20260907-1216"
    assert metadata["source_ref"] == "dev8"
    assert metadata["commit_date"] == "2026-09-07T12:16:00+08:00"


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


def test_panel_metadata_handles_invalid_build_info_and_legacy_fallback(
    tmp_path: Path, monkeypatch
):
    _write_version_file(tmp_path)
    (tmp_path / ".gcli2api-build-info").write_text(
        "source_ref=dev8\ncommit_date=not-a-date\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(versioning, "_read_git_metadata", lambda _root: {})

    metadata = load_panel_version_metadata(
        project_root=tmp_path,
        environ={"GCLI2API_VERSION": "dev8"},
    )

    assert metadata["display_version"] == "dev8-20260717-1200"
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


def test_docker_build_metadata_uses_build_args_not_runtime_configuration():
    project_root = Path(__file__).resolve().parent
    dockerfile = (project_root / "Dockerfile").read_text(encoding="utf-8")
    workflow = (project_root / ".github/workflows/docker-publish.yml").read_text(
        encoding="utf-8"
    )

    assert "ARG SOURCE_REF=unknown" in dockerfile
    assert "ARG SOURCE_REF_TYPE=unknown" in dockerfile
    assert "ARG SOURCE_COMMIT_DATE=unknown" in dockerfile
    assert "/app/.gcli2api-build-info" in dockerfile
    assert "GCLI2API_SOURCE_REF" not in dockerfile
    assert "GCLI2API_SOURCE_REF_TYPE" not in dockerfile
    assert "GCLI2API_SOURCE_COMMIT_DATE" not in dockerfile
    assert "SOURCE_REF=${{ steps.source-version.outputs.source_ref }}" in workflow
    assert (
        "SOURCE_REF_TYPE=${{ steps.source-version.outputs.source_ref_type }}" in workflow
    )
    assert (
        "SOURCE_COMMIT_DATE=${{ steps.source-version.outputs.commit_date }}" in workflow
    )
    assert "git log -1 --format=%cI" in workflow
