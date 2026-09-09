"""デモ勤怠データを seed/demo.tsv から取り込む。

使い方:
  cd test && .venv/bin/python seed/import_demo.py
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import db
from logic import now_tokyo, overtime_minutes, parse_hhmm, minutes_between, required_break_minutes


def default_break(clock_in: str, clock_out: str) -> int:
    """デモ用: 在社時間に応じた法令必要休憩を入れる（不足デモを避ける）。"""
    cin = parse_hhmm(clock_in)
    cout = parse_hhmm(clock_out)
    if not cin or not cout:
        return 0
    span = minutes_between(cin, cout)
    # 労働時間 ≒ 在社 - 休憩 なので、必要休憩を満たすよう設定
    # span - br = work; required(work) <= br
    for br in (60, 45, 0):
        work = max(0, span - br)
        if required_break_minutes(work) <= br:
            return br
    return 60


def main() -> None:
    tsv = Path(__file__).with_name("demo.tsv")
    if not tsv.exists():
        raise SystemExit(f"missing {tsv}")

    db.init_db()
    now = now_tokyo().isoformat(timespec="seconds")

    employees: dict[str, str] = {}
    rows: list[tuple] = []
    with tsv.open(encoding="utf-8") as f:
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

        # 管理者パスワードは維持（無ければ 7777）
        admin = conn.execute("SELECT password FROM admin_settings WHERE id=1").fetchone()
        if not admin:
            conn.execute(
                "INSERT INTO admin_settings(id, password, updated_at) VALUES (1, ?, ?)",
                ("7777", now),
            )
        conn.commit()

    print(f"employees: {len(employees)}")
    print(f"attendance rows: {len(rows)}")
    print("done")


if __name__ == "__main__":
    main()
