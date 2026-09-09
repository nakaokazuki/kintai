(function () {
  var state = {
    role: null,
    emp: null,
    today: null,
    empMonth: null,
    adminMonth: null,
    adminDay: "",
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

  async function api(url, options) {
    options = options || {};
    options.headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );
    var res = await fetch(url, options);
    var data = await res.json().catch(function () {
      return { ok: false, error: "通信エラー" };
    });
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
    if (id === "e02") refreshEmpMonth();
    if (id === "a01") refreshDashboard();
    if (id === "a03") {
      if (state.detailEmp) refreshDetail(state.detailEmp);
      /* 社員未選択時は空のまま（A-05の氏名クリックで遷移） */
    }
    if (id === "a04") refreshLogs();
    if (id === "a05") refreshEmployees();
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
    var data = await api("/api/employee/month?month=" + state.empMonth);
    $("e02-title").textContent = monthLabel(state.empMonth) + "の月次一覧";
    $("e02-status").textContent = data.submission.status;
    var editable =
      data.submission.status === "未提出" || data.submission.status === "差戻し";
    $("e02-edit-block").classList.toggle("is-hidden", !editable);
    var body = $("e02-body");
    body.innerHTML = "";
    data.days.forEach(function (d) {
      var tr = document.createElement("tr");
      if (d.status_kind === "missing") tr.className = "row-missing";
      if (d.status_kind === "break") tr.className = "row-break";
      if (d.status_kind === "holiday") tr.className = "row-holiday";
      tr.dataset.workDate = d.work_date;
      tr.dataset.isHoliday = d.is_holiday ? "1" : "0";
      var statusText =
        d.status === "休憩不足"
          ? "休不足"
          : d.status === "休日"
            ? "休日"
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
            ">未入力</option>" +
            "</select>";
        } else {
          statusCell = statusText;
        }
        var timeDisabled = d.is_holiday && d.day_mode !== "work";
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
      if (editable && d.is_holiday) {
        var modeSel = tr.querySelector(".e02-mode");
        modeSel.addEventListener("change", function () {
          var disable = modeSel.value === "holiday";
          tr.classList.toggle("row-holiday", disable);
          tr.classList.toggle("row-missing", !disable);
          ["e02-in", "e02-out", "e02-br"].forEach(function (cls) {
            var inp = tr.querySelector("." + cls);
            inp.disabled = disable;
            if (disable) inp.value = "";
          });
        });
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
    var today = new Date();
    var todayIso =
      today.getFullYear() +
      "-" +
      pad(today.getMonth() + 1) +
      "-" +
      pad(today.getDate());
    var pick = selectedIso === null || selectedIso === undefined ? "" : selectedIso;
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

  async function refreshDashboard() {
    if (!state.adminMonth) state.adminMonth = defaultMonthKey();
    if (state.adminDay === undefined) state.adminDay = "";
    fillMonthSelect("a01-month", state.adminMonth);
    fillDaySelect(state.adminMonth, state.adminDay);
    var data = await api(
      "/api/admin/dashboard?month=" +
        encodeURIComponent(state.adminMonth) +
        "&date=" +
        encodeURIComponent(state.adminDay || "")
    );
    state.adminDay = data.date || "";
    state.dashboardScope = data.scope || "month";
    if ($("a01-day").value !== state.adminDay) {
      fillDaySelect(state.adminMonth, state.adminDay);
    }
    state.dashboardLists = data.lists || {};
    $("kpi-unsubmitted").textContent = data.kpi.unsubmitted + "人";
    $("kpi-pending").textContent = data.kpi.pending + "人";
    var dayUnit = state.dashboardScope === "day" ? "人" : "件";
    $("kpi-missing").textContent = data.kpi.missing + dayUnit;
    $("kpi-break").textContent = data.kpi.break_short + dayUnit;
  }

  var KPI_TITLES = {
    unsubmitted: "未提出の社員",
    pending: "承認待ちの社員",
    missing: "未入力の社員",
    break_short: "休憩不足の社員"
  };

  function showKpiDetail(kind) {
    var panel = $("a01-kpi-detail");
    var list = $("a01-kpi-detail-list");
    var title = $("a01-kpi-detail-title");
    var rows = (state.dashboardLists && state.dashboardLists[kind]) || [];
    var label = KPI_TITLES[kind] || kind;
    if (kind === "missing" || kind === "break_short") {
      if (state.adminDay) {
        label += "（" + formatDisplayDate(state.adminDay) + "）";
      } else {
        label += "（" + monthLabel(state.adminMonth) + "・月合計）";
      }
    } else {
      label += "（" + monthLabel(state.adminMonth) + "）";
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
        btn.className = "linkish kpi-emp-link";
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
      tr.dataset.workDate = d.work_date;
      tr.dataset.isHoliday = d.is_holiday ? "1" : "0";
      var statusClass =
        d.status_kind === "ok"
          ? "is-ok"
          : d.status_kind === "break"
            ? "is-break"
            : d.status_kind === "holiday"
              ? "is-leave"
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
      } else {
        statusCell =
          '<span class="a03-status ' +
          statusClass +
          '">' +
          d.status +
          "</span>";
      }
      var timeDisabled = d.is_holiday && d.day_mode !== "work";
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
      if (d.is_holiday) {
        var modeSel = tr.querySelector(".a03-mode");
        modeSel.addEventListener("change", function () {
          var disable = modeSel.value === "holiday";
          tr.classList.toggle("is-holiday-row", disable);
          tr.classList.toggle("is-missing-row", !disable);
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

  async function refreshLogs() {
    var q =
      "/api/admin/logs?date=" +
      encodeURIComponent($("a04-date").value || "") +
      "&emp=" +
      encodeURIComponent($("a04-emp").value || "") +
      "&changer=" +
      encodeURIComponent($("a04-changer").value || "");
    var data = await api(q);
    var body = $("a04-body");
    body.innerHTML = "";
    data.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var day = formatDisplayDate(r.display_date || r.created_at);
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
      nameBtn.className = "linkish emp-name-link";
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
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-tiny btn-warn";
        btn.textContent = "無効化";
        btn.addEventListener(
          "click",
          withError(async function () {
            if (!confirm(e.emp_no + " を無効化しますか？")) return;
            await api("/api/admin/employees/" + e.emp_no + "/deactivate", {
              method: "POST",
              body: "{}"
            });
            refreshEmployees();
          })
        );
        tdAction.appendChild(btn);
      }
      tr.appendChild(tdNo);
      tr.appendChild(tdName);
      tr.appendChild(tdStatus);
      tr.appendChild(tdAction);
      body.appendChild(tr);
    });
  }

  async function openSubmitModal() {
    if (!isEmployeeActive()) {
      alert("先に社員番号を確認してください");
      return;
    }
    var month = state.empMonth || currentMonthKey();
    var data = await api("/api/employee/submit-check?month=" + month);
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
      try {
        var data = await api("/api/employee/login", {
          method: "POST",
          body: JSON.stringify({ emp_no: emp_no })
        });
        if (!data || !data.emp_no) {
          throw new Error("ログインに失敗しました");
        }
        state.role = "employee";
        state.emp = {
          emp_no: data.emp_no,
          name: data.name || ""
        };
        state.empMonth = defaultMonthKey();
        $("emp-id").value = data.emp_no;
        $("e01-identity").textContent =
          "氏名：" + (data.name || "—") + "　番号：" + data.emp_no;
        setSessionLabel();
        setEmployeeNavEnabled(true);
        await refreshToday();
      } finally {
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
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: $("login-admin-pass").value })
      });
      state.role = "admin";
      state.adminMonth = defaultMonthKey();
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
      await api("/api/admin/reset-password", {
        method: "POST",
        body: JSON.stringify({
          reset_code: $("reset-code").value,
          new_password: $("reset-new").value
        })
      });
      alert("パスワードをリセットしました");
    })
  );

  function nowHhmm() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

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
          try {
            var data = await api("/api/employee/punch", {
              method: "POST",
              body: JSON.stringify({ action: punch })
            });
            state.today = data.today;
            updatePunchButtons(data.today);
          } catch (err) {
            state.today = prev;
            updatePunchButtons(prev);
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
          try {
            var bd = await api("/api/employee/punch", {
              method: "POST",
              body: JSON.stringify({ action: b })
            });
            state.today = bd.today;
            updatePunchButtons(bd.today);
          } catch (err2) {
            state.today = prevBreak;
            updatePunchButtons(prevBreak);
            throw err2;
          }
        }
        if (action === "submit") openSubmitModal();
        if (action === "close-modal") closeSubmitModal();
        if (action === "close-admin-modal") closeAdminModal();
        if (action === "a03-approve") {
          await api("/api/admin/approve", {
            method: "POST",
            body: JSON.stringify({
              emp_no: state.detailEmp,
              month: state.adminMonth
            })
          });
          alert("1ヶ月分を承認しました");
          refreshDetail(state.detailEmp);
        }
        if (action === "a03-reject") {
          var reasonReject = $("a03-reason");
          if (!reasonReject.value.trim()) {
            alert("差戻しには理由が必要です");
            return;
          }
          await api("/api/admin/reject", {
            method: "POST",
            body: JSON.stringify({
              emp_no: state.detailEmp,
              month: state.adminMonth,
              reason: reasonReject.value.trim()
            })
          });
          alert("1ヶ月分を差戻しました");
          refreshDetail(state.detailEmp);
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
          await api("/api/admin/save-days", {
            method: "POST",
            body: JSON.stringify({
              emp_no: state.detailEmp,
              month: state.adminMonth,
              reason: reasonSave.value.trim(),
              days: days
            })
          });
          alert("1ヶ月分の修正を保存しました");
          refreshDetail(state.detailEmp);
        }
      })
    );
  });

  $("btn-do-submit").addEventListener(
    "click",
    withError(async function () {
      await api("/api/employee/submit", {
        method: "POST",
        body: JSON.stringify({ month: state.empMonth || currentMonthKey() })
      });
      closeSubmitModal();
      alert("提出しました");
      refreshEmpMonth();
    })
  );

  $("e02-prev").addEventListener("click", function () {
    state.empMonth = shiftMonth(state.empMonth || currentMonthKey(), -1);
    withError(refreshEmpMonth)();
  });
  $("e02-next").addEventListener("click", function () {
    state.empMonth = shiftMonth(state.empMonth || currentMonthKey(), 1);
    withError(refreshEmpMonth)();
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
      await api("/api/employee/save-days", {
        method: "POST",
        body: JSON.stringify({
          month: state.empMonth,
          reason: reason.value.trim(),
          days: days
        })
      });
      alert("修正を保存しました");
      refreshEmpMonth();
    })
  );

  $("a01-month").addEventListener("change", function () {
    state.adminMonth = $("a01-month").value;
    state.adminDay = "";
    $("a01-kpi-detail").classList.add("is-hidden");
    withError(refreshDashboard)();
  });
  $("a01-day").addEventListener("change", function () {
    state.adminDay = $("a01-day").value;
    $("a01-kpi-detail").classList.add("is-hidden");
    withError(refreshDashboard)();
  });
  document.querySelectorAll("[data-kpi]").forEach(function (el) {
    el.addEventListener("click", function () {
      showKpiDetail(el.dataset.kpi);
    });
  });
  $("a01-kpi-detail-close").addEventListener("click", function () {
    $("a01-kpi-detail").classList.add("is-hidden");
  });

  ["a04-date", "a04-emp", "a04-changer"].forEach(function (id) {
    $(id).addEventListener("input", withError(refreshLogs));
  });

  $("btn-csv").addEventListener("click", function () {
    window.location.href =
      "/api/admin/csv?month=" +
      encodeURIComponent(state.adminMonth || currentMonthKey());
  });

  $("btn-add-emp").addEventListener(
    "click",
    withError(async function () {
      await api("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({
          emp_no: $("new-emp-no").value.trim(),
          name: $("new-emp-name").value.trim()
        })
      });
      $("new-emp-no").value = "";
      $("new-emp-name").value = "";
      refreshEmployees();
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

  withError(async function () {
    try {
      var me = await api("/api/employee/me");
      if (!me || !me.emp_no) {
        resetEmployeeUi();
      } else {
        state.empBusy = true;
        try {
          state.role = "employee";
          state.emp = { emp_no: me.emp_no, name: me.name || "" };
          state.empMonth = defaultMonthKey();
          $("emp-id").value = me.emp_no;
          $("e01-identity").textContent =
            "氏名：" + (me.name || "—") + "　番号：" + me.emp_no;
          setSessionLabel();
          setEmployeeNavEnabled(true);
          await refreshToday();
        } finally {
          state.empBusy = false;
        }
        return;
      }
    } catch (e) {
      resetEmployeeUi();
    }
    try {
      var adm = await api("/api/admin/me");
      if (adm.admin) {
        state.role = "admin";
        state.adminMonth = defaultMonthKey();
        setSessionLabel();
      }
    } catch (e2) {}
  })();
})();
