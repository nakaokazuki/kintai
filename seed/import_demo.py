"""標準デモ勤怠データを seed/demo.tsv から取り込む。

使い方:
  .venv/bin/python seed/import_demo.py

DBが空のときはアプリ起動時（db.init_db）でも自動投入される。
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import db
from logic import now_tokyo, overtime_minutes, parse_hhmm, minutes_between, required_break_minutes

TSV_PATH = Path(__file__).with_name("demo.tsv")


def default_break(clock_in: str, clock_out: str) -> int:
    """デモ用: 在社時間に応じた法令必要休憩を入れる（不足デモを避ける）。"""
    cin = parse_hhmm(clock_in)
    cout = parse_hhmm(clock_out)
    if not cin or not cout:
        return 0
    span = minutes_between(cin, cout)
    for br in (60, 45, 0):
        work = max(0, span - br)
        if required_break_minutes(work) <= br:
            return br
    return 60


def load_demo_data(*, force: bool = False) -> dict:
    """demo.tsv を標準データとして投入する。

    force=False のとき、社員が既にあれば何もしない。
    """
    if not TSV_PATH.exists():
        raise FileNotFoundError(f"missing {TSV_PATH}")

    db.init_db(skip_auto_seed=True)
    with db.get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM employees").fetchone()["c"]
        if count > 0 and not force:
            return {"skipped": True, "employees": count, "attendance_rows": 0}

    now = now_tokyo().isoformat(timespec="seconds")
    employees: dict[str, str] = {}
    rows: list[tuple] = []
    with TSV_PATH.open(encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for r in reader:
            emp_no = r["社員番号"].strip()
            name = r["氏名"].strip()
            work_date = r["日付"].strip()
            clock_in = r["出勤時刻"].strip()
            clock_out = r["退勤時刻"].strip()
            employees[emp_no] = name
            br = default_break(clock_in, clock_out)
            ot = overtime_minutes(parse_hhmm(clock_out))
            rows.append((emp_no, work_date, clock_in, clock_out, br, ot))

    with db.get_conn() as conn:
        conn.execute("DELETE FROM change_logs")
        conn.execute("DELETE FROM monthly_submissions")
        conn.execute("DELETE FROM attendance_days")
        conn.execute("DELETE FROM employees")

        for emp_no, name in sorted(employees.items()):
            conn.execute(
                "INSERT INTO employees(emp_no, name, active, created_at) VALUES (?,?,1,?)",
                (emp_no, name, now),
            )

        conn.executemany(
            """INSERT INTO attendance_days(
                 emp_no, work_date, clock_in, clock_out, break_minutes,
                 on_break, break_started_at, overtime_minutes
               ) VALUES (?,?,?,?,?,0,NULL,?)""",
            rows,
        )

        admin = conn.execute("SELECT password FROM admin_settings WHERE id=1").fetchone()
        if not admin:
            conn.execute(
                "INSERT INTO admin_settings(id, password, updated_at) VALUES (1, ?, ?)",
                (db.DEFAULT_ADMIN_PASSWORD, now),
            )
        conn.commit()

    return {
        "skipped": False,
        "employees": len(employees),
        "attendance_rows": len(rows),
    }


def main() -> None:
    result = load_demo_data(force=True)
    print(f"employees: {result['employees']}")
    print(f"attendance rows: {result['attendance_rows']}")
    print("done")


if __name__ == "__main__":
    main()
