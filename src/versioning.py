"""Resolve build/version metadata from release inputs or version.txt."""

from __future__ import annotations

import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Mapping


PROJECT_ROOT = Path(__file__).resolve().parent.parent
_RELEASE_VERSION_RE = re.compile(r"^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$")
_SAFE_ASSET_VERSION_RE = re.compile(r"[^0-9A-Za-z._-]+")
_SAFE_SOURCE_REF_RE = re.compile(r"[^0-9A-Za-z._-]+")
_BUILD_INFO_FILE = ".gcli2api-build-info"
_BEIJING_TIMEZONE = timezone(timedelta(hours=8))


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


def _read_key_value_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    result: dict[str, str] = {}
    try:
        with path.open("r", encoding="utf-8") as file:
            for raw_line in file:
                line = raw_line.strip()
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key:
                    result[key] = value.strip()
    except (OSError, UnicodeError):
        return {}
    return result


def _run_git(project_root: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(project_root), *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _read_git_metadata(project_root: Path) -> dict[str, str]:
    full_hash = _run_git(project_root, "rev-parse", "HEAD")
    if not full_hash:
        return {}

    exact_release = ""
    for tag in _run_git(project_root, "tag", "--points-at", "HEAD").splitlines():
        candidate = tag.strip()
        if _RELEASE_VERSION_RE.fullmatch(candidate):
            exact_release = candidate
            break

    branch = _run_git(project_root, "symbolic-ref", "--quiet", "--short", "HEAD")
    short_hash = _run_git(project_root, "rev-parse", "--short=7", "HEAD") or full_hash[:7]
    return {
        "source_ref": exact_release or branch or f"detached-{short_hash}",
        "source_type": "tag" if exact_release else ("branch" if branch else "detached"),
        "commit_date": _run_git(project_root, "log", "-1", "--format=%cI"),
        "full_hash": full_hash,
        "short_hash": short_hash,
        "message": _run_git(project_root, "log", "-1", "--format=%s"),
    }


def _normalize_source_ref(source_ref: str) -> str:
    normalized = source_ref.strip()
    for prefix in ("refs/heads/", "refs/tags/", "refs/remotes/"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break
    normalized = _SAFE_SOURCE_REF_RE.sub("-", normalized).strip("-._")
    return normalized or "dev"


def _parse_commit_date(value: str) -> datetime | None:
    normalized = value.strip()
    if not normalized or normalized.lower() == "unknown":
        return None
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_BEIJING_TIMEZONE)
    return parsed.astimezone(_BEIJING_TIMEZONE)


def format_panel_display_version(
    source_ref: str,
    commit_date: str,
    *,
    fallback_version: str = "unknown",
    source_type: str = "",
) -> str:
    """Format the panel-only version without changing application SemVer."""
    source_ref = source_ref.strip()
    if source_type == "tag" and _RELEASE_VERSION_RE.fullmatch(source_ref):
        return f"v{source_ref.removeprefix('v')}"

    parsed_date = _parse_commit_date(commit_date)
    if source_ref and parsed_date is not None:
        return f"{_normalize_source_ref(source_ref)}-{parsed_date:%Y%m%d-%H%M}"

    fallback_version = fallback_version.strip() or "unknown"
    if _RELEASE_VERSION_RE.fullmatch(fallback_version):
        return f"v{fallback_version.removeprefix('v')}"
    return fallback_version


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


def load_panel_version_metadata(
    project_root: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return additive metadata used only by the control-panel version label."""
    root = project_root or PROJECT_ROOT
    env = os.environ if environ is None else environ
    base = load_version_metadata(project_root=root, environ=env)
    build_info = _read_key_value_file(root / _BUILD_INFO_FILE)
    git_info = _read_git_metadata(root)

    build_source_ref = build_info.get("source_ref", "").strip()
    build_source_type = build_info.get("source_type", "").strip()
    git_source_ref = git_info.get("source_ref", "").strip()
    git_source_type = git_info.get("source_type", "").strip()
    release_ref = ""
    if build_source_type == "tag" and _RELEASE_VERSION_RE.fullmatch(build_source_ref):
        release_ref = build_source_ref
    elif git_source_type == "tag" and _RELEASE_VERSION_RE.fullmatch(git_source_ref):
        release_ref = git_source_ref
    elif not build_source_ref and not git_source_ref:
        legacy_release = env.get("GCLI2API_VERSION", "").strip()
        if _RELEASE_VERSION_RE.fullmatch(legacy_release):
            release_ref = legacy_release

    if release_ref:
        source_ref = release_ref
        source_type = "tag"
        commit_date = (
            build_info.get("commit_date", "")
            or git_info.get("commit_date", "")
            or base.get("date", "")
        )
    elif build_source_ref and _parse_commit_date(
        build_info.get("commit_date", "")
    ):
        source_ref = build_source_ref
        source_type = build_source_type or "branch"
        commit_date = build_info["commit_date"]
    elif git_source_ref and _parse_commit_date(
        git_info.get("commit_date", "")
    ):
        source_ref = git_source_ref
        source_type = git_source_type
        commit_date = git_info["commit_date"]
    else:
        source_ref = env.get("GCLI2API_VERSION", "").strip()
        source_type = ""
        commit_date = base.get("date", "")
        if not source_ref:
            short_hash = base.get("version", "")
            source_ref = f"detached-{short_hash}" if short_hash else ""

    parsed_commit_date = _parse_commit_date(commit_date)
    normalized_commit_date = (
        parsed_commit_date.isoformat(timespec="seconds")
        if parsed_commit_date is not None
        else commit_date
    )
    return {
        **base,
        "display_version": format_panel_display_version(
            source_ref,
            commit_date,
            fallback_version=base.get("version", "unknown"),
            source_type=source_type,
        ),
        "source_ref": _normalize_source_ref(source_ref) if source_ref else "",
        "commit_date": normalized_commit_date,
        "full_hash": git_info.get("full_hash") or base.get("full_hash", ""),
        "message": git_info.get("message") or base.get("message", ""),
        "date": normalized_commit_date or base.get("date", ""),
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
