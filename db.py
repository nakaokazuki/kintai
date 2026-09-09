"""DB 初期化・アクセス（SQLite / PostgreSQL）。

DATABASE_URL がある場合は PostgreSQL（Neon 等）を使う。
未設定時はローカル用 SQLite。
"""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Optional, Union

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.environ.get("DATABASE_PATH", DATA_DIR / "kintai.db"))

DEFAULT_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "7777")
RESET_CODE = os.environ.get("ADMIN_RESET_CODE", "RESET-KINTAI-2026")

_DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
if _DATABASE_URL.startswith("postgres://"):
    _DATABASE_URL = "postgresql://" + _DATABASE_URL[len("postgres://") :]

USE_POSTGRES = bool(_DATABASE_URL)


def _qmark_to_percent(sql: str) -> str:
    """SQLite の ? プレースホルダを psycopg2 の %s に変換する。"""
    return re.sub(r"\?", "%s", sql)


class _PgCursor:
    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()


class PgConnection:
    """sqlite3.Connection に近いインターフェース。"""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql: str, args: tuple = ()):
        cur = self._conn.cursor()
        cur.execute(_qmark_to_percent(sql), args or ())
        return _PgCursor(cur)

    def executemany(self, sql: str, args_list: list):
        cur = self._conn.cursor()
        cur.executemany(_qmark_to_percent(sql), args_list)
        return _PgCursor(cur)

    def executescript(self, script: str) -> None:
        cur = self._conn.cursor()
        for stmt in script.split(";"):
            stmt = stmt.strip()
            if stmt:
                cur.execute(stmt)

    def commit(self) -> None:
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self._conn.commit()
        else:
            self._conn.rollback()
        self._conn.close()
        return False


def get_conn() -> Union[sqlite3.Connection, PgConnection]:
    if USE_POSTGRES:
        import psycopg2
        from psycopg2.extras import RealDictCursor

        raw = psycopg2.connect(_DATABASE_URL, cursor_factory=RealDictCursor)
        return PgConnection(raw)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(DB_PATH), detect_types=sqlite3.PARSE_DECLTYPES, timeout=30
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _sqlite_schema() -> str:
    return """
            CREATE TABLE IF NOT EXISTS employees (
              emp_no TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS admin_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              password TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attendance_days (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              emp_no TEXT NOT NULL,
              work_date TEXT NOT NULL,
              clock_in TEXT,
              clock_out TEXT,
              break_minutes INTEGER NOT NULL DEFAULT 0,
              on_break INTEGER NOT NULL DEFAULT 0,
              break_started_at TEXT,
              overtime_minutes INTEGER NOT NULL DEFAULT 0,
              force_work INTEGER NOT NULL DEFAULT 0,
              UNIQUE(emp_no, work_date),
              FOREIGN KEY(emp_no) REFERENCES employees(emp_no)
            );

            CREATE TABLE IF NOT EXISTS monthly_submissions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              emp_no TEXT NOT NULL,
              year_month TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT '未提出',
              submitted_at TEXT,
              reviewed_at TEXT,
              reject_reason TEXT,
              UNIQUE(emp_no, year_month),
              FOREIGN KEY(emp_no) REFERENCES employees(emp_no)
            );

            CREATE TABLE IF NOT EXISTS change_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at TEXT NOT NULL,
              changer TEXT NOT NULL,
              emp_no TEXT NOT NULL,
              work_date TEXT,
              field_name TEXT NOT NULL,
              old_value TEXT,
              new_value TEXT,
              reason TEXT
            );
            """


def _postgres_schema() -> str:
    return """
            CREATE TABLE IF NOT EXISTS employees (
              emp_no TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS admin_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              password TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attendance_days (
              id SERIAL PRIMARY KEY,
              emp_no TEXT NOT NULL REFERENCES employees(emp_no),
              work_date TEXT NOT NULL,
              clock_in TEXT,
              clock_out TEXT,
              break_minutes INTEGER NOT NULL DEFAULT 0,
              on_break INTEGER NOT NULL DEFAULT 0,
              break_started_at TEXT,
              overtime_minutes INTEGER NOT NULL DEFAULT 0,
              force_work INTEGER NOT NULL DEFAULT 0,
              UNIQUE(emp_no, work_date)
            );

            CREATE TABLE IF NOT EXISTS monthly_submissions (
              id SERIAL PRIMARY KEY,
              emp_no TEXT NOT NULL REFERENCES employees(emp_no),
              year_month TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT '未提出',
              submitted_at TEXT,
              reviewed_at TEXT,
              reject_reason TEXT,
              UNIQUE(emp_no, year_month)
            );

            CREATE TABLE IF NOT EXISTS change_logs (
              id SERIAL PRIMARY KEY,
              created_at TEXT NOT NULL,
              changer TEXT NOT NULL,
              emp_no TEXT NOT NULL,
              work_date TEXT,
              field_name TEXT NOT NULL,
              old_value TEXT,
              new_value TEXT,
              reason TEXT
            );
            """


def _has_column(conn, table: str, column: str) -> bool:
    if USE_POSTGRES:
        row = conn.execute(
            """SELECT 1 AS ok FROM information_schema.columns
               WHERE table_schema='public' AND table_name=? AND column_name=?""",
            (table, column),
        ).fetchone()
        return bool(row)
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return column in cols


def init_db(*, skip_auto_seed: bool = False) -> None:
    with get_conn() as conn:
        if USE_POSTGRES:
            # psycopg2 は複数文を一度に実行できる
            conn.executescript(_postgres_schema())
        else:
            conn.executescript(_sqlite_schema())

        if not _has_column(conn, "attendance_days", "force_work"):
            conn.execute(
                "ALTER TABLE attendance_days ADD COLUMN force_work INTEGER NOT NULL DEFAULT 0"
            )
            conn.commit()

        admin = conn.execute("SELECT password FROM admin_settings WHERE id=1").fetchone()
        if not admin:
            from logic import now_tokyo

            conn.execute(
                "INSERT INTO admin_settings(id, password, updated_at) VALUES (1, ?, ?)",
                (DEFAULT_ADMIN_PASSWORD, now_tokyo().isoformat(timespec="seconds")),
            )
            conn.commit()

        emp_count = conn.execute("SELECT COUNT(*) AS c FROM employees").fetchone()["c"]

    # 標準デモ（1001〜1100 / 2026年4月）を空DB時に自動投入
    # Neon でも初回だけ入る。以降はデータが残るので再投入されない。
    if emp_count == 0 and not skip_auto_seed:
        from seed.import_demo import load_demo_data

        load_demo_data(force=True)


def fetchone(sql: str, args: tuple = ()) -> Optional[Any]:
    with get_conn() as conn:
        return conn.execute(sql, args).fetchone()


def fetchall(sql: str, args: tuple = ()) -> list:
    with get_conn() as conn:
        return list(conn.execute(sql, args).fetchall())


def execute(sql: str, args: tuple = ()) -> None:
    with get_conn() as conn:
        conn.execute(sql, args)
        conn.commit()


def executemany(sql: str, args_list: list) -> None:
    with get_conn() as conn:
        conn.executemany(sql, args_list)
        conn.commit()


def row_to_dict(row: Optional[Any]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return dict(row)
