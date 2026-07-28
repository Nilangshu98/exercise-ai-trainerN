(function () {
  const exerciseGrid = document.getElementById("exerciseGrid");
  const historyWrap = document.getElementById("historyWrap");
  const usernameLabel = document.getElementById("usernameLabel");
  const logoutBtn = document.getElementById("logoutBtn");

  async function requireAuth() {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (!data.loggedIn) {
      window.location.href = "/login.html";
      return null;
    }
    usernameLabel.textContent = data.username;
    return data;
  }

  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  function fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  async function loadExercises() {
    const res = await fetch("/api/exercises");
    const data = await res.json();
    if (!data.ok) {
      exerciseGrid.innerHTML = `<div class="empty-note">Could not load exercises: ${data.error}</div>`;
      return;
    }
    const exercises = Object.values(data.exercises);
    if (exercises.length === 0) {
      exerciseGrid.innerHTML = `<div class="empty-note">No exercises configured yet.</div>`;
      return;
    }
    exerciseGrid.innerHTML = exercises
      .map((ex) => {
        const statusClass = ex.trained ? "ready" : "untrained";
        const statusText = ex.trained
          ? `Model ready · ${(ex.accuracy * 100).toFixed(0)}% val. accuracy`
          : "Not trained yet";
        return `
          <a class="exercise-card" href="predict.html?exercise=${encodeURIComponent(ex.name)}">
            <span class="exercise-icon">${ex.icon}</span>
            <h3>${ex.display_name}</h3>
            <span class="exercise-type">${ex.type === "reps" ? "Rep-based" : "Hold pose"}</span>
            <div class="exercise-status ${statusClass}">
              <span class="status-dot ${statusClass}"></span> ${statusText}
            </div>
          </a>
        `;
      })
      .join("");
  }

  async function loadHistory() {
    const res = await fetch("/api/history");
    const data = await res.json();
    if (!data.ok || data.history.length === 0) {
      historyWrap.innerHTML = `<div class="empty-note">No sessions yet — finish a live workout to see it here.</div>`;
      return;
    }
    const rows = data.history
      .map((h) => {
        const metric =
          h.reps != null ? `${h.reps} reps` : h.hold_seconds != null ? `${h.hold_seconds}s held` : "—";
        return `
          <tr>
            <td>${h.exercise}</td>
            <td>${fmtDate(h.started_at)}</td>
            <td>${fmtDuration(h.duration_seconds)}</td>
            <td>${metric}</td>
            <td>${h.avg_accuracy != null ? h.avg_accuracy.toFixed(0) + "%" : "—"}</td>
          </tr>
        `;
      })
      .join("");
    historyWrap.innerHTML = `
      <table class="history-table">
        <thead><tr><th>Exercise</th><th>When</th><th>Duration</th><th>Result</th><th>Avg accuracy</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  (async () => {
    const user = await requireAuth();
    if (!user) return;
    loadExercises();
    loadHistory();
  })();
})();
