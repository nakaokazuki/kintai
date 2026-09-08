(function () {
  var state = {
    role: null,
    emp: null,
    today: null,
    empMonth: null,
    adminMonth: null,
    detailEmp: null
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
    return p[0] + "年" + parseInt(p[1], 10) + "月";
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

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach(function (el) {
      el.classList.toggle("is-visible", el.id === id);
    });
    document.querySelectorAll(".nav-btn").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.screen === id);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (id === "e01") refreshToday();
    if (id === "e02") refreshEmpMonth();
    if (id === "a01") refreshDashboard();
    if (id === "a02") refreshAdminList();
    if (id === "a03" && state.detailEmp) refreshDetail(state.detailEmp);
    if (id === "a04") refreshLogs();
    if (id === "a05") refreshEmployees();
  }

  function setRoleUI() {
    var label = $("session-label");
    document.querySelectorAll(".emp-only").forEach(function (el) {
      el.classList.toggle("is-hidden", state.role !== "employee");
    });
    document.querySelectorAll(".admin-only").forEach(function (el) {
      el.classList.toggle("is-hidden", state.role !== "admin");
    });
    if (state.role === "employee" && state.emp) {
      label.textContent = state.emp.name + "（" + state.emp.emp_no + "）";
    } else if (state.role === "admin") {
      label.textContent = "管理者";
    } else {
      label.textContent = "未ログイン";
    }
  }

  function updatePunchButtons(today) {
    var work = $("btn-work");
    var br = $("btn-break");
    if (!today) return;
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

    $("e01-times").textContent =
      "出勤 " +
      (today.clock_in || "—") +
      " / 退勤 " +
      (today.clock_out || "—") +
      " / 休憩 " +
      today.break_minutes +
      "分 / 残業 " +
      today.overtime_minutes +
      "分";

    var missing = $("alert-missing");
    var breakAlert = $("alert-break");
    missing.classList.toggle(
      "is-hidden",
      !(today.clock_in && !today.clock_out)
    );
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
    if (state.role !== "employee") return;
    var data = await api("/api/employee/today");
    state.today = data.today;
    $("e01-identity").textContent =
      "氏名：" + state.emp.name + "　番号：" + state.emp.emp_no;
    $("e01-today-title").textContent = "本日 " + data.server_date;
    updatePunchButtons(data.today);
  }

  async function refreshEmpMonth() {
    if (!state.empMonth) state.empMonth = currentMonthKey();
    var data = await api("/api/employee/month?month=" + state.empMonth);
    $("e02-title").textContent = "月次一覧　" + monthLabel(state.empMonth);
    $("e02-status").textContent = data.submission.status;
    var body = $("e02-body");
    body.innerHTML = "";
    data.days.forEach(function (d) {
      var tr = document.createElement("tr");
      if (d.status_kind === "missing") tr.className = "row-missing";
      if (d.status_kind === "break") tr.className = "row-break";
      tr.innerHTML =
        "<td>" +
        d.day +
        "</td><td>" +
        (d.clock_in || "—") +
        "</td><td>" +
        (d.clock_out || "—") +
        "</td><td>" +
        (d.clock_in ? d.break_minutes : "—") +
        "</td><td>" +
        (d.clock_out ? d.overtime_minutes : "—") +
        "</td><td>" +
        d.status +
        "</td>";
      body.appendChild(tr);
    });
  }

  function fillMonthSelect(selectId, selected) {
    var sel = $(selectId);
    sel.innerHTML = "";
    var base = new Date();
    for (var i = -3; i <= 3; i++) {
      var ym = shiftMonth(
        base.getFullYear() + "-" + pad(base.getMonth() + 1),
        i
      );
      var opt = document.createElement("option");
      opt.value = ym;
      opt.textContent = monthLabel(ym);
      if (ym === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  async function refreshDashboard() {
    if (!state.adminMonth) state.adminMonth = currentMonthKey();
    fillMonthSelect("a01-month", state.adminMonth);
    var data = await api("/api/admin/dashboard?month=" + state.adminMonth);
    $("kpi-unsubmitted").textContent = data.kpi.unsubmitted + "人";
    $("kpi-pending").textContent = data.kpi.pending + "人";
    $("kpi-review").textContent = data.kpi.review + "件";
    $("kpi-break").textContent = data.kpi.break_short + "件";
  }

  async function refreshAdminList() {
    if (!state.adminMonth) state.adminMonth = currentMonthKey();
    $("a02-title").textContent = "勤怠一覧　" + monthLabel(state.adminMonth);
    var q =
      "/api/admin/list?month=" +
      encodeURIComponent(state.adminMonth) +
      "&status=" +
      encodeURIComponent($("a02-filter").value || "") +
      "&emp_no=" +
      encodeURIComponent($("a02-search").value || "");
    var data = await api(q);
    var body = $("a02-body");
    body.innerHTML = "";
    data.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      if (r.status_kind === "break") tr.className = "row-break";
      if (r.status_kind === "missing") tr.className = "row-missing";
      tr.innerHTML =
        "<td>" +
        r.emp_no +
        " " +
        r.name +
        "</td><td>" +
        r.day +
        "</td><td>" +
        r.clock_in +
        "</td><td>" +
        r.clock_out +
        "</td><td>" +
        r.break_minutes +
        "</td><td>" +
        r.status +
        "</td>";
      tr.addEventListener("click", function () {
        state.detailEmp = r.emp_no;
        showScreen("a03");
      });
      body.appendChild(tr);
    });
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
      data.employee.name + "（" + data.employee.emp_no + "）";
    $("a03-badge").textContent = data.submission.status;
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
      tr.dataset.workDate = d.work_date;
      var statusClass =
        d.status_kind === "ok"
          ? "is-ok"
          : d.status_kind === "break"
            ? "is-break"
            : "is-missing";
      tr.innerHTML =
        "<td>" +
        d.day +
        "</td><td>" +
        d.weekday +
        '</td><td><input class="a03-cell a03-in" value="' +
        (d.clock_in || "") +
        '" /></td><td><input class="a03-cell a03-out" value="' +
        (d.clock_out || "") +
        '" /></td><td><input class="a03-cell a03-br" value="' +
        d.break_minutes +
        '" /></td><td><span class="a03-status ' +
        statusClass +
        '">' +
        d.status +
        "</span></td>";
      body.appendChild(tr);
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
      tr.innerHTML =
        "<td>" +
        r.created_at.replace("T", " ").slice(0, 16) +
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
      tr.innerHTML =
        "<td>" +
        e.emp_no +
        "</td><td>" +
        e.name +
        "</td><td>" +
        (e.active ? "有効" : "無効") +
        "</td><td></td>";
      if (e.active) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-tiny btn-warn";
        btn.textContent = "無効化";
        btn.addEventListener("click", async function () {
          if (!confirm(e.emp_no + " を無効化しますか？")) return;
          await api("/api/admin/employees/" + e.emp_no + "/deactivate", {
            method: "POST",
            body: "{}"
          });
          refreshEmployees();
        });
        tr.lastChild.appendChild(btn);
      }
      body.appendChild(tr);
    });
  }

  async function openSubmitModal() {
    var month = state.empMonth || currentMonthKey();
    var data = await api("/api/employee/submit-check?month=" + month);
    var list = $("submit-checklist");
    list.innerHTML = "";
    var li1 = document.createElement("li");
    li1.className = data.missing_count > 0 ? "bad" : "ok";
    li1.textContent =
      "未入力：" +
      data.missing_count +
      "件 → " +
      (data.missing_count > 0 ? "提出不可" : "OK");
    list.appendChild(li1);
    var li2 = document.createElement("li");
    li2.className = data.break_short_count > 0 ? "warn" : "ok";
    li2.textContent =
      "休憩不足：" +
      data.break_short_count +
      "件 → " +
      (data.break_short_count > 0 ? "警告（提出は可）" : "OK");
    list.appendChild(li2);
    $("submit-status-line").textContent =
      "現在ステータス：" + data.submission.status;
    $("submit-hint").textContent = (data.messages || []).join(" / ");
    var btn = $("btn-do-submit");
    btn.disabled = !data.can_submit;
    btn.textContent = data.can_submit
      ? "提出する"
      : "提出する（条件未達）";
    $("submit-modal").classList.remove("is-hidden");
  }

  function closeSubmitModal() {
    $("submit-modal").classList.add("is-hidden");
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

  // events
  $("btn-emp-login").addEventListener(
    "click",
    withError(async function () {
      var emp_no = $("login-emp").value.trim();
      var data = await api("/api/employee/login", {
        method: "POST",
        body: JSON.stringify({ emp_no: emp_no })
      });
      state.role = "employee";
      state.emp = data;
      state.empMonth = currentMonthKey();
      setRoleUI();
      showScreen("e01");
    })
  );

  $("btn-admin-login").addEventListener(
    "click",
    withError(async function () {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: $("login-admin-pass").value })
      });
      state.role = "admin";
      state.adminMonth = currentMonthKey();
      setRoleUI();
      showScreen("a01");
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
      alert("パスワードをリセットしました。新しいパスワードでログインしてください。");
    })
  );

  $("btn-emp-logout").addEventListener(
    "click",
    withError(async function () {
      await api("/api/employee/logout", { method: "POST", body: "{}" });
      state.role = null;
      state.emp = null;
      setRoleUI();
      showScreen("login");
    })
  );

  $("btn-admin-logout").addEventListener(
    "click",
    withError(async function () {
      await api("/api/admin/logout", { method: "POST", body: "{}" });
      state.role = null;
      setRoleUI();
      showScreen("login");
    })
  );

  $("btn-work").addEventListener(
    "click",
    withError(async function () {
      var today = state.today || {};
      var action = !today.clock_in
        ? "clock_in"
        : !today.clock_out
          ? "clock_out"
          : null;
      if (!action) return;
      var data = await api("/api/employee/punch", {
        method: "POST",
        body: JSON.stringify({ action: action })
      });
      state.today = data.today;
      updatePunchButtons(data.today);
    })
  );

  $("btn-break").addEventListener(
    "click",
    withError(async function () {
      var today = state.today || {};
      var action = today.on_break ? "break_end" : "break_start";
      var data = await api("/api/employee/punch", {
        method: "POST",
        body: JSON.stringify({ action: action })
      });
      state.today = data.today;
      updatePunchButtons(data.today);
    })
  );

  $("btn-open-submit").addEventListener("click", withError(openSubmitModal));
  document.querySelectorAll("[data-action=close-modal]").forEach(function (el) {
    el.addEventListener("click", closeSubmitModal);
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

  $("a01-month").addEventListener("change", function () {
    state.adminMonth = $("a01-month").value;
    withError(refreshDashboard)();
  });

  $("a02-filter").addEventListener("change", withError(refreshAdminList));
  $("a02-search").addEventListener("input", withError(refreshAdminList));
  ["a04-date", "a04-emp", "a04-changer"].forEach(function (id) {
    $(id).addEventListener("input", withError(refreshLogs));
  });

  $("btn-csv").addEventListener("click", function () {
    window.location.href =
      "/api/admin/csv?month=" +
      encodeURIComponent(state.adminMonth || currentMonthKey());
  });

  $("a03-approve").addEventListener(
    "click",
    withError(async function () {
      await api("/api/admin/approve", {
        method: "POST",
        body: JSON.stringify({
          emp_no: state.detailEmp,
          month: state.adminMonth
        })
      });
      alert("承認しました");
      refreshDetail(state.detailEmp);
    })
  );

  $("a03-reject").addEventListener(
    "click",
    withError(async function () {
      var reason = $("a03-reason").value.trim();
      if (!reason) {
        alert("差戻しには理由が必要です");
        return;
      }
      await api("/api/admin/reject", {
        method: "POST",
        body: JSON.stringify({
          emp_no: state.detailEmp,
          month: state.adminMonth,
          reason: reason
        })
      });
      alert("差戻しました");
      refreshDetail(state.detailEmp);
    })
  );

  $("a03-save").addEventListener(
    "click",
    withError(async function () {
      var reason = $("a03-reason").value.trim();
      if (!reason) {
        alert("修正保存には理由が必要です");
        return;
      }
      var days = [];
      $("a03-body").querySelectorAll("tr").forEach(function (tr) {
        days.push({
          work_date: tr.dataset.workDate,
          clock_in: tr.querySelector(".a03-in").value,
          clock_out: tr.querySelector(".a03-out").value,
          break_minutes: tr.querySelector(".a03-br").value
        });
      });
      await api("/api/admin/save-days", {
        method: "POST",
        body: JSON.stringify({
          emp_no: state.detailEmp,
          month: state.adminMonth,
          reason: reason,
          days: days
        })
      });
      alert("保存しました");
      refreshDetail(state.detailEmp);
    })
  );

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
      showScreen(el.dataset.goto);
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeSubmitModal();
  });

  // restore session
  withError(async function () {
    try {
      var me = await api("/api/employee/me");
      state.role = "employee";
      state.emp = me;
      state.empMonth = currentMonthKey();
      setRoleUI();
      showScreen("e01");
      return;
    } catch (e) {}
    try {
      var adm = await api("/api/admin/me");
      if (adm.admin) {
        state.role = "admin";
        state.adminMonth = currentMonthKey();
        setRoleUI();
        showScreen("a01");
      }
    } catch (e2) {}
  })();
})();
