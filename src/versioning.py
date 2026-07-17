"""Resolve build/version metadata from release inputs or version.txt."""

from __future__ import annotations

import os
import re
from hashlib import sha256
from pathlib import Path
from typing import Mapping


PROJECT_ROOT = Path(__file__).resolve().parent.parent
_RELEASE_VERSION_RE = re.compile(r"^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$")
_SAFE_ASSET_VERSION_RE = re.compile(r"[^0-9A-Za-z._-]+")


def _read_version_file(project_root: Path) -> dict[str, str]:
    version_file = project_root / "version.txt"
    if not version_file.exists():
        return {}

    version_data: dict[str, str] = {}
    with version_file.open("r", encoding="utf-8") as file:
        for raw_line in file:
            line = raw_line.strip()
            if "=" in line:
                key, value = line.split("=", 1)
                version_data[key] = value
    return version_data


def load_version_metadata(
    project_root: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return the version shown by the panel.

    Release builds inject their tag, revision, and build date through environment
    variables. Source checkouts fall back to the workflow-maintained version.txt.
    """

    root = project_root or PROJECT_ROOT
    env = os.environ if environ is None else environ
    file_data = _read_version_file(root)

    release_version = env.get("GCLI2API_VERSION", "").strip()
    revision = env.get("GCLI2API_REVISION", "").strip()
    build_date = env.get("GCLI2API_BUILD_DATE", "").strip()

    if revision.lower() == "unknown":
        revision = ""

    full_hash = revision or file_data.get("full_hash", "")
    if release_version and _RELEASE_VERSION_RE.fullmatch(release_version):
        display_version = release_version.removeprefix("v")
    elif full_hash:
        display_version = full_hash[:7]
    else:
        display_version = file_data.get("short_hash", "unknown")

    return {
        "version": display_version,
        "full_hash": full_hash,
        "message": file_data.get("message", ""),
        "date": build_date or file_data.get("date", ""),
    }


def get_asset_version(
    project_root: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Return a safe cache-busting value for frontend assets."""

    metadata = load_version_metadata(project_root=project_root, environ=environ)
    raw_version = metadata["full_hash"] or metadata["version"] or "dev"
    frontend_asset = (project_root or PROJECT_ROOT) / "front" / "common.js"
    if frontend_asset.exists():
        asset_digest = sha256(frontend_asset.read_bytes()).hexdigest()[:12]
        raw_version = f"{raw_version}-{asset_digest}"
    return _SAFE_ASSET_VERSION_RE.sub("-", raw_version)
