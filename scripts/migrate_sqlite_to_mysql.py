"""
SQLite → MySQL 数据迁移脚本

Usage:
    python scripts/migrate_sqlite_to_mysql.py
    python scripts/migrate_sqlite_to_mysql.py --server-name server-A
    python scripts/migrate_sqlite_to_mysql.py --sqlite-path ./creds/credentials.db --server-name server-A
    python scripts/migrate_sqlite_to_mysql.py --dry-run
"""

import argparse
import asyncio
import json
import os
import sys
import time

# 添加项目根目录到 PATH
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aiosqlite

try:
    import aiomysql
except ImportError:
    print("❌ 需要安装 aiomysql: pip install aiomysql")
    sys.exit(1)


def parse_mysql_uri(uri: str) -> dict:
    """解析 MySQL URI"""
    from urllib.parse import urlparse, parse_qs
    parsed = urlparse(uri)
    params = parse_qs(parsed.query)
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 3306,
        "user": parsed.username or "root",
        "password": parsed.password or "",
        "db": parsed.path.lstrip("/") or "gcli2api",
        "charset": params.get("charset", ["utf8mb4"])[0],
    }


async def ensure_tables(conn):
    """确保 MySQL 表已创建"""
    async with conn.cursor() as cur:
        await cur.execute("""
            CREATE TABLE IF NOT EXISTS gcli_credentials (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_name VARCHAR(64) NOT NULL DEFAULT 'default',
                filename VARCHAR(255) NOT NULL,
                credential_data LONGTEXT NOT NULL,
                disabled TINYINT(1) DEFAULT 0,
                error_codes TEXT,
                error_messages LONGTEXT,
                last_success DOUBLE,
                user_email VARCHAR(255),
                model_cooldowns TEXT,
                preview TINYINT(1) DEFAULT 1,
                rotation_order INT DEFAULT 0,
                call_count INT DEFAULT 0,
                created_at DOUBLE,
                updated_at DOUBLE,
                UNIQUE KEY uk_server_filename (server_name, filename),
                KEY idx_server_disabled (server_name, disabled)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        await cur.execute("""
            CREATE TABLE IF NOT EXISTS gcli_antigravity_credentials (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_name VARCHAR(64) NOT NULL DEFAULT 'default',
                filename VARCHAR(255) NOT NULL,
                credential_data LONGTEXT NOT NULL,
                disabled TINYINT(1) DEFAULT 0,
                error_codes TEXT,
                error_messages LONGTEXT,
                last_success DOUBLE,
                user_email VARCHAR(255),
                model_cooldowns TEXT,
                rotation_order INT DEFAULT 0,
                call_count INT DEFAULT 0,
                created_at DOUBLE,
                updated_at DOUBLE,
                UNIQUE KEY uk_server_filename (server_name, filename),
                KEY idx_server_disabled (server_name, disabled)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        await cur.execute("""
            CREATE TABLE IF NOT EXISTS gcli_config (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_name VARCHAR(64) NOT NULL DEFAULT 'default',
                `key` VARCHAR(255) NOT NULL,
                value TEXT NOT NULL,
                updated_at DOUBLE,
                UNIQUE KEY uk_server_key (server_name, `key`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

    await conn.commit()
    print("✅ MySQL 表已创建/确认")


async def migrate_credentials_table(
    sqlite_db, mysql_conn, sqlite_table, mysql_table, server_name, dry_run=False
):
    """迁移凭证表"""
    async with sqlite_db.execute(f"""
        SELECT filename, credential_data, disabled, error_codes, error_messages,
               last_success, user_email, model_cooldowns,
               {'preview, ' if sqlite_table == 'credentials' else ''}
               rotation_order, call_count, created_at, updated_at
        FROM {sqlite_table}
    """) as cursor:
        rows = await cursor.fetchall()

    if not rows:
        print(f"  ⏭ {sqlite_table}: 空表，跳过")
        return 0

    if dry_run:
        print(f"  📊 {sqlite_table}: {len(rows)} 条记录（试运行，不写入）")
        return len(rows)

    count = 0
    async with mysql_conn.cursor() as cur:
        for row in rows:
            if sqlite_table == "credentials":
                (filename, credential_data, disabled, error_codes, error_messages,
                 last_success, user_email, model_cooldowns,
                 preview, rotation_order, call_count, created_at, updated_at) = row

                await cur.execute(f"""
                    INSERT INTO {mysql_table}
                    (server_name, filename, credential_data, disabled, error_codes,
                     error_messages, last_success, user_email, model_cooldowns,
                     preview, rotation_order, call_count, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        credential_data = VALUES(credential_data),
                        disabled = VALUES(disabled),
                        error_codes = VALUES(error_codes),
                        error_messages = VALUES(error_messages),
                        last_success = VALUES(last_success),
                        user_email = VALUES(user_email),
                        model_cooldowns = VALUES(model_cooldowns),
                        preview = VALUES(preview),
                        rotation_order = VALUES(rotation_order),
                        call_count = VALUES(call_count),
                        updated_at = VALUES(updated_at)
                """, (server_name, filename, credential_data, disabled,
                      error_codes or '[]', error_messages or '[]',
                      last_success, user_email, model_cooldowns or '{}',
                      preview if preview is not None else 1,
                      rotation_order or 0, call_count or 0,
                      created_at, updated_at))
            else:
                # antigravity_credentials（无 preview 列）
                (filename, credential_data, disabled, error_codes, error_messages,
                 last_success, user_email, model_cooldowns,
                 rotation_order, call_count, created_at, updated_at) = row

                await cur.execute(f"""
                    INSERT INTO {mysql_table}
                    (server_name, filename, credential_data, disabled, error_codes,
                     error_messages, last_success, user_email, model_cooldowns,
                     rotation_order, call_count, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        credential_data = VALUES(credential_data),
                        disabled = VALUES(disabled),
                        error_codes = VALUES(error_codes),
                        error_messages = VALUES(error_messages),
                        last_success = VALUES(last_success),
                        user_email = VALUES(user_email),
                        model_cooldowns = VALUES(model_cooldowns),
                        rotation_order = VALUES(rotation_order),
                        call_count = VALUES(call_count),
                        updated_at = VALUES(updated_at)
                """, (server_name, filename, credential_data, disabled,
                      error_codes or '[]', error_messages or '[]',
                      last_success, user_email, model_cooldowns or '{}',
                      rotation_order or 0, call_count or 0,
                      created_at, updated_at))
            count += 1

    await mysql_conn.commit()
    print(f"  ✅ {sqlite_table} → {mysql_table}: {count} 条记录已迁移")
    return count


async def migrate_config_table(sqlite_db, mysql_conn, server_name, dry_run=False):
    """迁移配置表"""
    try:
        async with sqlite_db.execute("SELECT key, value, updated_at FROM config") as cursor:
            rows = await cursor.fetchall()
    except Exception:
        print("  ⏭ config: 表不存在，跳过")
        return 0

    if not rows:
        print("  ⏭ config: 空表，跳过")
        return 0

    if dry_run:
        print(f"  📊 config: {len(rows)} 条记录（试运行，不写入）")
        return len(rows)

    count = 0
    async with mysql_conn.cursor() as cur:
        for key, value, updated_at in rows:
            await cur.execute("""
                INSERT INTO gcli_config (server_name, `key`, value, updated_at)
                VALUES (%s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    value = VALUES(value),
                    updated_at = VALUES(updated_at)
            """, (server_name, key, value, updated_at))
            count += 1

    await mysql_conn.commit()
    print(f"  ✅ config → gcli_config: {count} 条记录已迁移")
    return count


async def verify_migration(mysql_conn, server_name, expected_counts):
    """验证迁移数据一致性"""
    print("\n🔍 验证迁移数据...")
    all_ok = True

    for mysql_table, expected in expected_counts.items():
        async with mysql_conn.cursor() as cur:
            await cur.execute(
                f"SELECT COUNT(*) FROM {mysql_table} WHERE server_name = %s",
                (server_name,)
            )
            row = await cur.fetchone()
            actual = row[0]

        if actual == expected:
            print(f"  ✅ {mysql_table}: {actual} 条（一致）")
        else:
            print(f"  ⚠️ {mysql_table}: 期望 {expected}，实际 {actual}")
            all_ok = False

    return all_ok


async def main():
    parser = argparse.ArgumentParser(description="SQLite → MySQL 数据迁移")
    parser.add_argument("--sqlite-path", default=None,
                        help="SQLite 数据库路径（默认: ./creds/credentials.db）")
    parser.add_argument("--server-name", default=None,
                        help="服务器名称标识（默认: 环境变量 GCLI_SERVER_NAME 或 'default'）")
    parser.add_argument("--dry-run", action="store_true",
                        help="试运行，只显示统计不写入")
    args = parser.parse_args()

    # 确定 SQLite 路径
    sqlite_path = args.sqlite_path
    if not sqlite_path:
        creds_dir = os.getenv("CREDENTIALS_DIR", "./creds")
        sqlite_path = os.path.join(creds_dir, "credentials.db")

    # 确定 server_name
    server_name = args.server_name or os.getenv("GCLI_SERVER_NAME", "default")

    # 确定 MySQL URI
    mysql_uri = os.getenv("MYSQL_URI", "")
    if not mysql_uri:
        print("❌ 未设置 MYSQL_URI 环境变量")
        print("   示例: set MYSQL_URI=mysql://user:pass@host:3306/gcli2api")
        sys.exit(1)

    # 检查 SQLite 文件
    if not os.path.exists(sqlite_path):
        print(f"❌ SQLite 文件不存在: {sqlite_path}")
        sys.exit(1)

    print("=" * 60)
    print("  SQLite → MySQL 数据迁移")
    print("=" * 60)
    print(f"  SQLite:      {os.path.abspath(sqlite_path)}")
    print(f"  MySQL:       {mysql_uri.split('@')[-1] if '@' in mysql_uri else mysql_uri}")
    print(f"  Server Name: {server_name}")
    print(f"  模式:        {'试运行 (DRY RUN)' if args.dry_run else '正式迁移'}")
    print("=" * 60)

    # 连接 SQLite（只读）
    sqlite_db = await aiosqlite.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    print("\n✅ SQLite 连接成功")

    # 连接 MySQL
    conn_params = parse_mysql_uri(mysql_uri)
    pool = await aiomysql.create_pool(
        host=conn_params["host"],
        port=conn_params["port"],
        user=conn_params["user"],
        password=conn_params["password"],
        db=conn_params["db"],
        charset=conn_params["charset"],
        autocommit=False,
    )

    async with pool.acquire() as mysql_conn:
        print("✅ MySQL 连接成功")

        # 确保表存在
        if not args.dry_run:
            await ensure_tables(mysql_conn)

        print("\n📦 开始迁移...")

        # 迁移 credentials
        cred_count = await migrate_credentials_table(
            sqlite_db, mysql_conn,
            "credentials", "gcli_credentials",
            server_name, args.dry_run
        )

        # 迁移 antigravity_credentials
        ant_count = await migrate_credentials_table(
            sqlite_db, mysql_conn,
            "antigravity_credentials", "gcli_antigravity_credentials",
            server_name, args.dry_run
        )

        # 迁移 config
        config_count = await migrate_config_table(
            sqlite_db, mysql_conn, server_name, args.dry_run
        )

        if not args.dry_run:
            # 验证
            ok = await verify_migration(mysql_conn, server_name, {
                "gcli_credentials": cred_count,
                "gcli_antigravity_credentials": ant_count,
                "gcli_config": config_count,
            })

            print("\n" + "=" * 60)
            if ok:
                print("  ✅ 迁移完成！数据验证通过")
            else:
                print("  ⚠️ 迁移完成，但部分数据验证不一致")
            print(f"  credentials:     {cred_count} 条")
            print(f"  antigravity:     {ant_count} 条")
            print(f"  config:          {config_count} 条")
            print(f"  server_name:     {server_name}")
            print("=" * 60)
            print("\n💡 下一步: 设置环境变量 MYSQL_URI 和 GCLI_SERVER_NAME 后重启 gcli2api")
        else:
            print("\n" + "=" * 60)
            print(f"  📊 试运行完成（总计: {cred_count + ant_count + config_count} 条记录）")
            print("  使用不带 --dry-run 执行正式迁移")
            print("=" * 60)

    # 清理
    await sqlite_db.close()
    pool.close()
    await pool.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
