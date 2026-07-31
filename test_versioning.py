from pathlib import Path

from src.versioning import get_asset_version, load_version_metadata


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
