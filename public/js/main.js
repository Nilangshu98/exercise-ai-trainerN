(function () {
  const exerciseGrid = document.getElementById("exerciseGrid");
  const historyWrap = document.getElementById("historyWrap");
  const usernameLabel = document.getElementById("usernameLabel");
  const logoutBtn = document.getElementById("logoutBtn");
  const previewModal = document.getElementById("previewModal");
  const previewVideo = document.getElementById("previewVideo");
  const previewTitle = document.getElementById("previewTitle");
  const previewDescription = document.getElementById("previewDescription");
  const previewStart = document.getElementById("previewStart");
  const exerciseMedia = {
    squat: {
      photo: "https://images.unsplash.com/photo-1574680096145-d05b474e2155?auto=format&fit=crop&w=900&q=85",
      video: "https://www.youtube.com/embed?listType=search&list=squat%20proper%20form%20exercise&autoplay=1&mute=1",
      description: "Watch the full range of motion: sit your hips back, keep your chest lifted, then drive through your feet."
    },
    plank: {
      photo: "https://images.unsplash.com/photo-1566241142559-40e1dab266c6?auto=format&fit=crop&w=900&q=85",
      video: "https://www.youtube.com/embed?listType=search&list=plank%20proper%20form%20exercise&autoplay=1&mute=1",
      description: "Set your elbows beneath your shoulders, brace your core, and keep one long line from shoulders to heels."
    },
    cobra: {
      photo: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=900&q=85",
      video: "https://www.youtube.com/embed?listType=search&list=cobra%20stretch%20proper%20form&autoplay=1&mute=1",
      description: "Move slowly into the stretch, open through your chest, and keep the shoulders relaxed away from your ears."
    }
  };
  const quotes = [
    "The hardest part is showing up. You are already here.",
    "Small steps still move you forward. Take the next one.",
    "Your future self is built from the choices you make today.",
    "You do not need a perfect workout. You need an honest beginning.",
  ];

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

  function updateStats(history) {
    document.getElementById("sessionCount").textContent = history.length;
    document.getElementById("minuteCount").textContent = Math.round(
      history.reduce((total, item) => total + (item.duration_seconds || 0), 0) / 60
    );
    const days = new Set(history.map((item) => new Date(item.started_at).toDateString()));
    document.getElementById("bestStreak").textContent = days.size;
    document.getElementById("dailyQuote").textContent = quotes[new Date().getDate() % quotes.length];
  }

  function closePreview() {
    previewModal.hidden = true;
    previewVideo.src = "";
    document.body.classList.remove("modal-open");
  }

  function openPreview(exercise) {
    const media = exerciseMedia[exercise.name] || {};
    previewTitle.textContent = exercise.display_name;
    previewDescription.textContent = media.description || "Watch the movement, then start your coached session when you are ready.";
    previewStart.href = `predict.html?exercise=${encodeURIComponent(exercise.name)}`;
    previewVideo.src = media.video || "https://www.youtube.com/embed?listType=search&list=exercise%20form";
    previewModal.hidden = false;
    document.body.classList.add("modal-open");
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
        const typeText = ex.type === "reps" ? "Build strength · reps" : "Find your calm · hold";
        const media = exerciseMedia[ex.name] || {};
        return `
          <article class="exercise-card" style="--exercise-photo: url('${media.photo || ""}')">
            <div class="exercise-photo"><span class="exercise-badge">${ex.type === "reps" ? "REPS" : "HOLD"}</span></div>
            <div class="exercise-card-body">
              <div class="exercise-card-top"><h3>${ex.display_name}</h3><span class="arrow-mark">&rarr;</span></div>
              <span class="exercise-type">${typeText}</span>
              <div class="exercise-actions"><button class="btn btn-preview" type="button" data-preview="${ex.name}">Watch preview</button><a class="exercise-cta" href="predict.html?exercise=${encodeURIComponent(ex.name)}">Start session</a></div>
            </div>
          </article>
        `;
      })
      .join("");
    exerciseGrid.querySelectorAll("[data-preview]").forEach((button) => {
      button.addEventListener("click", () => {
        const exercise = exercises.find((item) => item.name === button.dataset.preview);
        if (exercise) openPreview(exercise);
      });
    });
  }

  previewModal.querySelectorAll("[data-close-preview]").forEach((element) => element.addEventListener("click", closePreview));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !previewModal.hidden) closePreview();
  });

  async function loadHistory() {
    const res = await fetch("/api/history");
    const data = await res.json();
    if (!data.ok || data.history.length === 0) {
      updateStats([]);
      historyWrap.innerHTML = `<div class="empty-note">No sessions yet — finish a live workout to see it here.</div>`;
      return;
    }
    updateStats(data.history);
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
