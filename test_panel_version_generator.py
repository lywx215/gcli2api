from datetime import datetime, timezone
from pathlib import Path

from scripts.generate_panel_version import (
    build_panel_version,
    normalize_source_ref,
    should_generate,
    write_panel_version,
)


def test_build_panel_version_uses_branch_and_beijing_time():
    metadata = build_panel_version(
        "refs/heads/feature/version ui",
        datetime(2026, 9, 7, 5, 6, 55, tzinfo=timezone.utc),
    )

    assert metadata == {
        "display_version": "feature-version-ui-20260907-1306",
        "source_ref": "feature-version-ui",
        "commit_date": "2026-09-07T13:06:55+08:00",
    }


def test_prompt_defaults_to_keep_existing_version():
    assert should_generate(lambda _message: "") is False
    assert should_generate(lambda _message: "n") is False
    assert should_generate(lambda _message: "y") is True
    assert should_generate(lambda _message: "是") is True


def test_write_panel_version_is_stable_until_generated_again(tmp_path: Path):
    first = build_panel_version(
        "dev8",
        datetime(2026, 9, 7, 5, 6, 55, tzinfo=timezone.utc),
    )
    output = write_panel_version(tmp_path, first)
    original = output.read_text(encoding="utf-8")

    assert normalize_source_ref("dev8") == "dev8"
    assert output.read_text(encoding="utf-8") == original
