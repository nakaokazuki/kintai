"""SQLite 初期化・アクセス。"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Optional

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.environ.get("DATABASE_PATH", DATA_DIR / "kintai.db"))

DEFAULT_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
RESET_CODE = os.environ.get("ADMIN_RESET_CODE", "RESET-KINTAI-2026")


def get_conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(DB_PATH), detect_types=sqlite3.PARSE_DECLTYPES, timeout=30
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
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
        )
        row = conn.execute("SELECT COUNT(*) AS c FROM employees").fetchone()
        if row["c"] == 0:
            from logic import now_tokyo

            now = now_tokyo().isoformat(timespec="seconds")
            seed = [
                ("1001", "山田 太郎"),
                ("1002", "佐藤 花子"),
                ("1003", "鈴木 一郎"),
            ]
            conn.executemany(
                "INSERT INTO employees(emp_no, name, active, created_at) VALUES (?,?,1,?)",
                [(e, n, now) for e, n in seed],
            )
        admin = conn.execute("SELECT password FROM admin_settings WHERE id=1").fetchone()
        if not admin:
            from logic import now_tokyo

            conn.execute(
                "INSERT INTO admin_settings(id, password, updated_at) VALUES (1, ?, ?)",
                (DEFAULT_ADMIN_PASSWORD, now_tokyo().isoformat(timespec="seconds")),
            )


def fetchone(sql: str, args: tuple = ()) -> Optional[sqlite3.Row]:
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


def row_to_dict(row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return dict(row)
