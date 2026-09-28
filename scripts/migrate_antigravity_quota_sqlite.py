"""Inspect/apply the additive quota migration to an explicitly named SQLite DB.

Default is inspection only. Never opens a configured production DB implicitly.
The service performs the same additive schema migration on normal startup.
"""
import argparse
import json
import sqlite3
import uuid
from pathlib import Path


def migrate(path, apply=False):
    path = Path(path).resolve(strict=True)
    # mode=rw prevents accidentally creating a database with a misspelled path.
    with sqlite3.connect(path.as_uri() + "?mode=rw", uri=True) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(antigravity_credentials)")}
        if not columns:
            raise ValueError("antigravity_credentials table is missing")
        definitions = {"quota_group_states": "TEXT DEFAULT '{}'", "quota_credential_generation": "TEXT"}
        missing = [key for key in definitions if key not in columns]
        if apply:
            conn.execute("BEGIN IMMEDIATE")
            for name in missing:
                conn.execute(f"ALTER TABLE antigravity_credentials ADD COLUMN {name} {definitions[name]}")
            rows = conn.execute("SELECT filename FROM antigravity_credentials WHERE quota_credential_generation IS NULL OR quota_credential_generation = ''").fetchall()
            conn.executemany("UPDATE antigravity_credentials SET quota_credential_generation = ? WHERE filename = ?", [(uuid.uuid4().hex, row[0]) for row in rows])
            conn.commit()
        return {"applied": apply, "missing_columns": missing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(migrate(args.database, args.apply)))


if __name__ == "__main__":
    main()
