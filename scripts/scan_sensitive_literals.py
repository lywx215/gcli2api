from __future__ import annotations

import hashlib
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", ".venv", "__pycache__", ".pytest_cache", "build", "creds"}
SKIP_NAMES = {"log.txt", "run.stdout.log", "run.stderr.log"}
PATTERNS = {
    "Google OAuth secret": re.compile(r"GOCSPX-[0-9A-Za-z_-]{12,}"),
    "Google API key": re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    "GitHub token": re.compile(r"(?:ghp_|github_pat_)[0-9A-Za-z_]{20,}"),
    "private key": re.compile(r"BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY"),
}

# These exact digests are pre-existing public client constants in the dev7
# baseline.  Keeping an occurrence-counted digest baseline avoids copying the
# values into this gate while still rejecting a new literal, including a
# duplicate added to the same file.
BASELINE_MATCHES = Counter(
    {
        (
            "src/utils.py",
            "Google OAuth secret",
            "6a5f78b8b99dd4025e41ba11bf54c304c6af29f924c5569cc7865b2428ce03a9",
        ): 1,
        (
            "src/utils.py",
            "Google OAuth secret",
            "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
        ): 1,
        (
            "src/api/vertex.py",
            "Google API key",
            "a3e04d501205884183f7ee22497340bf4f1530d76bbbc5878fa179461bbfdc69",
        ): 1,
        (
            "src/panel/creds.py",
            "Google OAuth secret",
            "6a5f78b8b99dd4025e41ba11bf54c304c6af29f924c5569cc7865b2428ce03a9",
        ): 1,
    }
)


def main() -> int:
    failures: list[str] = []
    seen: Counter[tuple[str, str, str]] = Counter()
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.name in SKIP_NAMES:
            continue
        if any(part in SKIP_PARTS for part in path.relative_to(ROOT).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        relative = path.relative_to(ROOT).as_posix()
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                digest = hashlib.sha256(match.group(0).encode("utf-8")).hexdigest()
                key = (relative, label, digest)
                seen[key] += 1
                if seen[key] > BASELINE_MATCHES[key]:
                    failures.append(f"{relative}: {label}")
    if failures:
        print("Sensitive literal scan failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("Sensitive literal scan passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
