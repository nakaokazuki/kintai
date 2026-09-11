(function () {
  var state = {
    role: null,
    emp: null,
    today: null,
    empMonth: null,
    adminMonth: null,
    adminDay: null,
    dashboardLists: null,
    dashboardScope: "month",
    detailEmp: null,
    pendingAdminScreen: null,
    empBusy: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function currentMonthKey() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }

  function defaultMonthKey() {
    return currentMonthKey();
  }

  function shiftMonth(ym, delta) {
    var parts = ym.split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) + delta;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    return y + "-" + pad(m);
  }

  function monthLabel(ym) {
    var p = ym.split("-");
    return p[0] + "/" + parseInt(p[1], 10);
  }

  /** 2026-09-09 → 2026/9/9 */
  function formatDisplayDate(isoDate) {
    if (!isoDate) return "—";
    var day = String(isoDate).replace("T", " ").slice(0, 10).replace(/-/g, "/");
    var parts = day.split("/");
    if (parts.length !== 3) return day;
    return (
      parseInt(parts[0], 10) +
      "/" +
      parseInt(parts[1], 10) +
      "/" +
      parseInt(parts[2], 10)
    );
  }

  /** 2026-09-09 → 9/9 */
  function formatMonthDay(isoDate) {
    if (!isoDate) return "—";
    var parts = String(isoDate).replace("T", " ").slice(0, 10).split("-");
    if (parts.length !== 3) return String(isoDate);
    return parseInt(parts[1], 10) + "/" + parseInt(parts[2], 10);
  }

  function todayIsoLocal() {
    var today = new Date();
    return (
      today.getFullYear() +
      "-" +
      pad(today.getMonth() + 1) +
      "-" +
      pad(today.getDate())
    );
  }

  /** 対象月の既定日。当月なら当日、それ以外は月合計（空） */
  function defaultDayForMonth(ym) {
    var t = todayIsoLocal();
    if (t.slice(0, 7) === ym) return t;
    return "";
  }

  function monthRangeEndIso(ym) {
    var parts = ym.split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var last = new Date(y, m, 0).getDate();
    var endIso = ym + "-" + pad(last);
    var t = todayIsoLocal();
    return endIso > t ? t : endIso;
  }

  function missingBreakScopeLabel(kind) {
    var base = kind === "break_short" ? "休憩不足" : "未入力";
    if (state.adminDay) {
      return formatMonthDay(state.adminDay) + "の" + base;
    }
    var ym = state.adminMonth || defaultMonthKey();
    var startMd = parseInt(ym.split("-")[1], 10) + "/1";
    var endIso = state.dashboardRangeEnd || monthRangeEndIso(ym);
    return startMd + "~" + formatMonthDay(endIso) + "の" + base;
  }

  function updateMissingBreakLabels() {
    var missingLabel = $("kpi-missing-label");
    var breakLabel = $("kpi-break-label");
    if (missingLabel) missingLabel.textContent = missingBreakScopeLabel("missing");
    if (breakLabel) breakLabel.textContent = missingBreakScopeLabel("break_short");
  }

  async function api(url, options) {
    options = options || {};
    options.headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );
    var res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      if (e && e.name === "AbortError") {
        throw e;
      }
      throw new Error("通信エラー");
    }
    var text = await res.text();
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (res.status === 502 || res.status === 504 || res.status === 524) {
        throw new Error("サーバーが混み合っています。少し待って再試行してください");
      }
      throw new Error("通信エラー（応答 " + res.status + "）");
    }
    if (!data.ok) {
      throw new Error(data.error || "エラー");
    }
    return data.data;
  }

  function withError(fn) {
    return async function () {
      try {
        await fn.apply(null, arguments);
      } catch (e) {
        if (e && e.name === "AbortError") return;
        alert(e.message || String(e));
      }
    };
  }

  function setSessionLabel() {
    /* 上部ヘッダー削除後も呼び出し互換のため残す */
  }

  function isEmployeeActive() {
    var empId = ($("emp-id").value || "").trim();
    return !!(state.emp && empId && empId === state.emp.emp_no);
  }

  function setEmployeeNavEnabled(on) {
    $("btn-goto-e02").disabled = !on;
    $("btn-emp-submit").disabled = !on;
  }

  var EMP_STORAGE_KEY = "kintai_emp_no";

  function saveEmpNoLocal(empNo) {
    try {
      if (empNo) localStorage.setItem(EMP_STORAGE_KEY, String(empNo));
      else localStorage.removeItem(EMP_STORAGE_KEY);
    } catch (e) {}
  }

  function loadEmpNoLocal() {
    try {
      return (localStorage.getItem(EMP_STORAGE_KEY) || "").trim();
    } catch (e) {
      return "";
    }
  }

  function applyEmployeeLogin(data) {
    state.role = "employee";
    var sameEmp = state.emp && state.emp.emp_no === data.emp_no;
    state.emp = {
      emp_no: data.emp_no,
      name: data.name || ""
    };
    // 同じ社員の再確認では、月次一覧で選んでいる月を維持する
    if (!sameEmp || !state.empMonth) {
      state.empMonth = defaultMonthKey();
    }
    $("emp-id").value = data.emp_no;
    saveEmpNoLocal(data.emp_no);
    $("e01-identity").textContent =
      "氏名：" + (data.name || "—") + "　番号：" + data.emp_no;
    setSessionLabel();
    setEmployeeNavEnabled(true);
  }

  /** 確認ボタン相当：セッションを確立し、提出できる状態にする */
  async function ensureEmployeeSession(empNoOpt) {
    var emp_no = (empNoOpt || ($("emp-id").value || "")).trim();
    if (!emp_no) return false;
    var data = await api("/api/employee/login", {
      method: "POST",
      body: JSON.stringify({ emp_no: emp_no })
    });
    if (!data || !data.emp_no) return false;
    applyEmployeeLogin(data);
    await refreshToday();
    setEmployeeNavEnabled(true);
    return isEmployeeActive();
  }

  function resetEmployeeUi() {
    state.emp = null;
    state.today = null;
    if (state.role === "employee") state.role = null;
    $("e01-identity").textContent = "氏名：—　番号：—";
    $("e01-today-title").textContent = "本日";
    $("alert-break").classList.add("is-hidden");
    updatePunchButtons(null);
    setEmployeeNavEnabled(false);
  }

  async function logoutEmployee() {
    resetEmployeeUi();
    try {
      await api("/api/employee/logout", { method: "POST" });
    } catch (e) {}
  }

  function syncEmployeeLoginFromInput() {
    if (state.empBusy) return;
    var empId = ($("emp-id").value || "").trim();
    if (!empId) {
      saveEmpNoLocal("");
      if (state.emp) {
        logoutEmployee();
      } else {
        resetEmployeeUi();
      }
      var e02 = document.getElementById("e02");
      if (e02 && e02.classList.contains("is-visible")) {
        showScreen("e01");
      }
      return;
    }
    if (state.emp && empId !== state.emp.emp_no) {
      logoutEmployee();
    }
  }

  function isAdminScreen(id) {
    return ["a01", "a03", "a04", "a05"].indexOf(id) >= 0;
  }

  function showScreen(id) {
    if (isAdminScreen(id) && state.role !== "admin") {
      state.pendingAdminScreen = id;
      openAdminModal();
      return;
    }
    if (id === "e02" && !isEmployeeActive()) {
      alert("先に社員番号を確認してください");
      id = "e01";
    }

    document.querySelectorAll(".screen").forEach(function (el) {
      el.classList.toggle("is-visible", el.id === id);
    });
    document.querySelectorAll(".nav-btn").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.screen === id);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (id === "e01" && isEmployeeActive()) refreshToday();
    if (id === "e02") {
      withError(function () {
        return withLoading(refreshEmpMonth, "月次一覧を読み込んでいます");
      })();
    }
    if (id === "a01") {
      withError(function () {
        return withLoading(refreshDashboard);
      })();
    }
    if (id === "a03") {
      if (state.detailEmp) {
        withError(function () {
          return withLoading(function () {
            return refreshDetail(state.detailEmp);
          });
        })();
      }
      /* 社員未選択時は空のまま（A-05の氏名クリックで遷移） */
    }
    if (id === "a04") {
      withError(function () {
        return withLoading(function () {
          return refreshLogs({ searching: false });
        }, "検索しています");
      })();
    }
    if (id === "a05") {
      withError(function () {
        return withLoading(refreshEmployees);
      })();
    }
  }

  function updatePunchButtons(today) {
    var work = $("btn-work");
    var br = $("btn-break");
    if (!today) {
      work.disabled = true;
      br.disabled = true;
      return;
    }
    if (!today.clock_in) {
      work.textContent = "出勤";
      work.className = "btn btn-punch btn-in";
      work.disabled = false;
      br.disabled = true;
      br.textContent = "休憩開始";
      br.className = "btn btn-punch btn-secondary";
    } else if (!today.clock_out) {
      work.textContent = "退勤";
      work.className = "btn btn-punch btn-out";
      work.disabled = false;
      br.disabled = false;
      if (today.on_break) {
        br.textContent = "休憩終了";
        br.className = "btn btn-punch btn-out";
      } else {
        br.textContent = "休憩開始";
        br.className = "btn btn-punch btn-break";
      }
    } else {
      work.textContent = "退勤済";
      work.className = "btn btn-punch btn-secondary";
      work.disabled = true;
      br.disabled = true;
      br.textContent = "休憩開始";
      br.className = "btn btn-punch btn-secondary";
    }

    var breakAlert = $("alert-break");
    if (today.break_short) {
      breakAlert.classList.remove("is-hidden");
      breakAlert.textContent =
        "⚠ 休憩不足：必要" +
        today.required_break +
        "分／実績" +
        today.break_minutes +
        "分／不足" +
        today.shortage +
        "分";
    } else {
      breakAlert.classList.add("is-hidden");
    }
  }

  async function refreshToday() {
    if (!isEmployeeActive()) {
      updatePunchButtons(null);
      setEmployeeNavEnabled(false);
      return;
    }
    var emp = state.emp;
    var data = await api("/api/employee/today");
    // 通信中に入力変更でログアウトされた場合は中断
    if (!state.emp || !emp || state.emp.emp_no !== emp.emp_no) {
      return;
    }
    state.today = data.today;
    $("e01-identity").textContent =
      "氏名：" + (emp.name || "—") + "　番号：" + (emp.emp_no || "—");
    $("e01-today-title").textContent = "本日 " + formatDisplayDate(data.server_date);
    updatePunchButtons(data.today);
    setEmployeeNavEnabled(true);
  }

  async function refreshEmpMonth() {
    if (!isEmployeeActive()) {
      alert("先に社員番号を確認してください");
      showScreen("e01");
      return;
    }
    if (!state.empMonth) state.empMonth = defaultMonthKey();
    var body = $("e02-body");
    try {
      var data = await api("/api/employee/month?month=" + state.empMonth);
    } catch (err) {
      body.innerHTML =
        "<tr><td colspan=\"6\">読み込みに失敗しました。もう一度開いてください。</td></tr>";
      throw err;
    }
    $("e02-title").textContent = monthLabel(state.empMonth) + "の月次一覧";
    $("e02-status").textContent = data.submission.status;
    var editable =
      data.submission.status === "未提出" || data.submission.status === "差戻し";
    $("e02-edit-block").classList.toggle("is-hidden", !editable);
    body.innerHTML = "";
    if (!data.days || data.days.length === 0) {
      body.innerHTML =
        "<tr><td colspan=\"6\">表示できる日がありません（未来月は空です）</td></tr>";
      return;
    }
    data.days.forEach(function (d) {
      var tr = document.createElement("tr");
      if (d.status_kind === "missing") tr.className = "row-missing";
      if (d.status_kind === "break") tr.className = "row-break";
      if (d.status_kind === "holiday") tr.className = "row-holiday";
      if (d.status_kind === "leave") tr.className = "row-leave";
      tr.dataset.workDate = d.work_date;
      tr.dataset.isHoliday = d.is_holiday ? "1" : "0";
      var statusText =
        d.status === "休憩不足"
          ? "休不足"
          : d.status === "休日"
            ? "休日"
            : d.status === "未入力"
              ? "本日未入力"
              : d.status;
      if (editable) {
        var statusCell;
        if (d.is_holiday) {
          var mode = d.day_mode === "work" ? "work" : "holiday";
          statusCell =
            '<select class="input e02-mode">' +
            '<option value="holiday"' +
            (mode === "holiday" ? " selected" : "") +
            ">休日</option>" +
            '<option value="work"' +
            (mode === "work" ? " selected" : "") +
            ">本日未入力</option>" +
            "</select>";
        } else if (d.status_kind === "missing" || d.status_kind === "leave") {
          var leaveMode =
            d.day_mode === "paid_leave"
              ? "paid_leave"
              : d.day_mode === "absent"
                ? "absent"
                : "work";
          statusCell =
            '<select class="input e02-mode">' +
            '<option value="work"' +
            (leaveMode === "work" ? " selected" : "") +
            ">本日未入力</option>" +
            '<option value="paid_leave"' +
            (leaveMode === "paid_leave" ? " selected" : "") +
            ">有給</option>" +
            '<option value="absent"' +
            (leaveMode === "absent" ? " selected" : "") +
            ">欠勤</option>" +
            "</select>";
        } else {
          statusCell = statusText;
        }
        var timeDisabled =
          (d.is_holiday && d.day_mode !== "work") ||
          d.day_mode === "paid_leave" ||
          d.day_mode === "absent";
        tr.innerHTML =
          "<td>" +
          formatDisplayDate(d.work_date) +
          '</td><td><input class="a03-cell e02-in" value="' +
          (d.clock_in || "") +
          '" placeholder="—" ' +
          (timeDisabled ? "disabled " : "") +
          '/></td><td><input class="a03-cell e02-out" value="' +
          (d.clock_out || "") +
          '" placeholder="—" ' +
          (timeDisabled ? "disabled " : "") +
          '/></td><td><input class="a03-cell e02-br" value="' +
          (d.clock_in || d.clock_out ? d.break_minutes : "") +
          '" placeholder="—" ' +
          (timeDisabled ? "disabled " : "") +
          "/></td><td>" +
          (d.clock_out ? d.overtime_minutes : "—") +
          "</td><td>" +
          statusCell +
          "</td>";
      } else {
        tr.innerHTML =
          "<td>" +
          formatDisplayDate(d.work_date) +
          "</td><td>" +
          (d.clock_in || "—") +
          "</td><td>" +
          (d.clock_out || "—") +
          "</td><td>" +
          (d.clock_in ? d.break_minutes : "—") +
          "</td><td>" +
          (d.clock_out ? d.overtime_minutes : "—") +
          "</td><td>" +
          statusText +
          "</td>";
      }
      body.appendChild(tr);
      if (editable) {
        var modeSel = tr.querySelector(".e02-mode");
        if (modeSel) {
          modeSel.addEventListener("change", function () {
            var v = modeSel.value;
            var disable =
              v === "holiday" || v === "paid_leave" || v === "absent";
            tr.classList.toggle("row-holiday", v === "holiday");
            tr.classList.toggle("row-leave", v === "paid_leave" || v === "absent");
            tr.classList.toggle("row-missing", v === "work");
            ["e02-in", "e02-out", "e02-br"].forEach(function (cls) {
              var inp = tr.querySelector("." + cls);
              inp.disabled = disable;
              if (disable) inp.value = "";
            });
          });
        }
      }
    });
  }

  function fillMonthSelect(selectId, selected) {
    var sel = $(selectId);
    sel.innerHTML = "";
    var end = "2026-12";
    var cursor = "2026-01";
    var guard = 0;
    while (guard < 48) {
      var opt = document.createElement("option");
      opt.value = cursor;
      opt.textContent = monthLabel(cursor);
      if (cursor === selected) opt.selected = true;
      sel.appendChild(opt);
      if (cursor === end) break;
      cursor = shiftMonth(cursor, 1);
      guard += 1;
    }
  }

  function selectedAdminMonth() {
    var sel = $("a01-month");
    var v = (sel && sel.value) || state.adminMonth || currentMonthKey();
    state.adminMonth = v;
    return v;
  }

  function updateCsvButtonLabel() {
    var btn = $("btn-csv");
    if (!btn) return;
    var ym = state.adminMonth || currentMonthKey();
    btn.textContent = "CSV出力（" + monthLabel(ym) + "）";
  }

  function fillDaySelect(ym, selectedIso) {
    var sel = $("a01-day");
    sel.innerHTML = "";
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "選択なし（月合計）";
    sel.appendChild(none);

    var parts = ym.split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var last = new Date(y, m, 0).getDate();
    var todayIso = todayIsoLocal();
    var pick;
    if (selectedIso === null || selectedIso === undefined) {
      pick = defaultDayForMonth(ym);
    } else {
      pick = selectedIso;
    }
    if (pick && pick.slice(0, 7) !== ym) {
      pick = "";
    }
    for (var d = 1; d <= last; d++) {
      var iso = ym + "-" + pad(d);
      if (iso > todayIso) continue;
      var opt = document.createElement("option");
      opt.value = iso;
      opt.textContent = formatDisplayDate(iso);
      if (iso === pick) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!pick) {
      none.selected = true;
    }
    state.adminDay = sel.value;
  }

  var dashboardAbort = null;

  async function refreshDashboard() {
    if (!state.adminMonth) state.adminMonth = defaultMonthKey();
    fillMonthSelect("a01-month", state.adminMonth);
    fillDaySelect(state.adminMonth, state.adminDay);
    updateCsvButtonLabel();
    if (dashboardAbort) {
      try {
        dashboardAbort.abort();
      } catch (e) {}
    }
    dashboardAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    var signal = dashboardAbort ? dashboardAbort.signal : undefined;
    var data;
    try {
      data = await api(
        "/api/admin/dashboard?month=" +
          encodeURIComponent(state.adminMonth) +
          "&date=" +
          encodeURIComponent(state.adminDay || ""),
        signal ? { signal: signal } : {}
      );
    } catch (e) {
      if (e && e.name === "AbortError") return;
      throw e;
    }
    state.adminDay = data.date || "";
    state.dashboardScope = data.scope || "month";
    state.dashboardRangeEnd = data.range_end || monthRangeEndIso(state.adminMonth);
    if ($("a01-day").value !== state.adminDay) {
      fillDaySelect(state.adminMonth, state.adminDay);
    }
    state.dashboardLists = data.lists || {};
    $("kpi-unsubmitted").textContent = data.kpi.unsubmitted + "人";
    $("kpi-pending").textContent = data.kpi.pending + "人";
    $("kpi-missing").textContent = data.kpi.missing + "件";
    $("kpi-break").textContent = data.kpi.break_short + "件";
    updateMissingBreakLabels();
  }

  var KPI_TITLES = {
    unsubmitted: "未提出の社員",
    pending: "承認待ちの社員",
    missing: "未入力",
    break_short: "休憩不足"
  };

  function showKpiDetail(kind) {
    var panel = $("a01-kpi-detail");
    var list = $("a01-kpi-detail-list");
    var title = $("a01-kpi-detail-title");
    var rows = (state.dashboardLists && state.dashboardLists[kind]) || [];
    var label;
    if (kind === "missing" || kind === "break_short") {
      label = missingBreakScopeLabel(kind);
    } else {
      label = (KPI_TITLES[kind] || kind) + "（" + monthLabel(state.adminMonth) + "）";
    }
    title.textContent = label;
    list.innerHTML = "";
    if (!rows.length) {
      var empty = document.createElement("li");
      empty.className = "kpi-detail-empty";
      empty.textContent = "該当する社員はいません";
      list.appendChild(empty);
    } else {
      rows.forEach(function (e) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-nav kpi-emp-link";
        btn.textContent = e.name + "（" + e.emp_no + "）";
        btn.addEventListener("click", function () {
          state.detailEmp = e.emp_no;
          showScreen("a03");
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
    }
    panel.classList.remove("is-hidden");
  }

  async function refreshDetail(empNo) {
    var data = await api(
      "/api/admin/detail?emp_no=" +
        encodeURIComponent(empNo) +
        "&month=" +
        encodeURIComponent(state.adminMonth || currentMonthKey())
    );
    $("a03-month").textContent = monthLabel(data.month);
    $("a03-employee").textContent =
      data.employee.name.replace(/\s/g, "") + "（" + data.employee.emp_no + "）";
    $("a03-badge").textContent = data.submission.status;
    $("a03-badge").className =
      data.submission.status === "承認済み" || data.submission.status === "提出済み"
        ? "badge badge-ok"
        : "badge";
    $("a03-work").innerHTML =
      data.summary.work_hours + '<span class="a03-unit">h</span>';
    $("a03-ot").innerHTML =
      data.summary.overtime_hours + '<span class="a03-unit">h</span>';
    var body = $("a03-body");
    body.innerHTML = "";
    data.days.forEach(function (d) {
      var tr = document.createElement("tr");
      if (d.status_kind === "missing") tr.className = "is-missing-row";
      if (d.status_kind === "break") tr.className = "is-break-row";
      if (d.status_kind === "holiday") tr.className = "is-holiday-row";
      if (d.status_kind === "leave") tr.className = "is-leave-row";
      tr.dataset.workDate = d.work_date;
      tr.dataset.isHoliday = d.is_holiday ? "1" : "0";
      var statusClass =
        d.status_kind === "ok"
          ? "is-ok"
          : d.status_kind === "break"
            ? "is-break"
            : d.status_kind === "holiday"
              ? "is-leave"
              : d.status_kind === "leave"
                ? "is-paid"
                : "is-missing";
      var statusCell;
      if (d.is_holiday) {
        var mode = d.day_mode === "work" ? "work" : "holiday";
        statusCell =
          '<select class="input a03-mode">' +
          '<option value="holiday"' +
          (mode === "holiday" ? " selected" : "") +
          ">休日</option>" +
          '<option value="work"' +
          (mode === "work" ? " selected" : "") +
          ">未入力</option>" +
          "</select>";
      } else if (d.status_kind === "missing" || d.status_kind === "leave") {
        var leaveMode =
          d.day_mode === "paid_leave"
            ? "paid_leave"
            : d.day_mode === "absent"
              ? "absent"
              : "work";
        statusCell =
          '<select class="input a03-mode">' +
          '<option value="work"' +
          (leaveMode === "work" ? " selected" : "") +
          ">未入力</option>" +
          '<option value="paid_leave"' +
          (leaveMode === "paid_leave" ? " selected" : "") +
          ">有給</option>" +
          '<option value="absent"' +
          (leaveMode === "absent" ? " selected" : "") +
          ">欠勤</option>" +
          "</select>";
      } else {
        statusCell =
          '<span class="a03-status ' +
          statusClass +
          '">' +
          d.status +
          "</span>";
      }
      var timeDisabled =
        (d.is_holiday && d.day_mode !== "work") ||
        d.day_mode === "paid_leave" ||
        d.day_mode === "absent";
      tr.innerHTML =
        "<td>" +
        formatDisplayDate(d.work_date) +
        "</td><td>" +
        d.weekday +
        '</td><td><input class="a03-cell a03-in" value="' +
        (d.clock_in || "") +
        '" placeholder="—" ' +
        (timeDisabled ? "disabled " : "") +
        '/></td><td><input class="a03-cell a03-out" value="' +
        (d.clock_out || "") +
        '" placeholder="—" ' +
        (timeDisabled ? "disabled " : "") +
        '/></td><td><input class="a03-cell a03-br" value="' +
        (d.clock_in || d.clock_out ? d.break_minutes : "") +
        '" placeholder="—" ' +
        (timeDisabled ? "disabled " : "") +
        "/></td><td>" +
        statusCell +
        "</td>";
      body.appendChild(tr);
      var modeSel = tr.querySelector(".a03-mode");
      if (modeSel) {
        modeSel.addEventListener("change", function () {
          var v = modeSel.value;
          var disable =
            v === "holiday" || v === "paid_leave" || v === "absent";
          tr.classList.toggle("is-holiday-row", v === "holiday");
          tr.classList.toggle(
            "is-leave-row",
            v === "paid_leave" || v === "absent"
          );
          tr.classList.toggle("is-missing-row", v === "work");
          ["a03-in", "a03-out", "a03-br"].forEach(function (cls) {
            var inp = tr.querySelector("." + cls);
            inp.disabled = disable;
            if (disable) inp.value = "";
          });
        });
      }
    });
    state.detailEmp = empNo;
  }

  var logsSearchTimer = null;
  var logsSearchSeq = 0;

  async function refreshLogs(opts) {
    opts = opts || {};
    var searching = !!opts.searching;
    var seq = ++logsSearchSeq;
    var body = $("a04-body");
    if (searching) {
      body.innerHTML =
        '<tr><td colspan="7">検索しています</td></tr>';
    }
    var q =
      "/api/admin/logs?date=" +
      encodeURIComponent($("a04-date").value || "") +
      "&changer=" +
      encodeURIComponent($("a04-changer").value || "") +
      "&emp=" +
      encodeURIComponent($("a04-emp").value || "") +
      "&reason=" +
      encodeURIComponent($("a04-reason").value || "");
    var data = await api(q);
    if (seq !== logsSearchSeq) return;
    body.innerHTML = "";
    if (!data.rows || data.rows.length === 0) {
      body.innerHTML =
        '<tr><td colspan="7">該当する変更履歴はありません</td></tr>';
      return;
    }
    data.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var day = r.display_date || formatDisplayDate(r.created_at);
      tr.innerHTML =
        "<td>" +
        day +
        "</td><td>" +
        r.changer +
        "</td><td>" +
        r.employee +
        "</td><td>" +
        r.field_name +
        "</td><td>" +
        r.old_value +
        "</td><td>" +
        r.new_value +
        "</td><td>" +
        r.reason +
        "</td>";
      body.appendChild(tr);
    });
  }

  function scheduleLogsSearch() {
    if (logsSearchTimer) clearTimeout(logsSearchTimer);
    logsSearchTimer = setTimeout(function () {
      logsSearchTimer = null;
      withError(function () {
        return refreshLogs({ searching: true });
      })();
    }, 250);
  }

  async function refreshEmployees() {
    var data = await api("/api/admin/employees");
    var body = $("a05-body");
    body.innerHTML = "";
    data.employees.forEach(function (e) {
      var tr = document.createElement("tr");
      var tdNo = document.createElement("td");
      tdNo.textContent = e.emp_no;
      var tdName = document.createElement("td");
      var nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "btn btn-nav emp-name-link";
      nameBtn.textContent = e.name;
      nameBtn.addEventListener("click", function () {
        state.detailEmp = e.emp_no;
        if (!state.adminMonth) state.adminMonth = defaultMonthKey();
        showScreen("a03");
      });
      tdName.appendChild(nameBtn);
      var tdStatus = document.createElement("td");
      tdStatus.textContent = e.active ? "有効" : "無効";
      var tdAction = document.createElement("td");
      if (e.active) {
        var btnOff = document.createElement("button");
        btnOff.type = "button";
        btnOff.className = "btn btn-tiny btn-warn";
        btnOff.textContent = "無効化";
        btnOff.addEventListener(
          "click",
          withError(async function () {
            if (!confirm(e.emp_no + " を無効化しますか？")) return;
            await withLoading(async function () {
              await api("/api/admin/employees/" + e.emp_no + "/deactivate", {
                method: "POST",
                body: "{}"
              });
              await refreshEmployees();
            }, "無効化しています");
          })
        );
        tdAction.appendChild(btnOff);
      } else {
        var btnOn = document.createElement("button");
        btnOn.type = "button";
        btnOn.className = "btn btn-tiny btn-ok";
        btnOn.textContent = "有効化";
        btnOn.addEventListener(
          "click",
          withError(async function () {
            if (!confirm(e.emp_no + " を有効化しますか？")) return;
            await withLoading(async function () {
              await api("/api/admin/employees/" + e.emp_no + "/activate", {
                method: "POST",
                body: "{}"
              });
              await refreshEmployees();
            }, "有効化しています");
          })
        );
        tdAction.appendChild(btnOn);
      }
      tr.appendChild(tdNo);
      tr.appendChild(tdName);
      tr.appendChild(tdStatus);
      tr.appendChild(tdAction);
      body.appendChild(tr);
    });
  }

  async function openSubmitModal() {
    var data;
    try {
      data = await withLoading(async function () {
        var ready = await ensureEmployeeSession();
        if (!ready || !isEmployeeActive()) {
          throw new Error("先に社員番号を確認してください");
        }
        var month = state.empMonth || currentMonthKey();
        return api("/api/employee/submit-check?month=" + month);
      }, "提出前チェックを読み込んでいます");
    } catch (e) {
      alert(e.message || "提出前チェックに失敗しました");
      return;
    }
    var list = $("submit-checklist");
    list.innerHTML = "";
    var li1 = document.createElement("li");
    li1.className = data.missing_count > 0 ? "bad" : "";
    li1.innerHTML =
      "未入力：" +
      data.missing_count +
      "件 → " +
      (data.missing_count > 0 ? "<strong>提出不可</strong>" : "OK");
    list.appendChild(li1);
    var li2 = document.createElement("li");
    li2.className = data.break_short_count > 0 ? "warn" : "";
    li2.textContent =
      "休憩不足：" +
      data.break_short_count +
      "件 → " +
      (data.break_short_count > 0 ? "警告（提出は可）" : "OK");
    list.appendChild(li2);
    $("submit-status-line").textContent =
      "現在ステータス：" + data.submission.status;
    $("submit-hint").textContent =
      data.messages.join("。") ||
      (data.can_submit ? "問題なければ提出してください。" : "");
    var btn = $("btn-do-submit");
    btn.disabled = !data.can_submit;
    btn.textContent = data.can_submit
      ? "提出する"
      : "提出する（未入力あり）";
    $("submit-modal").classList.remove("is-hidden");
  }

  function closeSubmitModal() {
    $("submit-modal").classList.add("is-hidden");
  }

  function openAdminModal() {
    $("admin-modal").classList.remove("is-hidden");
  }

  function closeAdminModal() {
    $("admin-modal").classList.add("is-hidden");
    state.pendingAdminScreen = null;
  }

  // --- events ---
  $("btn-emp-confirm").addEventListener(
    "click",
    withError(async function () {
      var emp_no = $("emp-id").value.trim();
      if (!emp_no) {
        await logoutEmployee();
        alert("社員番号を入力してください");
        return;
      }
      state.empBusy = true;
      showLoading("社員情報を確認しています");
      try {
        var ok = await ensureEmployeeSession(emp_no);
        if (!ok) {
          throw new Error("ログインに失敗しました");
        }
      } finally {
        hideLoading();
        state.empBusy = false;
      }
    })
  );

  $("emp-id").addEventListener("input", function () {
    syncEmployeeLoginFromInput();
  });
  $("emp-id").addEventListener("change", function () {
    syncEmployeeLoginFromInput();
  });

  $("btn-admin-login").addEventListener(
    "click",
    withError(async function () {
      await withLoading(async function () {
        await api("/api/admin/login", {
          method: "POST",
          body: JSON.stringify({ password: $("login-admin-pass").value })
        });
      }, "ログインしています");
      state.role = "admin";
      state.adminMonth = defaultMonthKey();
      updateCsvButtonLabel();
      setSessionLabel();
      var next = state.pendingAdminScreen || "a01";
      $("admin-modal").classList.add("is-hidden");
      state.pendingAdminScreen = null;
      showScreen(next);
    })
  );

  $("btn-reset").addEventListener(
    "click",
    withError(async function () {
      await withLoading(async function () {
        await api("/api/admin/reset-password", {
          method: "POST",
          body: JSON.stringify({
            reset_code: $("reset-code").value,
            new_password: $("reset-new").value
          })
        });
      }, "パスワードをリセットしています");
      alert("パスワードをリセットしました");
    })
  );

  function nowHhmm() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  var busyDepth = 0;
  var punchSaving = false;

  function ensureBusyModal() {
    var modal = $("punch-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "punch-modal";
    modal.className = "modal is-hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML =
      '<div class="modal-backdrop"></div>' +
      '<div class="modal-panel modal-panel-compact">' +
      '<h2 id="punch-modal-title" class="card-title">読み込み中</h2>' +
      '<p class="hint" id="punch-modal-msg">処理しています。しばらくお待ちください。</p>' +
      "</div>";
    document.body.appendChild(modal);
    return modal;
  }

  function showBusy(title, message) {
    busyDepth++;
    punchSaving = true;
    ensureBusyModal();
    var titleEl = $("punch-modal-title");
    var msgEl = $("punch-modal-msg");
    var modal = $("punch-modal");
    var panel = modal ? modal.querySelector(".modal-panel-compact") : null;
    var msg = message || "";
    if (titleEl) titleEl.textContent = title || "読み込み中";
    if (msgEl) {
      msgEl.textContent = msg;
      msgEl.classList.toggle("is-hidden", !msg);
    }
    if (panel) panel.classList.toggle("is-single-line", !msg);
    if (modal) modal.classList.remove("is-hidden");
  }

  function hideBusy(okMessage) {
    ensureBusyModal();
    var titleEl = $("punch-modal-title");
    var msgEl = $("punch-modal-msg");
    var modal = $("punch-modal");
    var panel = modal ? modal.querySelector(".modal-panel-compact") : null;

    function finish() {
      busyDepth = Math.max(0, busyDepth - 1);
      if (busyDepth > 0) return;
      if (modal) modal.classList.add("is-hidden");
      punchSaving = false;
    }

    if (okMessage && busyDepth <= 1 && titleEl && msgEl && modal) {
      titleEl.textContent = okMessage;
      msgEl.textContent = "";
      msgEl.classList.add("is-hidden");
      if (panel) panel.classList.add("is-single-line");
      setTimeout(finish, 600);
      return;
    }
    finish();
  }

  function showPunchSaving(message) {
    showBusy(
      message || "記録しています",
      ""
    );
  }

  function hidePunchSaving(okMessage) {
    hideBusy(okMessage);
  }

  function showLoading(message) {
    showBusy(message || "読み込み中", "");
  }

  function hideLoading() {
    hideBusy();
  }

  async function withLoading(fn, message) {
    showLoading(message);
    try {
      return await fn();
    } finally {
      hideLoading();
    }
  }

  window.addEventListener("beforeunload", function (e) {
    if (!punchSaving) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.querySelectorAll("[data-action]").forEach(function (el) {
    el.addEventListener(
      "click",
      withError(async function () {
        var action = el.dataset.action;
        if (action === "work") {
          if (!isEmployeeActive()) {
            alert("先に社員番号を確認してください");
            return;
          }
          var today = state.today || {};
          var punch = !today.clock_in
            ? "clock_in"
            : !today.clock_out
              ? "clock_out"
              : null;
          if (!punch) return;
          var prev = {
            clock_in: today.clock_in || "",
            clock_out: today.clock_out || "",
            break_minutes: today.break_minutes || 0,
            on_break: !!today.on_break,
            break_short: !!today.break_short,
            required_break: today.required_break || 0,
            shortage: today.shortage || 0,
            overtime_minutes: today.overtime_minutes || 0,
            status: today.status || "",
            status_kind: today.status_kind || ""
          };
          var optimistic = Object.assign({}, prev);
          if (punch === "clock_in") optimistic.clock_in = nowHhmm();
          if (punch === "clock_out") {
            optimistic.clock_out = nowHhmm();
            optimistic.on_break = false;
          }
          state.today = optimistic;
          updatePunchButtons(optimistic);
          $("btn-work").disabled = true;
          showPunchSaving(
            punch === "clock_in"
              ? "出勤を記録しています。完了するまでタブを閉じないでください。"
              : "退勤を記録しています。完了するまでタブを閉じないでください。"
          );
          try {
            var data = await api("/api/employee/punch", {
              method: "POST",
              body: JSON.stringify({ action: punch })
            });
            state.today = data.today;
            updatePunchButtons(data.today);
            hidePunchSaving(
              punch === "clock_in" ? "出勤を記録しました。" : "退勤を記録しました。"
            );
          } catch (err) {
            state.today = prev;
            updatePunchButtons(prev);
            hidePunchSaving();
            throw err;
          }
        }
        if (action === "break") {
          if (!isEmployeeActive()) return;
          var t = state.today || {};
          var b = t.on_break ? "break_end" : "break_start";
          var prevBreak = {
            clock_in: t.clock_in || "",
            clock_out: t.clock_out || "",
            break_minutes: t.break_minutes || 0,
            on_break: !!t.on_break,
            break_short: !!t.break_short,
            required_break: t.required_break || 0,
            shortage: t.shortage || 0,
            overtime_minutes: t.overtime_minutes || 0,
            status: t.status || "",
            status_kind: t.status_kind || ""
          };
          var optBreak = Object.assign({}, prevBreak);
          optBreak.on_break = b === "break_start";
          state.today = optBreak;
          updatePunchButtons(optBreak);
          $("btn-break").disabled = true;
          showPunchSaving(
            b === "break_start"
              ? "休憩開始を記録しています。完了するまでタブを閉じないでください。"
              : "休憩終了を記録しています。完了するまでタブを閉じないでください。"
          );
          try {
            var bd = await api("/api/employee/punch", {
              method: "POST",
              body: JSON.stringify({ action: b })
            });
            state.today = bd.today;
            updatePunchButtons(bd.today);
            hidePunchSaving(
              b === "break_start" ? "休憩開始を記録しました。" : "休憩終了を記録しました。"
            );
          } catch (err2) {
            state.today = prevBreak;
            updatePunchButtons(prevBreak);
            hidePunchSaving();
            throw err2;
          }
        }
        if (action === "submit") await openSubmitModal();
        if (action === "close-modal") closeSubmitModal();
        if (action === "close-admin-modal") closeAdminModal();
        if (action === "a03-approve") {
          await withLoading(async function () {
            await api("/api/admin/approve", {
              method: "POST",
              body: JSON.stringify({
                emp_no: state.detailEmp,
                month: state.adminMonth
              })
            });
            await refreshDetail(state.detailEmp);
          }, "承認しています");
          alert("1ヶ月分を承認しました");
        }
        if (action === "a03-reject") {
          var reasonReject = $("a03-reject-reason");
          if (!reasonReject.value.trim()) {
            alert("差戻しには理由が必要です");
            return;
          }
          await withLoading(async function () {
            await api("/api/admin/reject", {
              method: "POST",
              body: JSON.stringify({
                emp_no: state.detailEmp,
                month: state.adminMonth,
                reason: reasonReject.value.trim()
              })
            });
            await refreshDetail(state.detailEmp);
          }, "差戻しています");
          reasonReject.value = "";
          alert("1ヶ月分を差戻しました");
        }
        if (action === "a03-save") {
          var reasonSave = $("a03-reason");
          if (!reasonSave.value.trim()) {
            alert("修正保存には理由が必要です");
            return;
          }
          var days = [];
          $("a03-body").querySelectorAll("tr").forEach(function (tr) {
            var modeEl = tr.querySelector(".a03-mode");
            days.push({
              work_date: tr.dataset.workDate,
              clock_in: tr.querySelector(".a03-in").value,
              clock_out: tr.querySelector(".a03-out").value,
              break_minutes: tr.querySelector(".a03-br").value || 0,
              day_mode: modeEl ? modeEl.value : "work"
            });
          });
          await withLoading(async function () {
            await api("/api/admin/save-days", {
              method: "POST",
              body: JSON.stringify({
                emp_no: state.detailEmp,
                month: state.adminMonth,
                reason: reasonSave.value.trim(),
                days: days
              })
            });
            await refreshDetail(state.detailEmp);
          }, "修正を保存しています");
          reasonSave.value = "";
          alert("1ヶ月分の修正を保存しました");
        }
      })
    );
  });

  $("btn-do-submit").addEventListener(
    "click",
    withError(async function () {
      await withLoading(async function () {
        await api("/api/employee/submit", {
          method: "POST",
          body: JSON.stringify({ month: state.empMonth || currentMonthKey() })
        });
      }, "提出しています");
      closeSubmitModal();
      alert("提出しました");
      await withLoading(refreshEmpMonth, "月次一覧を読み込んでいます");
    })
  );

  $("e02-prev").addEventListener("click", function () {
    state.empMonth = shiftMonth(state.empMonth || currentMonthKey(), -1);
    withError(function () {
      return withLoading(refreshEmpMonth, "月次一覧を読み込んでいます");
    })();
  });
  $("e02-next").addEventListener("click", function () {
    state.empMonth = shiftMonth(state.empMonth || currentMonthKey(), 1);
    withError(function () {
      return withLoading(refreshEmpMonth, "月次一覧を読み込んでいます");
    })();
  });

  $("btn-e02-save").addEventListener(
    "click",
    withError(async function () {
      var reason = $("e02-reason");
      if (!reason.value.trim()) {
        alert("修正保存には理由が必要です");
        return;
      }
      var days = [];
      $("e02-body").querySelectorAll("tr").forEach(function (tr) {
        var modeEl = tr.querySelector(".e02-mode");
        days.push({
          work_date: tr.dataset.workDate,
          clock_in: tr.querySelector(".e02-in").value,
          clock_out: tr.querySelector(".e02-out").value,
          break_minutes: tr.querySelector(".e02-br").value || 0,
          day_mode: modeEl ? modeEl.value : "work"
        });
      });
      await withLoading(async function () {
        await api("/api/employee/save-days", {
          method: "POST",
          body: JSON.stringify({
            month: state.empMonth,
            reason: reason.value.trim(),
            days: days
          })
        });
        await refreshEmpMonth();
      }, "修正を保存しています");
      reason.value = "";
      alert("修正を保存しました");
    })
  );

  $("a01-month").addEventListener("change", function () {
    state.adminMonth = $("a01-month").value;
    state.adminDay = null;
    updateCsvButtonLabel();
    $("a01-kpi-detail").classList.add("is-hidden");
    withError(function () {
      return withLoading(refreshDashboard);
    })();
  });
  $("a01-day").addEventListener("change", function () {
    state.adminDay = $("a01-day").value;
    $("a01-kpi-detail").classList.add("is-hidden");
    withError(function () {
      return withLoading(refreshDashboard);
    })();
  });
  document.querySelectorAll("[data-kpi]").forEach(function (el) {
    el.addEventListener("click", function () {
      showKpiDetail(el.dataset.kpi);
    });
  });
  $("a01-kpi-detail-close").addEventListener("click", function () {
    $("a01-kpi-detail").classList.add("is-hidden");
  });

  ["a04-date", "a04-changer", "a04-emp", "a04-reason"].forEach(function (id) {
    $(id).addEventListener("input", scheduleLogsSearch);
  });

  $("btn-csv").addEventListener("click", function () {
    var month = selectedAdminMonth();
    updateCsvButtonLabel();
    window.location.href =
      "/api/admin/csv?month=" + encodeURIComponent(month);
  });

  $("btn-add-emp").addEventListener(
    "click",
    withError(async function () {
      await withLoading(async function () {
        await api("/api/admin/employees", {
          method: "POST",
          body: JSON.stringify({
            emp_no: $("new-emp-no").value.trim(),
            name: $("new-emp-name").value.trim()
          })
        });
        $("new-emp-no").value = "";
        $("new-emp-name").value = "";
        await refreshEmployees();
      }, "社員を追加しています");
    })
  );

  document.querySelectorAll("[data-screen]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      showScreen(btn.dataset.screen);
    });
  });
  document.querySelectorAll("[data-goto]").forEach(function (el) {
    el.addEventListener("click", function () {
      if (el.disabled) return;
      showScreen(el.dataset.goto);
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeSubmitModal();
      closeAdminModal();
    }
  });

  updatePunchButtons(null);
  setEmployeeNavEnabled(false);

  /* タブを閉じても社員番号を残す */
  var savedEmpNo = loadEmpNoLocal();
  if (savedEmpNo) {
    $("emp-id").value = savedEmpNo;
  }

  withError(async function () {
    state.empBusy = true;
    try {
      var empNo = savedEmpNo;
      try {
        var me = await api("/api/employee/me");
        if (me && me.emp_no) {
          empNo = me.emp_no;
        }
      } catch (e) {}

      if (empNo) {
        $("emp-id").value = empNo;
        try {
          var ok = await ensureEmployeeSession(empNo);
          if (!ok) {
            resetEmployeeUi();
            $("emp-id").value = empNo;
          }
        } catch (eRestore) {
          resetEmployeeUi();
          $("emp-id").value = empNo;
        }
      } else {
        resetEmployeeUi();
      }

      try {
        var adm = await api("/api/admin/me");
        if (adm.admin) {
          state.role = "admin";
          state.adminMonth = defaultMonthKey();
          updateCsvButtonLabel();
          setSessionLabel();
        }
      } catch (e2) {}
    } finally {
      state.empBusy = false;
      // 復元成功時は提出ボタンを確実に有効化
      if (isEmployeeActive()) {
        setEmployeeNavEnabled(true);
      }
    }
  })();
})();
