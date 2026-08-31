from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from fastapi import FastAPI

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.management.router import install_management_api  # noqa: E402

BASELINE = PROJECT_ROOT / "docs" / "openapi" / "management-v1.openapi.json"


def build_schema() -> dict[str, object]:
    app = FastAPI(
        title="gcli2api Management API",
        version="management-schema-1.3",
        docs_url=None,
        redoc_url=None,
    )
    install_management_api(app)
    return app.openapi()


def serialized_schema() -> str:
    return json.dumps(build_schema(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generated = serialized_schema()
    if args.check:
        if not BASELINE.exists() or BASELINE.read_text(encoding="utf-8") != generated:
            print("Management OpenAPI baseline is out of date", file=sys.stderr)
            return 1
        print("Management OpenAPI baseline is current")
        return 0
    BASELINE.parent.mkdir(parents=True, exist_ok=True)
    BASELINE.write_text(generated, encoding="utf-8")
    print(BASELINE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
