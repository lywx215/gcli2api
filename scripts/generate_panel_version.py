"""Generate the user-controlled control-panel version file."""

from __future__ import annotations

import argparse
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PANEL_VERSION_FILE = "panel-version.txt"
BEIJING_TIMEZONE = timezone(timedelta(hours=8))
_SAFE_SOURCE_REF_RE = re.compile(r"[^0-9A-Za-z._-]+")


def _run_git(project_root: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(project_root), *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def normalize_source_ref(source_ref: str) -> str:
    normalized = source_ref.strip()
    for prefix in ("refs/heads/", "refs/remotes/"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break
    normalized = _SAFE_SOURCE_REF_RE.sub("-", normalized).strip("-._")
    return normalized or "dev"


def build_panel_version(source_ref: str, now: datetime) -> dict[str, str]:
    if now.tzinfo is None:
        now = now.replace(tzinfo=BEIJING_TIMEZONE)
    beijing_now = now.astimezone(BEIJING_TIMEZONE)
    normalized_ref = normalize_source_ref(source_ref)
    return {
        "display_version": f"{normalized_ref}-{beijing_now:%Y%m%d-%H%M}",
        "source_ref": normalized_ref,
        "commit_date": beijing_now.isoformat(timespec="seconds"),
    }


def write_panel_version(project_root: Path, metadata: dict[str, str]) -> Path:
    output = project_root / PANEL_VERSION_FILE
    output.write_text(
        "".join(f"{key}={value}\n" for key, value in metadata.items()),
        encoding="utf-8",
    )
    return output


def should_generate(prompt=input) -> bool:
    try:
        answer = prompt("是否生成新的控制面板版本号？[y/N]: ").strip().lower()
    except EOFError:
        return False
    return answer in {"y", "yes", "是"}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate panel-version.txt only after explicit confirmation."
    )
    parser.add_argument("--yes", action="store_true", help="generate without prompting")
    parser.add_argument("--stage", action="store_true", help="stage the generated file")
    args = parser.parse_args()

    if not args.yes and not should_generate():
        print("控制面板版本号保持不变")
        return 0

    source_ref = _run_git(PROJECT_ROOT, "symbolic-ref", "--quiet", "--short", "HEAD")
    if not source_ref:
        short_hash = _run_git(PROJECT_ROOT, "rev-parse", "--short=7", "HEAD")
        source_ref = f"detached-{short_hash}" if short_hash else "dev"
    metadata = build_panel_version(source_ref, datetime.now(BEIJING_TIMEZONE))
    output = write_panel_version(PROJECT_ROOT, metadata)
    if args.stage:
        subprocess.run(
            ["git", "-C", str(PROJECT_ROOT), "add", "--", output.name],
            check=True,
        )
    print(f"已生成控制面板版本号: {metadata['display_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
