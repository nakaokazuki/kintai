"""勤怠システム（Flask）。mockup UI + Notion 業務ルール。"""
from __future__ import annotations

import calendar
import csv
import io
import os
import threading
from datetime import date, datetime, timedelta
from functools import wraps
from typing import Any, Optional

from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    session,
)

import db
from logic import (
    break_shortage,
    day_status_label,
    format_hhmm,
    is_zero_clock_pair,
    month_key,
    now_tokyo,
    overtime_minutes,
    parse_hhmm,
    parse_month_key,
    today_tokyo,
)


def can_submit_month(year: int, month: int) -> bool:
    """提出日の制限なし（いつでも提出可）。未入力チェックは別途行う。"""
    return True

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "kintai-dev-secret-change-me")


WEEKDAYS = "月火水木金土日"


def json_ok(data: Any = None, **extra):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return jsonify(payload)


def json_err(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def require_employee(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        emp_no = session.get("emp_no")
        if not emp_no:
            return json_err("社員番号でログインしてください", 401)
        emp = db.fetchone(
            "SELECT emp_no, name, active FROM employees WHERE emp_no=? AND active=1",
            (emp_no,),
        )
        if not emp:
            session.pop("emp_no", None)
            return json_err("無効な社員です", 401)
        return fn(emp, *args, **kwargs)

    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("admin"):
            return json_err("管理者ログインが必要です", 401)
        return fn(*args, **kwargs)

    return wrapper


def ensure_day(conn, emp_no: str, work_date: str):
    row = conn.execute(
        "SELECT * FROM attendance_days WHERE emp_no=? AND work_date=?",
        (emp_no, work_date),
    ).fetchone()
    if row:
        return row
    if db.USE_POSTGRES:
        conn.execute(
            """INSERT INTO attendance_days(emp_no, work_date) VALUES (?,?)
               ON CONFLICT (emp_no, work_date) DO NOTHING""",
            (emp_no, work_date),
        )
    else:
        conn.execute(
            "INSERT INTO attendance_days(emp_no, work_date) VALUES (?,?)",
            (emp_no, work_date),
        )
    return conn.execute(
        "SELECT * FROM attendance_days WHERE emp_no=? AND work_date=?",
        (emp_no, work_date),
    ).fetchone()


def recalc_day(conn, emp_no: str, work_date: str) -> dict:
    row = ensure_day(conn, emp_no, work_date)
    info = summarize_day_row(row, work_date)
    conn.execute(
        "UPDATE attendance_days SET overtime_minutes=? WHERE emp_no=? AND work_date=?",
        (info["overtime_minutes"], emp_no, work_date),
    )
    return info


def summarize_day_row(row: Optional[Any], work_date: str) -> dict:
    """DBを更新せずに1日分の状態を算出（ダッシュボード高速化用）。"""
    if row is None:
        cin = None
        cout = None
        br = 0
        on_break = False
        force_work = False
        leave_type = ""
        clock_in = ""
        clock_out = ""
    else:
        raw_in = row["clock_in"]
        raw_out = row["clock_out"]
        # DBによっては "0:00:00" 形式になることがある
        clock_in = "" if raw_in is None else str(raw_in).strip()
        clock_out = "" if raw_out is None else str(raw_out).strip()
        cin = parse_hhmm(clock_in)
        cout = parse_hhmm(clock_out)
        br = int(row["break_minutes"] or 0)
        on_break = bool(row["on_break"])
        force_work = bool(row["force_work"]) if "force_work" in row.keys() else False
        leave_type = ""
        if "leave_type" in row.keys() and row["leave_type"]:
            leave_type = str(row["leave_type"])
    ot = overtime_minutes(cout)
    work, required, short, is_short = break_shortage(cin, cout, br)
    label, kind = day_status_label(cin, cout, br, on_break)
    # 0:00/0:00 の埋戻し日は未入力にしない
    if is_zero_clock_pair(clock_in, clock_out):
        label, kind = "OK", "ok"
        is_short = False
        short = 0
        on_break = False
    if leave_type in ("有給", "欠勤"):
        label = leave_type
        kind = "leave"
        is_short = False
        short = 0
    return {
        "work_date": work_date,
        "clock_in": clock_in,
        "clock_out": clock_out,
        "break_minutes": br,
        "on_break": on_break,
        "force_work": force_work,
        "leave_type": leave_type,
        "overtime_minutes": ot,
        "work_minutes": work,
        "required_break": required,
        "shortage": short,
        "break_short": is_short,
        "status": label,
        "status_kind": kind,
    }


def add_log(
    changer: str,
    emp_no: str,
    work_date: Optional[str],
    field: str,
    old: Any,
    new: Any,
    reason: str = "",
    conn=None,
):
    args = (
        now_tokyo().isoformat(timespec="seconds"),
        changer,
        emp_no,
        work_date,
        field,
        "" if old is None else str(old),
        "" if new is None else str(new),
        reason or "",
    )
    sql = """INSERT INTO change_logs(created_at, changer, emp_no, work_date, field_name, old_value, new_value, reason)
           VALUES (?,?,?,?,?,?,?,?)"""
    if conn is not None:
        conn.execute(sql, args)
    else:
        db.execute(sql, args)


def format_log_date(iso: str) -> str:
    """変更履歴の日付表示（例: 2026/9/9）。"""
    day = (iso or "").replace("T", " ")[:10].replace("-", "/")
    parts = day.split("/")
    if len(parts) != 3:
        return day
    try:
        return f"{int(parts[0])}/{int(parts[1])}/{int(parts[2])}"
    except ValueError:
        return day


def _parse_ymd(value: str) -> Optional[tuple]:
    """日付文字列を (year, month, day) に変換。失敗時は None。"""
    raw = (value or "").strip().replace("T", " ")[:10].replace("-", "/").replace(".", "/")
    parts = [p for p in raw.split("/") if p != ""]
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None


def log_date_matches(created_at: str, query: str) -> bool:
    """表示日付に対する検索。'9/9' が '2026/9/10' に誤マッチしないよう月日単位で判定する。"""
    q = (query or "").strip()
    if not q:
        return True
    ymd = _parse_ymd(created_at)
    if not ymd:
        display = format_log_date(created_at)
        return q in display

    year, month, day = ymd
    display = f"{year}/{month}/{day}"
    normalized = q.replace("-", "/").replace(".", "/")
    pieces = [p for p in normalized.split("/") if p != ""]
    try:
        nums = [int(p) for p in pieces if p.isdigit()]
    except ValueError:
        return q in display
    # 数字以外だけのクエリは表示文字列の部分一致
    if len(nums) != len(pieces):
        return q in display or normalized in display

    if len(nums) == 1:
        n = nums[0]
        return n in (year, month, day)
    if len(nums) == 2:
        # 9/9 → 月/日、または 2026/9 → 年/月
        a, b = nums
        if a >= 1000:
            return year == a and month == b
        return month == a and day == b
    if len(nums) >= 3:
        y, m, d = nums[0], nums[1], nums[2]
        return year == y and month == m and day == d
    return False


def text_matches(value: str, query: str) -> bool:
    """空白差を無視した部分一致。"""
    q = (query or "").strip()
    if not q:
        return True
    hay = (value or "").replace(" ", "").replace("　", "")
    needle = q.replace(" ", "").replace("　", "")
    return needle in hay


def get_or_create_submission(emp_no: str, ym: str) -> dict:
    row = db.fetchone(
        "SELECT * FROM monthly_submissions WHERE emp_no=? AND year_month=?",
        (emp_no, ym),
    )
    if not row:
        db.execute(
            "INSERT INTO monthly_submissions(emp_no, year_month, status) VALUES (?,?,?)",
            (emp_no, ym, "未提出"),
        )
        row = db.fetchone(
            "SELECT * FROM monthly_submissions WHERE emp_no=? AND year_month=?",
            (emp_no, ym),
        )
    return dict(row)


def submission_locked(status: str) -> bool:
    return status in ("提出済み", "承認済み")


def apply_day_edits(
    conn,
    *,
    emp_no: str,
    days: list,
    changer: str,
    reason: str,
) -> Optional[str]:
    """日次勤怠を一括更新し変更履歴を残す。エラー時はメッセージ文字列を返す。"""
    from logic import is_business_day

    for item in days:
        wd = item.get("work_date")
        row = ensure_day(conn, emp_no, wd)
        new_in = (item.get("clock_in") or "").strip() or None
        new_out = (item.get("clock_out") or "").strip() or None
        try:
            new_br = int(item.get("break_minutes") or 0)
        except ValueError:
            return f"{wd} の休憩分が不正です"
        if new_in and not parse_hhmm(new_in):
            return f"{wd} の出勤時刻が不正です"
        if new_out and not parse_hhmm(new_out):
            return f"{wd} の退勤時刻が不正です"

        # 土日祝: 手動で「未入力」にすると force_work=1（時刻入力可）
        # 平日: day_mode = work|paid_leave|absent（有給・欠勤）
        day_mode = (item.get("day_mode") or "").strip()
        d = date.fromisoformat(wd)
        old_force = bool(row["force_work"]) if "force_work" in row.keys() else False
        old_leave = ""
        if "leave_type" in row.keys() and row["leave_type"]:
            old_leave = str(row["leave_type"])
        new_leave = old_leave
        if not is_business_day(d):
            if day_mode == "holiday":
                new_force = 0
                new_in = None
                new_out = None
                new_br = 0
                new_leave = ""
            else:
                # 未入力（勤務）または時刻あり
                new_force = 1 if day_mode == "work" or new_in or new_out else 0
                new_leave = ""
        else:
            new_force = 0
            if day_mode == "paid_leave":
                new_leave = "有給"
                new_in = None
                new_out = None
                new_br = 0
            elif day_mode == "absent":
                new_leave = "欠勤"
                new_in = None
                new_out = None
                new_br = 0
            elif day_mode in ("work", "missing", ""):
                new_leave = ""

        for field, old, new in (
            ("出勤", row["clock_in"], new_in),
            ("退勤", row["clock_out"], new_out),
            ("休憩", row["break_minutes"], new_br),
        ):
            old_s = "" if old is None else str(old)
            new_s = "" if new is None else str(new)
            if old_s != new_s:
                add_log(changer, emp_no, wd, field, old_s, new_s, reason, conn=conn)
        if old_force != bool(new_force):
            add_log(
                changer,
                emp_no,
                wd,
                "勤務区分",
                "出勤日" if old_force else "休日",
                "出勤日" if new_force else "休日",
                reason,
                conn=conn,
            )
        if old_leave != new_leave:
            add_log(
                changer,
                emp_no,
                wd,
                "休暇区分",
                old_leave or "未入力",
                new_leave or "未入力",
                reason,
                conn=conn,
            )

        ot = overtime_minutes(parse_hhmm(new_out))
        conn.execute(
            """UPDATE attendance_days
               SET clock_in=?, clock_out=?, break_minutes=?, overtime_minutes=?,
                   on_break=0, break_started_at=NULL, force_work=?, leave_type=?
               WHERE emp_no=? AND work_date=?""",
            (new_in, new_out, new_br, ot, new_force, new_leave, emp_no, wd),
        )
    return None


def fill_empty_business_days(
    conn,
    emp_no: str,
    start: date,
    end: date,
) -> int:
    """指定期間の未入力営業日を 0:00 / 0:00 / 0 / 0 で埋める。本日は対象外。"""
    from logic import is_business_day

    today = today_tokyo()
    if end >= today:
        end = today - timedelta(days=1)
    if start > end:
        return 0

    rows = conn.execute(
        """SELECT work_date, clock_in, clock_out, leave_type
           FROM attendance_days
           WHERE emp_no=? AND work_date >= ? AND work_date <= ?""",
        (emp_no, start.isoformat(), end.isoformat()),
    ).fetchall()
    by_date = {r["work_date"]: r for r in rows}
    filled = 0
    cursor = start
    while cursor <= end:
        if is_business_day(cursor):
            wd = cursor.isoformat()
            existing = by_date.get(wd)
            leave = ""
            cin = ""
            cout = ""
            if existing:
                if "leave_type" in existing.keys() and existing["leave_type"]:
                    leave = str(existing["leave_type"])
                cin = (existing["clock_in"] or "").strip()
                cout = (existing["clock_out"] or "").strip()
            if leave not in ("有給", "欠勤") and not cin and not cout:
                if existing:
                    conn.execute(
                        """UPDATE attendance_days
                           SET clock_in=?, clock_out=?, break_minutes=0,
                               overtime_minutes=0, on_break=0, break_started_at=NULL
                           WHERE emp_no=? AND work_date=?""",
                        ("0:00", "0:00", emp_no, wd),
                    )
                else:
                    conn.execute(
                        """INSERT INTO attendance_days(
                             emp_no, work_date, clock_in, clock_out,
                             break_minutes, overtime_minutes, on_break, force_work, leave_type
                           ) VALUES (?,?,?,?,0,0,0,0,'')""",
                        (emp_no, wd, "0:00", "0:00"),
                    )
                filled += 1
        cursor += timedelta(days=1)
    return filled


def month_days_payload(emp_no: str, year: int, month: int) -> list:
    """対象月の日次一覧。一括SELECTで Neon でも初回表示がタイムアウトしにくくする。"""
    from logic import is_business_day

    days_in_month = calendar.monthrange(year, month)[1]
    today = today_tokyo()
    start = date(year, month, 1)
    end = min(date(year, month, days_in_month), today)
    if start > today:
        return []

    with db.get_conn() as conn:
        fill_empty_business_days(conn, emp_no, start, end)
        conn.commit()

        rows = conn.execute(
            """SELECT emp_no, work_date, clock_in, clock_out, break_minutes,
                      on_break, break_started_at, overtime_minutes, force_work, leave_type
               FROM attendance_days
               WHERE emp_no=? AND work_date >= ? AND work_date <= ?""",
            (emp_no, start.isoformat(), end.isoformat()),
        ).fetchall()
        by_date = {r["work_date"]: r for r in rows}

        result = []
        cursor = start
        while cursor <= end:
            wd = cursor.isoformat()
            info = summarize_day_row(by_date.get(wd), wd)
            info["day"] = cursor.day
            info["weekday"] = WEEKDAYS[cursor.weekday()]
            info["is_weekend"] = cursor.weekday() >= 5
            info["is_holiday"] = not is_business_day(cursor)
            if info["leave_type"] in ("有給", "欠勤"):
                info["status"] = info["leave_type"]
                info["status_kind"] = "leave"
                info["day_mode"] = (
                    "paid_leave" if info["leave_type"] == "有給" else "absent"
                )
                info["break_short"] = False
            elif (
                info["is_holiday"]
                and not info["force_work"]
                and not info["clock_in"]
                and not info["clock_out"]
            ):
                info["status"] = "休日"
                info["status_kind"] = "holiday"
                info["day_mode"] = "holiday"
            else:
                info["day_mode"] = "work"
            result.append(info)
            cursor += timedelta(days=1)
    return result

def missing_and_break_counts(emp_no: str, year: int, month: int) -> tuple:
    from logic import is_business_day

    days = month_days_payload(emp_no, year, month)
    missing = 0
    break_short = 0
    for d in days:
        work_date = date.fromisoformat(d["work_date"])
        if not is_business_day(work_date):
            continue
        if d["status_kind"] == "leave":
            continue
        if d["status_kind"] == "missing":
            missing += 1
        if d["break_short"]:
            break_short += 1
    return missing, break_short, days


# ---------- pages ----------

_schema_ready = False
_seed_started = False
_backfill_started = False
_init_lock = threading.Lock()


def backfill_empty_attendance_zeros() -> dict:
    """今日より前の、出勤・退勤が入っていない営業日を 0:00 / 0:00 / 0 / 0 で埋める。
    本日は打刻できるよう空のままにする。有給・欠勤・休日は対象外。
    """
    today = today_tokyo()
    filled = 0
    with db.get_conn() as conn:
        employees = conn.execute(
            "SELECT emp_no FROM employees WHERE active=1"
        ).fetchall()
        if not employees:
            return {"filled": 0, "employees": 0}

        start_row = conn.execute(
            "SELECT MIN(work_date) AS m FROM attendance_days"
        ).fetchone()
        if start_row and start_row["m"]:
            start = date.fromisoformat(str(start_row["m"])[:10])
        else:
            created = conn.execute(
                "SELECT MIN(created_at) AS m FROM employees"
            ).fetchone()
            if created and created["m"]:
                start = date.fromisoformat(str(created["m"])[:10])
            else:
                start = date(today.year, 1, 1)

        end = today - timedelta(days=1)
        if start > end:
            return {"filled": 0, "employees": len(employees)}

        for emp in employees:
            filled += fill_empty_business_days(conn, emp["emp_no"], start, end)
        conn.commit()
    return {"filled": filled, "employees": len(employees)}

def _backfill_zeros_background() -> None:
    try:
        result = backfill_empty_attendance_zeros()
        print(f"[backfill] empty days as 0:00: {result}", flush=True)
    except Exception as exc:
        print(f"[backfill] failed: {exc}", flush=True)


def _seed_demo_background() -> None:
    try:
        from seed.import_demo import load_demo_data

        result = load_demo_data(force=True)
        print(f"[seed] demo loaded: {result}", flush=True)
        # デモ投入後にも未入力営業日を埋める
        _backfill_zeros_background()
    except Exception as exc:
        print(f"[seed] demo failed: {exc}", flush=True)


@app.before_request
def _init():
    """スキーマは一度だけ。重いデモ投入・埋戻しはバックグラウンドで行い Worker Timeout を防ぐ。"""
    global _schema_ready, _seed_started, _backfill_started
    if _schema_ready and _seed_started and _backfill_started:
        return
    with _init_lock:
        if not _schema_ready:
            db.init_db(skip_auto_seed=True)
            _schema_ready = True
        if not _seed_started:
            _seed_started = True
            row = db.fetchone("SELECT COUNT(*) AS c FROM employees")
            if row and int(row["c"]) == 0:
                threading.Thread(
                    target=_seed_demo_background, name="demo-seed", daemon=True
                ).start()
                _backfill_started = True  # seed スレッド側で backfill する
            else:
                # 既存DB: 未入力の営業日を 0:00 で埋める
                _backfill_started = True
                threading.Thread(
                    target=_backfill_zeros_background,
                    name="zero-backfill",
                    daemon=True,
                ).start()
        elif not _backfill_started:
            _backfill_started = True
            threading.Thread(
                target=_backfill_zeros_background,
                name="zero-backfill",
                daemon=True,
            ).start()

@app.route("/")
def index():
    return render_template("index.html")


# ---------- employee auth / punch ----------


@app.post("/api/employee/login")
def employee_login():
    emp_no = (request.json or {}).get("emp_no", "").strip()
    if not emp_no.isdigit() or len(emp_no) != 4:
        return json_err("社員番号は4桁の数字です")
    emp = db.fetchone(
        "SELECT emp_no, name, active FROM employees WHERE emp_no=?", (emp_no,)
    )
    if not emp or not emp["active"]:
        return json_err("社員番号が見つからないか、無効です")
    session["emp_no"] = emp["emp_no"]
    session.pop("admin", None)
    return json_ok({"emp_no": emp["emp_no"], "name": emp["name"]})


@app.post("/api/employee/logout")
def employee_logout():
    session.pop("emp_no", None)
    return json_ok()


@app.get("/api/employee/me")
@require_employee
def employee_me(emp):
    return json_ok({"emp_no": emp["emp_no"], "name": emp["name"]})


@app.get("/api/employee/today")
@require_employee
def employee_today(emp):
    today = today_tokyo().isoformat()
    ym = month_key(today_tokyo().year, today_tokyo().month)
    with db.get_conn() as conn:
        row = ensure_day(conn, emp["emp_no"], today)
        info = summarize_day_row(row, today)
        # 残業分だけ必要なら更新（毎回フル recalc しない）
        if int(row["overtime_minutes"] or 0) != info["overtime_minutes"]:
            conn.execute(
                "UPDATE attendance_days SET overtime_minutes=? WHERE emp_no=? AND work_date=?",
                (info["overtime_minutes"], emp["emp_no"], today),
            )
        sub = conn.execute(
            "SELECT * FROM monthly_submissions WHERE emp_no=? AND year_month=?",
            (emp["emp_no"], ym),
        ).fetchone()
        if not sub:
            conn.execute(
                "INSERT INTO monthly_submissions(emp_no, year_month, status) VALUES (?,?,?)",
                (emp["emp_no"], ym, "未提出"),
            )
            sub = conn.execute(
                "SELECT * FROM monthly_submissions WHERE emp_no=? AND year_month=?",
                (emp["emp_no"], ym),
            ).fetchone()
        conn.commit()
    return json_ok(
        {"today": info, "submission": db.row_to_dict(sub), "server_date": today}
    )


@app.post("/api/employee/punch")
@require_employee
def employee_punch(emp):
    action = (request.json or {}).get("action")
    now = now_tokyo()
    today = now.date().isoformat()
    hhmm = format_hhmm(now.time())
    ym = month_key(now.year, now.month)

    with db.get_conn() as conn:
        row = ensure_day(conn, emp["emp_no"], today)
        sub = conn.execute(
            "SELECT status FROM monthly_submissions WHERE emp_no=? AND year_month=?",
            (emp["emp_no"], ym),
        ).fetchone()
        status = sub["status"] if sub else "未提出"
        if submission_locked(status):
            return json_err("提出済みのため本人は打刻・修正できません。管理者へ連絡してください")

        if action == "clock_in":
            if row["clock_in"]:
                return json_err("出勤は1日1回のみです")
            conn.execute(
                "UPDATE attendance_days SET clock_in=? WHERE emp_no=? AND work_date=?",
                (hhmm, emp["emp_no"], today),
            )
        elif action == "clock_out":
            if not row["clock_in"]:
                return json_err("先に出勤してください")
            if row["clock_out"]:
                return json_err("退勤は1日1回のみです")
            br = int(row["break_minutes"] or 0)
            if row["on_break"] and row["break_started_at"]:
                started = datetime.fromisoformat(row["break_started_at"])
                br += max(0, int((now - started).total_seconds() // 60))
            ot = overtime_minutes(parse_hhmm(hhmm))
            conn.execute(
                """UPDATE attendance_days
                   SET clock_out=?, on_break=0, break_started_at=NULL, break_minutes=?, overtime_minutes=?
                   WHERE emp_no=? AND work_date=?""",
                (hhmm, br, ot, emp["emp_no"], today),
            )
        elif action == "break_start":
            if not row["clock_in"] or row["clock_out"]:
                return json_err("出勤中のみ休憩できます")
            if row["on_break"]:
                return json_err("すでに休憩中です")
            conn.execute(
                """UPDATE attendance_days SET on_break=1, break_started_at=?
                   WHERE emp_no=? AND work_date=?""",
                (now.isoformat(timespec="seconds"), emp["emp_no"], today),
            )
        elif action == "break_end":
            if not row["on_break"] or not row["break_started_at"]:
                return json_err("休憩中ではありません")
            started = datetime.fromisoformat(row["break_started_at"])
            added = max(0, int((now - started).total_seconds() // 60))
            br = int(row["break_minutes"] or 0) + added
            conn.execute(
                """UPDATE attendance_days
                   SET on_break=0, break_started_at=NULL, break_minutes=?
                   WHERE emp_no=? AND work_date=?""",
                (br, emp["emp_no"], today),
            )
        else:
            return json_err("不明な操作です")

        row2 = conn.execute(
            "SELECT * FROM attendance_days WHERE emp_no=? AND work_date=?",
            (emp["emp_no"], today),
        ).fetchone()
        info = summarize_day_row(row2, today)
        conn.commit()

    return json_ok({"today": info})


@app.get("/api/employee/month")
@require_employee
def employee_month(emp):
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    missing, break_short, days = missing_and_break_counts(emp["emp_no"], year, month)
    sub = get_or_create_submission(emp["emp_no"], ym)
    return json_ok(
        {
            "month": ym,
            "days": days,
            "missing_count": missing,
            "break_short_count": break_short,
            "submission": sub,
            "can_submit_today": can_submit_month(year, month),
        }
    )


@app.post("/api/employee/save-days")
@require_employee
def employee_save_days(emp):
    body = request.json or {}
    ym = body.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    reason = (body.get("reason") or "").strip()
    days = body.get("days") or []
    if not reason:
        return json_err("修正保存には理由が必要です")
    sub = get_or_create_submission(emp["emp_no"], ym)
    if submission_locked(sub["status"]):
        return json_err("提出済みのため本人は修正できません。管理者へ連絡してください")

    with db.get_conn() as conn:
        err = apply_day_edits(
            conn,
            emp_no=emp["emp_no"],
            days=days,
            changer=emp["name"],
            reason=reason,
        )
        if err:
            return json_err(err)
        conn.commit()

    year, month = parse_month_key(ym)
    missing, break_short, day_rows = missing_and_break_counts(emp["emp_no"], year, month)
    return json_ok(
        {
            "days": day_rows,
            "missing_count": missing,
            "break_short_count": break_short,
            "submission": get_or_create_submission(emp["emp_no"], ym),
        }
    )


@app.get("/api/employee/submit-check")
@require_employee
def submit_check(emp):
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    missing, break_short, _ = missing_and_break_counts(emp["emp_no"], year, month)
    sub = get_or_create_submission(emp["emp_no"], ym)
    can = missing == 0 and sub["status"] in ("未提出", "差戻し")
    messages = []
    if missing > 0:
        messages.append(f"未入力が{missing}件あるため提出できません")
    if break_short > 0:
        messages.append(f"休憩不足が{break_short}件あります（警告のみ・提出は可）")
    if sub["status"] == "提出済み":
        messages.append("すでに提出済みです")
    if sub["status"] == "承認済み":
        messages.append("すでに承認済みです")
    return json_ok(
        {
            "month": ym,
            "missing_count": missing,
            "break_short_count": break_short,
            "can_submit": can,
            "submission": sub,
            "messages": messages,
            "can_submit_today": True,
        }
    )


@app.post("/api/employee/submit")
@require_employee
def employee_submit(emp):
    ym = (request.json or {}).get("month") or month_key(
        today_tokyo().year, today_tokyo().month
    )
    year, month = parse_month_key(ym)
    missing, break_short, _ = missing_and_break_counts(emp["emp_no"], year, month)
    if missing > 0:
        return json_err(f"未入力が{missing}件あるため提出できません")
    sub = get_or_create_submission(emp["emp_no"], ym)
    if sub["status"] not in ("未提出", "差戻し"):
        return json_err(f"現在のステータス（{sub['status']}）では提出できません")
    now = now_tokyo().isoformat(timespec="seconds")
    db.execute(
        """UPDATE monthly_submissions
           SET status='提出済み', submitted_at=?, reviewed_at=NULL, reject_reason=NULL
           WHERE emp_no=? AND year_month=?""",
        (now, emp["emp_no"], ym),
    )
    add_log(emp["emp_no"], emp["emp_no"], None, "月次提出", sub["status"], "提出済み", "")
    return json_ok(
        {
            "submission": get_or_create_submission(emp["emp_no"], ym),
            "break_short_count": break_short,
        }
    )


# ---------- admin ----------


@app.post("/api/admin/login")
def admin_login():
    password = (request.json or {}).get("password", "")
    row = db.fetchone("SELECT password FROM admin_settings WHERE id=1")
    if not row or password != row["password"]:
        return json_err("パスワードが違います", 401)
    session["admin"] = True
    session.pop("emp_no", None)
    return json_ok({"admin": True})


@app.post("/api/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return json_ok()


@app.post("/api/admin/reset-password")
def admin_reset_password():
    body = request.json or {}
    if body.get("reset_code") != db.RESET_CODE:
        return json_err("リセットコードが違います", 403)
    new_password = (body.get("new_password") or "").strip()
    if len(new_password) < 4:
        return json_err("新しいパスワードは4文字以上にしてください")
    db.execute(
        "UPDATE admin_settings SET password=?, updated_at=? WHERE id=1",
        (new_password, now_tokyo().isoformat(timespec="seconds")),
    )
    return json_ok(message="パスワードをリセットしました")


@app.get("/api/admin/me")
def admin_me():
    return json_ok({"admin": bool(session.get("admin"))})


@app.get("/api/admin/dashboard")
@require_admin
def admin_dashboard():
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    today = today_tokyo()
    day_param = (request.args.get("date") or "").strip()
    use_day = bool(day_param)
    target_day = None
    if use_day:
        try:
            target_day = date.fromisoformat(day_param)
        except ValueError:
            use_day = False
            target_day = None
        if use_day:
            if target_day.year != year or target_day.month != month:
                use_day = False
                target_day = None
            elif target_day > today:
                target_day = today

    employees = db.fetchall("SELECT emp_no, name FROM employees WHERE active=1 ORDER BY emp_no")
    unsubmitted_list: list[dict] = []
    pending_list: list[dict] = []
    missing_list: list[dict] = []
    break_list: list[dict] = []
    missing_value = 0
    break_value = 0
    from logic import is_business_day

    def emp_label(emp) -> dict:
        return {"emp_no": emp["emp_no"], "name": emp["name"]}

    # 提出状況は1クエリで取得（社員ごとに INSERT しない）
    subs = db.fetchall(
        "SELECT emp_no, status FROM monthly_submissions WHERE year_month=?",
        (ym,),
    )
    sub_map = {s["emp_no"]: s["status"] for s in subs}
    for emp in employees:
        status = sub_map.get(emp["emp_no"], "未提出")
        # 差戻し後は未提出扱い（旧データの「差戻し」ステータスも未提出カウントに含める）
        if status in ("未提出", "差戻し"):
            unsubmitted_list.append(emp_label(emp))
        elif status == "提出済み":
            pending_list.append(emp_label(emp))

    days_in_month = calendar.monthrange(year, month)[1]
    month_start = date(year, month, 1)
    month_end = min(date(year, month, days_in_month), today)

    if use_day and target_day is not None:
        range_start = range_end = target_day
        scope = "day"
        date_out = target_day.isoformat()
    else:
        range_start = month_start
        range_end = month_end
        scope = "month"
        date_out = ""

    # 対象期間の勤怠を一括取得（社員×日の個別クエリをやめて高速化）
    # 埋戻し(fill)はダッシュボードでは行わない（毎回だと Neon 等でタイムアウト→通信エラーになる）
    att_rows = db.fetchall(
        """SELECT emp_no, work_date, clock_in, clock_out, break_minutes, on_break, force_work, leave_type
           FROM attendance_days
           WHERE work_date >= ? AND work_date <= ?""",
        (range_start.isoformat(), range_end.isoformat()),
    )
    att_map: dict[tuple[str, str], Any] = {}
    for r in att_rows:
        att_map[(r["emp_no"], r["work_date"])] = r

    dates: list[date] = []
    cursor = range_start
    while cursor <= range_end:
        dates.append(cursor)
        cursor += timedelta(days=1)

    for emp in employees:
        emp_missing = 0
        emp_break = 0
        for d in dates:
            wd = d.isoformat()
            row = att_map.get((emp["emp_no"], wd))
            info = summarize_day_row(row, wd)
            holiday = not is_business_day(d)
            # 過去の未入力営業日は 0:00 埋戻し済みと同じ扱い（読み取り専用・タイムアウト防止）
            if (
                not holiday
                and d < today
                and info["status_kind"] == "missing"
                and info.get("leave_type") not in ("有給", "欠勤")
                and not (info.get("clock_in") or "").strip()
                and not (info.get("clock_out") or "").strip()
            ):
                info["status"] = "OK"
                info["status_kind"] = "ok"
                info["break_short"] = False
            if info["status_kind"] == "leave":
                pass
            elif (
                holiday
                and not info["force_work"]
                and not info["clock_in"]
                and not info["clock_out"]
            ):
                info["status"] = "休日"
                info["status_kind"] = "holiday"
                info["break_short"] = False

            if scope == "day":
                if is_business_day(d) and info["status_kind"] == "missing":
                    missing_list.append(emp_label(emp))
                if info["break_short"]:
                    break_list.append(emp_label(emp))
            else:
                if not is_business_day(d):
                    continue
                if info["status_kind"] == "leave":
                    continue
                if info["status_kind"] == "missing":
                    emp_missing += 1
                if info["break_short"]:
                    emp_break += 1

        if scope == "month":
            if emp_missing > 0:
                missing_list.append(emp_label(emp))
                missing_value += emp_missing
            if emp_break > 0:
                break_list.append(emp_label(emp))
                break_value += emp_break

    if scope == "day":
        missing_value = len(missing_list)
        break_value = len(break_list)

    return json_ok(
        {
            "month": ym,
            "date": date_out,
            "scope": scope,
            "range_start": range_start.isoformat(),
            "range_end": range_end.isoformat(),
            "kpi": {
                "unsubmitted": len(unsubmitted_list),
                "pending": len(pending_list),
                "missing": missing_value,
                "break_short": break_value,
            },
            "lists": {
                "unsubmitted": unsubmitted_list,
                "pending": pending_list,
                "missing": missing_list,
                "break_short": break_list,
            },
        }
    )


@app.get("/api/admin/list")
@require_admin
def admin_list():
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    status_filter = request.args.get("status", "")
    emp_q = (request.args.get("emp_no") or "").strip()
    employees = db.fetchall("SELECT emp_no, name FROM employees WHERE active=1 ORDER BY emp_no")
    rows = []
    for emp in employees:
        if emp_q and emp_q not in emp["emp_no"]:
            continue
        sub = get_or_create_submission(emp["emp_no"], ym)
        missing, br, days = missing_and_break_counts(emp["emp_no"], year, month)
        # 一覧は社員単位＋問題日の代表行
        label = sub["status"]
        kind = "ok"
        sample_day = "—"
        cin = cout = br_m = "—"
        if br > 0:
            label = "休憩不足"
            kind = "break"
            for d in days:
                if d["break_short"]:
                    sample_day = str(d["day"])
                    cin = d["clock_in"] or "—"
                    cout = d["clock_out"] or "—"
                    br_m = str(d["break_minutes"])
                    break
        elif missing > 0 and sub["status"] == "未提出":
            label = "未提出"
            kind = "missing"
        elif sub["status"] == "提出済み":
            label = "提出済"
        if status_filter:
            mapping = {
                "未提出": sub["status"] == "未提出",
                "提出済み": sub["status"] == "提出済み",
                "承認済み": sub["status"] == "承認済み",
                "差戻し": sub["status"] == "差戻し",
                "休憩不足": br > 0,
            }
            if not mapping.get(status_filter, True):
                continue
        rows.append(
            {
                "emp_no": emp["emp_no"],
                "name": emp["name"],
                "day": sample_day,
                "clock_in": cin,
                "clock_out": cout,
                "break_minutes": br_m,
                "status": label,
                "status_kind": kind,
                "submission_status": sub["status"],
                "missing_count": missing,
                "break_short_count": br,
            }
        )
    return json_ok({"month": ym, "rows": rows})


@app.get("/api/admin/detail")
@require_admin
def admin_detail():
    emp_no = request.args.get("emp_no", "")
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    emp = db.fetchone("SELECT * FROM employees WHERE emp_no=?", (emp_no,))
    if not emp:
        return json_err("社員が見つかりません", 404)
    days = month_days_payload(emp_no, year, month)
    total_work = sum(d["work_minutes"] for d in days)
    total_ot = sum(d["overtime_minutes"] for d in days)
    sub = get_or_create_submission(emp_no, ym)
    return json_ok(
        {
            "employee": {"emp_no": emp["emp_no"], "name": emp["name"]},
            "month": ym,
            "days": days,
            "summary": {
                "work_hours": round(total_work / 60, 1),
                "overtime_hours": round(total_ot / 60, 1),
            },
            "submission": sub,
        }
    )


@app.post("/api/admin/approve")
@require_admin
def admin_approve():
    body = request.json or {}
    emp_no = body.get("emp_no")
    ym = body.get("month")
    sub = get_or_create_submission(emp_no, ym)
    if sub["status"] != "提出済み":
        return json_err("提出済みの月のみ承認できます")
    now = now_tokyo().isoformat(timespec="seconds")
    db.execute(
        """UPDATE monthly_submissions SET status='承認済み', reviewed_at=?, reject_reason=NULL
           WHERE emp_no=? AND year_month=?""",
        (now, emp_no, ym),
    )
    add_log("管理者", emp_no, None, "承認", sub["status"], "承認済み", "")
    return json_ok({"submission": get_or_create_submission(emp_no, ym)})


@app.post("/api/admin/reject")
@require_admin
def admin_reject():
    body = request.json or {}
    emp_no = body.get("emp_no")
    ym = body.get("month")
    reason = (body.get("reason") or "").strip()
    if not reason:
        return json_err("差戻しには理由が必要です")
    sub = get_or_create_submission(emp_no, ym)
    if sub["status"] != "提出済み":
        return json_err("提出済みの月のみ差戻しできます")
    now = now_tokyo().isoformat(timespec="seconds")
    db.execute(
        """UPDATE monthly_submissions
           SET status='未提出', submitted_at=NULL, reviewed_at=?, reject_reason=?
           WHERE emp_no=? AND year_month=?""",
        (now, reason, emp_no, ym),
    )
    add_log("管理者", emp_no, None, "差戻し", sub["status"], "未提出", reason)
    return json_ok({"submission": get_or_create_submission(emp_no, ym)})


@app.post("/api/admin/save-days")
@require_admin
def admin_save_days():
    body = request.json or {}
    emp_no = body.get("emp_no")
    ym = body.get("month")
    reason = (body.get("reason") or "").strip()
    days = body.get("days") or []
    if not reason:
        return json_err("修正保存には理由が必要です")
    emp = db.fetchone("SELECT * FROM employees WHERE emp_no=?", (emp_no,))
    if not emp:
        return json_err("社員が見つかりません", 404)

    with db.get_conn() as conn:
        err = apply_day_edits(
            conn,
            emp_no=emp_no,
            days=days,
            changer="管理者",
            reason=reason,
        )
        if err:
            return json_err(err)
        conn.commit()

    year, month = parse_month_key(ym)
    return json_ok({"days": month_days_payload(emp_no, year, month)})


@app.get("/api/admin/logs")
@require_admin
def admin_logs():
    q_date = (request.args.get("date") or "").strip()
    q_emp = (request.args.get("emp") or "").strip()
    q_changer = (request.args.get("changer") or "").strip()
    q_reason = (request.args.get("reason") or "").strip()
    rows = db.fetchall(
        "SELECT * FROM change_logs ORDER BY id DESC LIMIT 500"
    )
    emp_rows = db.fetchall("SELECT emp_no, name FROM employees")
    emp_names = {e["emp_no"]: e["name"] for e in emp_rows}
    out = []
    for r in rows:
        # 通常打刻は変更履歴に含めない（後からの修正・承認・差戻しのみ）
        if (r["reason"] or "") == "打刻":
            continue
        emp_no = r["emp_no"] or ""
        name = emp_names.get(emp_no) or emp_no
        created = r["created_at"] or ""
        reason = r["reason"] or ""
        field_name = r["field_name"] or ""
        work_date = r["work_date"] or ""

        if q_date and not log_date_matches(created, q_date):
            continue
        if q_emp and not (text_matches(name, q_emp) or text_matches(emp_no, q_emp)):
            continue
        if q_changer and not text_matches(r["changer"] or "", q_changer):
            continue
        # 理由／ステータス列＋変更項目も部分一致対象
        if q_reason and not (
            text_matches(reason, q_reason) or text_matches(field_name, q_reason)
        ):
            continue
        out.append(
            {
                "created_at": created,
                "display_date": format_log_date(created),
                "changer": r["changer"] or "",
                "employee": name,
                "field_name": field_name,
                "old_value": r["old_value"] or "—",
                "new_value": r["new_value"] or "—",
                "reason": reason,
                "work_date": work_date,
            }
        )
    return json_ok({"rows": out})


@app.get("/api/admin/employees")
@require_admin
def admin_employees():
    rows = db.fetchall("SELECT emp_no, name, active FROM employees ORDER BY emp_no")
    return json_ok({"employees": [dict(r) for r in rows]})


@app.post("/api/admin/employees")
@require_admin
def admin_add_employee():
    body = request.json or {}
    emp_no = (body.get("emp_no") or "").strip()
    name = (body.get("name") or "").strip()
    if not emp_no.isdigit() or len(emp_no) != 4:
        return json_err("社員番号は4桁です")
    if not name:
        return json_err("氏名を入力してください")
    exists = db.fetchone("SELECT emp_no FROM employees WHERE emp_no=?", (emp_no,))
    if exists:
        return json_err("その社員番号は既に存在します")
    db.execute(
        "INSERT INTO employees(emp_no, name, active, created_at) VALUES (?,?,1,?)",
        (emp_no, name, now_tokyo().isoformat(timespec="seconds")),
    )
    add_log("管理者", emp_no, None, "社員追加", "", name, "")
    return json_ok()


@app.post("/api/admin/employees/<emp_no>/deactivate")
@require_admin
def admin_deactivate(emp_no):
    db.execute("UPDATE employees SET active=0 WHERE emp_no=?", (emp_no,))
    add_log("管理者", emp_no, None, "社員無効化", "有効", "無効", "")
    return json_ok()


@app.post("/api/admin/employees/<emp_no>/activate")
@require_admin
def admin_activate(emp_no):
    emp = db.fetchone("SELECT emp_no FROM employees WHERE emp_no=?", (emp_no,))
    if not emp:
        return json_err("社員が見つかりません", 404)
    db.execute("UPDATE employees SET active=1 WHERE emp_no=?", (emp_no,))
    add_log("管理者", emp_no, None, "社員有効化", "無効", "有効", "")
    return json_ok()


@app.get("/api/admin/csv")
@require_admin
def admin_csv():
    """ダッシュボードで選んだ対象月のみをCSV出力する（他月は含めない）。"""
    from logic import is_business_day

    ym = (request.args.get("month") or "").strip() or month_key(
        today_tokyo().year, today_tokyo().month
    )
    year, month = parse_month_key(ym)
    ym_label = f"{year}/{month}"
    today = today_tokyo()
    days_in_month = calendar.monthrange(year, month)[1]
    start = date(year, month, 1)
    end = min(date(year, month, days_in_month), today)

    employees = db.fetchall(
        "SELECT emp_no, name FROM employees WHERE active=1 ORDER BY emp_no"
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["年月", "社員番号", "氏名", "日付", "出勤", "退勤", "休憩分", "残業分", "状態", "提出ステータス"]
    )

    if start <= today and employees:
        att_rows = db.fetchall(
            """SELECT emp_no, work_date, clock_in, clock_out, break_minutes,
                      on_break, break_started_at, overtime_minutes, force_work, leave_type
               FROM attendance_days
               WHERE work_date >= ? AND work_date <= ?""",
            (start.isoformat(), end.isoformat()),
        )
        att_map = {(r["emp_no"], r["work_date"]): r for r in att_rows}
        sub_rows = db.fetchall(
            "SELECT emp_no, status FROM monthly_submissions WHERE year_month=?",
            (ym,),
        )
        sub_map = {r["emp_no"]: r["status"] for r in sub_rows}

        for emp in employees:
            sub_status = sub_map.get(emp["emp_no"], "未提出")
            cursor = start
            while cursor <= end:
                wd = cursor.isoformat()
                info = summarize_day_row(att_map.get((emp["emp_no"], wd)), wd)
                if info["leave_type"] in ("有給", "欠勤"):
                    status = info["leave_type"]
                elif (
                    not is_business_day(cursor)
                    and not info["force_work"]
                    and not info["clock_in"]
                    and not info["clock_out"]
                ):
                    status = "休日"
                else:
                    status = info["status"]
                writer.writerow(
                    [
                        ym_label,
                        emp["emp_no"],
                        emp["name"],
                        format_log_date(wd),
                        info["clock_in"] or "",
                        info["clock_out"] or "",
                        info["break_minutes"],
                        info["overtime_minutes"],
                        status,
                        sub_status,
                    ]
                )
                cursor += timedelta(days=1)

    output = buf.getvalue()
    return Response(
        "\ufeff" + output,
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=kintai_{ym}.csv"
        },
    )


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    # macOS の AirPlay が 5000 を使うため、ローカル既定は 5001
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=True)
