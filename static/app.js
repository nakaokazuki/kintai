(function () {
  var state = {
    role: null,
    emp: null,
    today: null,
    empMonth: null,
    adminMonth: null,
    detailEmp: null,
    pendingAdminScreen: null
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

  function isAdminScreen(id) {
    return ["a01", "a03", "a04", "a05"].indexOf(id) >= 0;
  }

  function showScreen(id) {
    if (isAdminScreen(id) && state.role !== "admin") {
      state.pendingAdminScreen = id;
      openAdminModal();
      return;
    }
    if ((id === "e02" || id === "e01") && !state.emp && id === "e02") {
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

    if (id === "e01" && state.emp) refreshToday();
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
    if (!state.emp) return;
    var data = await api("/api/employee/today");
    state.today = data.today;
    $("e01-identity").textContent =
      "氏名：" + state.emp.name + "　番号：" + state.emp.emp_no;
    $("e01-today-title").textContent = "本日 " + data.server_date;
    updatePunchButtons(data.today);
  }

  async function refreshEmpMonth() {
    if (!state.emp) {
      alert("先に社員番号を確認してください");
      showScreen("e01");
      return;
    }
    if (!state.empMonth) state.empMonth = defaultMonthKey();
    var data = await api("/api/employee/month?month=" + state.empMonth);
    $("e02-title").textContent = monthLabel(state.empMonth) + "の月次一覧";
    $("e02-status").textContent = data.submission.status;
    var body = $("e02-body");
    body.innerHTML = "";
    data.days.forEach(function (d) {
      var tr = document.createElement("tr");
      if (d.status_kind === "missing") tr.className = "row-missing";
      if (d.status_kind === "break") tr.className = "row-break";
      var statusText = d.status === "休憩不足" ? "休不足" : d.status;
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
        statusText +
        "</td>";
      body.appendChild(tr);
    });
  }

  function fillMonthSelect(selectId, selected) {
    var sel = $(selectId);
    sel.innerHTML = "";
    var end = shiftMonth(currentMonthKey(), 1);
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

  async function refreshDashboard() {
    if (!state.adminMonth) state.adminMonth = defaultMonthKey();
    fillMonthSelect("a01-month", state.adminMonth);
    var data = await api("/api/admin/dashboard?month=" + state.adminMonth);
    $("kpi-unsubmitted").textContent = data.kpi.unsubmitted + "人";
    $("kpi-pending").textContent = data.kpi.pending + "人";
    $("kpi-missing").textContent = data.kpi.missing + "人";
    $("kpi-break").textContent = data.kpi.break_short + "件";
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
      tr.dataset.workDate = d.work_date;
      var statusClass =
        d.status_kind === "ok"
          ? "is-ok"
          : d.status_kind === "break"
            ? "is-break"
            : "is-missing";
      var md = d.work_date.slice(5).replace("-", "/");
      if (md.charAt(0) === "0") md = md.slice(1);
      tr.innerHTML =
        "<td>" +
        md +
        "</td><td>" +
        d.weekday +
        '</td><td><input class="a03-cell a03-in" value="' +
        (d.clock_in || "") +
        '" placeholder="—" /></td><td><input class="a03-cell a03-out" value="' +
        (d.clock_out || "") +
        '" placeholder="—" /></td><td><input class="a03-cell a03-br" value="' +
        (d.clock_in || d.clock_out ? d.break_minutes : "") +
        '" placeholder="—" /></td><td><span class="a03-status ' +
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
      var day = r.display_date || r.created_at;
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
    if (!state.emp) {
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
      var data = await api("/api/employee/login", {
        method: "POST",
        body: JSON.stringify({ emp_no: emp_no })
      });
      state.role = "employee";
      state.emp = data;
      state.empMonth = defaultMonthKey();
      setSessionLabel();
      await refreshToday();
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

  document.querySelectorAll("[data-action]").forEach(function (el) {
    el.addEventListener(
      "click",
      withError(async function () {
        var action = el.dataset.action;
        if (action === "work") {
          if (!state.emp) {
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
          var data = await api("/api/employee/punch", {
            method: "POST",
            body: JSON.stringify({ action: punch })
          });
          state.today = data.today;
          updatePunchButtons(data.today);
        }
        if (action === "break") {
          if (!state.emp) return;
          var t = state.today || {};
          var b = t.on_break ? "break_end" : "break_start";
          var bd = await api("/api/employee/punch", {
            method: "POST",
            body: JSON.stringify({ action: b })
          });
          state.today = bd.today;
          updatePunchButtons(bd.today);
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
            days.push({
              work_date: tr.dataset.workDate,
              clock_in: tr.querySelector(".a03-in").value,
              clock_out: tr.querySelector(".a03-out").value,
              break_minutes: tr.querySelector(".a03-br").value || 0
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

  $("a01-month").addEventListener("change", function () {
    state.adminMonth = $("a01-month").value;
    withError(refreshDashboard)();
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

  withError(async function () {
    try {
      var me = await api("/api/employee/me");
      state.role = "employee";
      state.emp = me;
      state.empMonth = defaultMonthKey();
      $("emp-id").value = me.emp_no;
      setSessionLabel();
      await refreshToday();
      return;
    } catch (e) {}
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
