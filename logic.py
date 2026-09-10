"""勤怠の業務ルール（Notion 確定ルールに準拠）。"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Optional, Tuple

import jpholiday

WORK_END = time(19, 0)
TZ_NAME = "Asia/Tokyo"


def now_tokyo() -> datetime:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(TZ_NAME))
    except Exception:
        return datetime.now()


def today_tokyo() -> date:
    return now_tokyo().date()


def is_business_day(d: date) -> bool:
    if d.weekday() >= 5:
        return False
    if jpholiday.is_holiday(d):
        return False
    return True


def first_business_day_of_month(year: int, month: int) -> date:
    d = date(year, month, 1)
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def can_submit_month(target_year: int, target_month: int, on: Optional[date] = None) -> bool:
    """提出はいつでも可能（日付制限なし）。互換のため関数は残す。"""
    return True


def parse_hhmm(value: Optional[str]) -> Optional[time]:
    if not value:
        return None
    value = value.strip()
    if not value or value == "—":
        return None
    parts = value.split(":")
    if len(parts) != 2:
        return None
    try:
        return time(int(parts[0]), int(parts[1]))
    except ValueError:
        return None


def format_hhmm(t: Optional[time]) -> str:
    if t is None:
        return ""
    return f"{t.hour:02d}:{t.minute:02d}"


def minutes_between(start: time, end: time) -> int:
    s = start.hour * 60 + start.minute
    e = end.hour * 60 + end.minute
    return max(0, e - s)


def overtime_minutes(clock_out: Optional[time]) -> int:
    """退勤時刻の 19:00 超過分。"""
    if clock_out is None:
        return 0
    end_m = WORK_END.hour * 60 + WORK_END.minute
    out_m = clock_out.hour * 60 + clock_out.minute
    return max(0, out_m - end_m)


def work_minutes(clock_in: Optional[time], clock_out: Optional[time], break_minutes: int) -> int:
    if clock_in is None or clock_out is None:
        return 0
    return max(0, minutes_between(clock_in, clock_out) - max(0, break_minutes))


def required_break_minutes(work_mins: int) -> int:
    """6超〜8以下→45／8超→60。労働6時間以下は0。"""
    if work_mins > 8 * 60:
        return 60
    if work_mins > 6 * 60:
        return 45
    return 0


def break_shortage(
    clock_in: Optional[time], clock_out: Optional[time], break_minutes: int
) -> Tuple[int, int, int, bool]:
    """戻り値: (労働分, 必要休憩分, 不足分, 不足か)"""
    # 法令判定は「出勤〜退勤から休憩を引いた労働時間」だが、
    # 必要休憩の判定は労働時間に対して行う。不足判定時は実績休憩と比較。
    # Notion: 出勤〜退勤から算出した労働時間 vs 実休憩合計
    if clock_in is None or clock_out is None:
        return 0, 0, 0, False
    span = minutes_between(clock_in, clock_out)
    work = max(0, span - max(0, break_minutes))
    required = required_break_minutes(work)
    # 労働時間がちょうど境界付近のとき、休憩を足すと労働が減る循環があるため
    # 「休憩込みの在社時間」ベースでも再評価する
    work_gross = span  # 在社
    # 法令は「労働時間」なので休憩控除後。控除後で必要休憩を出し、実績と比較。
    short = max(0, required - max(0, break_minutes))
    return work, required, short, short > 0 and required > 0


def day_status_label(
    clock_in: Optional[time],
    clock_out: Optional[time],
    break_minutes: int,
    on_break: bool = False,
) -> Tuple[str, str]:
    """(表示ラベル, css種別: ok|missing|break)"""
    if clock_in is None or clock_out is None or on_break:
        return "未入力", "missing"
    _, _, _, is_short = break_shortage(clock_in, clock_out, break_minutes)
    if is_short:
        return "休憩不足", "break"
    return "OK", "ok"


def month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def parse_month_key(key: str) -> Tuple[int, int]:
    y, m = key.split("-")
    return int(y), int(m)
