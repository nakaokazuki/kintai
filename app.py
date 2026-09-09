"""勤怠システム（Flask）。mockup UI + Notion 業務ルール。"""
from __future__ import annotations

import calendar
import csv
import io
import os
from datetime import date, datetime
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
    can_submit_month as can_submit_month_strict,
    day_status_label,
    format_hhmm,
    month_key,
    now_tokyo,
    overtime_minutes,
    parse_hhmm,
    parse_month_key,
    today_tokyo,
)


def can_submit_month(year: int, month: int) -> bool:
    """Notionどおり厳格にする場合は KINTAI_STRICT_SUBMIT=1。"""
    if os.environ.get("KINTAI_STRICT_SUBMIT", "0") == "1":
        return can_submit_month_strict(year, month)
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
            "SELECT * FROM employees WHERE emp_no=? AND active=1", (emp_no,)
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
    cin = parse_hhmm(row["clock_in"])
    cout = parse_hhmm(row["clock_out"])
    br = int(row["break_minutes"] or 0)
    ot = overtime_minutes(cout)
    conn.execute(
        "UPDATE attendance_days SET overtime_minutes=? WHERE emp_no=? AND work_date=?",
        (ot, emp_no, work_date),
    )
    work, required, short, is_short = break_shortage(cin, cout, br)
    label, kind = day_status_label(cin, cout, br, bool(row["on_break"]))
    return {
        "work_date": work_date,
        "clock_in": row["clock_in"] or "",
        "clock_out": row["clock_out"] or "",
        "break_minutes": br,
        "on_break": bool(row["on_break"]),
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


def log_date_matches(created_at: str, query: str) -> bool:
    """画面表記（2026/9/9）や 2026-09-09 などで検索できるようにする。"""
    q = (query or "").strip()
    if not q:
        return True
    display = format_log_date(created_at)
    if q in display or q in (created_at or ""):
        return True
    # 2026-09-09 / 2026/09/09 → 2026/9/9 に正規化して部分一致
    normalized = q.replace("-", "/").replace(".", "/")
    pieces = normalized.split("/")
    try:
        norm_parts = [str(int(p)) if p.isdigit() else p for p in pieces if p != ""]
    except ValueError:
        return False
    if not norm_parts:
        return False
    q_norm = "/".join(norm_parts)
    return q_norm in display


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


def month_days_payload(emp_no: str, year: int, month: int) -> list:
    days_in_month = calendar.monthrange(year, month)[1]
    today = today_tokyo()
    result = []
    with db.get_conn() as conn:
        for day in range(1, days_in_month + 1):
            d = date(year, month, day)
            if d > today:
                continue
            # 土日祝も一覧に出す（未入力判定は平日のみ厳しくしてもよいが、
            # Notionは当月の不足一覧なので平日営業日のみ未入力カウント）
            wd = d.isoformat()
            info = recalc_day(conn, emp_no, wd)
            info["day"] = day
            info["weekday"] = WEEKDAYS[d.weekday()]
            info["is_weekend"] = d.weekday() >= 5
            result.append(info)
        conn.commit()
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
        if d["status_kind"] == "missing":
            missing += 1
        if d["break_short"]:
            break_short += 1
    return missing, break_short, days


# ---------- pages ----------


@app.before_request
def _init():
    db.init_db()


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
    with db.get_conn() as conn:
        info = recalc_day(conn, emp["emp_no"], today)
        conn.commit()
    ym = month_key(today_tokyo().year, today_tokyo().month)
    sub = get_or_create_submission(emp["emp_no"], ym)
    return json_ok({"today": info, "submission": sub, "server_date": today})


@app.post("/api/employee/punch")
@require_employee
def employee_punch(emp):
    action = (request.json or {}).get("action")
    now = now_tokyo()
    today = now.date().isoformat()
    hhmm = format_hhmm(now.time())

    with db.get_conn() as conn:
        row = ensure_day(conn, emp["emp_no"], today)
        ym = month_key(now.year, now.month)
        sub = conn.execute(
            "SELECT * FROM monthly_submissions WHERE emp_no=? AND year_month=?",
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
            conn.execute(
                """UPDATE attendance_days
                   SET clock_out=?, on_break=0, break_started_at=NULL, break_minutes=?
                   WHERE emp_no=? AND work_date=?""",
                (hhmm, br, emp["emp_no"], today),
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

        info = recalc_day(conn, emp["emp_no"], today)
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


@app.get("/api/employee/submit-check")
@require_employee
def submit_check(emp):
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    missing, break_short, _ = missing_and_break_counts(emp["emp_no"], year, month)
    sub = get_or_create_submission(emp["emp_no"], ym)
    allowed_day = can_submit_month(year, month)
    can = (
        missing == 0
        and allowed_day
        and sub["status"] in ("未提出", "差戻し")
    )
    messages = []
    if not allowed_day:
        messages.append("提出できるのは翌月の最初の営業日のみです")
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
            "can_submit_today": allowed_day,
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
    if not can_submit_month(year, month):
        return json_err("提出できるのは翌月の最初の営業日のみです")
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
    employees = db.fetchall("SELECT emp_no, name FROM employees WHERE active=1 ORDER BY emp_no")
    unsubmitted = 0
    pending = 0
    missing_people = 0
    break_total = 0
    for emp in employees:
        sub = get_or_create_submission(emp["emp_no"], ym)
        if sub["status"] == "未提出":
            unsubmitted += 1
        elif sub["status"] == "提出済み":
            pending += 1
        missing, br, _ = missing_and_break_counts(emp["emp_no"], year, month)
        break_total += br
        if missing > 0:
            missing_people += 1
    return json_ok(
        {
            "month": ym,
            "kpi": {
                "unsubmitted": unsubmitted,
                "pending": pending,
                "missing": missing_people,
                "break_short": break_total,
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
        """UPDATE monthly_submissions SET status='差戻し', reviewed_at=?, reject_reason=?
           WHERE emp_no=? AND year_month=?""",
        (now, reason, emp_no, ym),
    )
    add_log("管理者", emp_no, None, "差戻し", sub["status"], "差戻し", reason)
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
        for item in days:
            wd = item.get("work_date")
            row = ensure_day(conn, emp_no, wd)
            new_in = (item.get("clock_in") or "").strip() or None
            new_out = (item.get("clock_out") or "").strip() or None
            try:
                new_br = int(item.get("break_minutes") or 0)
            except ValueError:
                return json_err(f"{wd} の休憩分が不正です")
            if new_in and not parse_hhmm(new_in):
                return json_err(f"{wd} の出勤時刻が不正です")
            if new_out and not parse_hhmm(new_out):
                return json_err(f"{wd} の退勤時刻が不正です")

            for field, old, new in (
                ("出勤", row["clock_in"], new_in),
                ("退勤", row["clock_out"], new_out),
                ("休憩", row["break_minutes"], new_br),
            ):
                old_s = "" if old is None else str(old)
                new_s = "" if new is None else str(new)
                if old_s != new_s:
                    add_log("管理者", emp_no, wd, field, old_s, new_s, reason, conn=conn)

            ot = overtime_minutes(parse_hhmm(new_out))
            conn.execute(
                """UPDATE attendance_days
                   SET clock_in=?, clock_out=?, break_minutes=?, overtime_minutes=?,
                       on_break=0, break_started_at=NULL
                   WHERE emp_no=? AND work_date=?""",
                (new_in, new_out, new_br, ot, emp_no, wd),
            )
        conn.commit()

    year, month = parse_month_key(ym)
    return json_ok({"days": month_days_payload(emp_no, year, month)})


@app.get("/api/admin/logs")
@require_admin
def admin_logs():
    q_date = (request.args.get("date") or "").strip()
    q_emp = (request.args.get("emp") or "").strip()
    q_changer = (request.args.get("changer") or "").strip()
    rows = db.fetchall(
        "SELECT * FROM change_logs ORDER BY id DESC LIMIT 500"
    )
    out = []
    for r in rows:
        # 通常打刻は変更履歴に含めない（後からの修正・承認・差戻しのみ）
        if (r["reason"] or "") == "打刻":
            continue
        emp = db.fetchone("SELECT name FROM employees WHERE emp_no=?", (r["emp_no"],))
        name = emp["name"] if emp else r["emp_no"]
        created = r["created_at"]
        if not log_date_matches(created, q_date):
            continue
        if q_emp and q_emp not in r["emp_no"] and q_emp not in name:
            continue
        if q_changer and q_changer not in r["changer"]:
            continue
        out.append(
            {
                "created_at": created,
                "display_date": format_log_date(created),
                "changer": r["changer"],
                "employee": f"{name}（{r['emp_no']}）",
                "field_name": r["field_name"],
                "old_value": r["old_value"] or "—",
                "new_value": r["new_value"] or "—",
                "reason": r["reason"] or "",
                "work_date": r["work_date"] or "",
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


@app.get("/api/admin/csv")
@require_admin
def admin_csv():
    ym = request.args.get("month") or month_key(today_tokyo().year, today_tokyo().month)
    year, month = parse_month_key(ym)
    employees = db.fetchall("SELECT emp_no, name FROM employees WHERE active=1 ORDER BY emp_no")
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["年月", "社員番号", "氏名", "日付", "出勤", "退勤", "休憩分", "残業分", "状態", "提出ステータス"]
    )
    for emp in employees:
        sub = get_or_create_submission(emp["emp_no"], ym)
        days = month_days_payload(emp["emp_no"], year, month)
        for d in days:
            writer.writerow(
                [
                    ym,
                    emp["emp_no"],
                    emp["name"],
                    d["work_date"],
                    d["clock_in"] or "",
                    d["clock_out"] or "",
                    d["break_minutes"],
                    d["overtime_minutes"],
                    d["status"],
                    sub["status"],
                ]
            )
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
