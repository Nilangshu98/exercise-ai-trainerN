(function () {
  const params = new URLSearchParams(window.location.search);
  const exerciseName = params.get("exercise");

  const els = {
    title: document.getElementById("exerciseTitle"),
    video: document.getElementById("video"),
    overlay: document.getElementById("overlay"),
    cameraFrame: document.getElementById("cameraFrame"),
    statusPill: document.getElementById("statusPill"),
    timerPill: document.getElementById("timerPill"),
    tipBanner: document.getElementById("tipBanner"),
    ringFg: document.getElementById("ringFg"),
    ringValue: document.getElementById("ringValue"),
    metricPrimary: document.getElementById("metricPrimary"),
    metricPrimaryValue: document.getElementById("metricPrimaryValue"),
    metricPrimaryLabel: document.getElementById("metricPrimaryLabel"),
    elapsedValue: document.getElementById("elapsedValue"),
    timerSelect: document.getElementById("timerSelect"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    featureList: document.getElementById("featureList"),
    summaryModal: document.getElementById("summaryModal"),
    summaryExercise: document.getElementById("summaryExercise"),
    summaryGrid: document.getElementById("summaryGrid"),
    closeSummaryBtn: document.getElementById("closeSummaryBtn"),
    usernameLabel: document.getElementById("usernameLabel"),
    logoutBtn: document.getElementById("logoutBtn"),
  };

  // Body-only MediaPipe Pose connections (skip fine face-mesh points)
  const CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
    [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
    [15, 17], [15, 19], [15, 21], [17, 19],
    [16, 18], [16, 20], [16, 22], [18, 20],
  ];

  const RING_CIRC = 389.6; // 2 * PI * 62
  const FRAME_INTERVAL_MS = 350;

  let exerciseCfg = null;
  let sessionId = null;
  let stream = null;
  let captureTimer = null;
  let selectedTimerSeconds = 0;
  let captureCanvas = document.createElement("canvas");

  function setTip(text, kind) {
    els.tipBanner.style.display = "block";
    els.tipBanner.textContent = text;
    els.tipBanner.className = "tip-banner" + (kind ? " " + kind : "");
  }

  function setCameraFeedbackStatus(status) {
    els.cameraFrame.classList.remove("correct", "warning", "wrong", "neutral");
    if (status) {
      els.cameraFrame.classList.add(status);
    }
  }

  function setFeedbackText(text) {
    const value = text || "Waiting...";
    const el = document.getElementById("feedback-text");
    if (el) el.textContent = value;
  }

  function setRing(percent, correct) {
    const clamped = Math.max(0, Math.min(100, percent));
    const offset = RING_CIRC - (clamped / 100) * RING_CIRC;
    els.ringFg.style.strokeDashoffset = offset;
    els.ringFg.classList.toggle("incorrect", correct === false);
    els.ringValue.textContent = Math.round(clamped) + "%";
  }

  function pulse(el) {
    el.classList.remove("pulse");
    void el.offsetWidth; // restart animation
    el.classList.add("pulse");
  }

  function drawSkeleton(landmarks) {
    const canvas = els.overlay;
    const ctx = canvas.getContext("2d");
    canvas.width = els.video.videoWidth || 640;
    canvas.height = els.video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) return;

    ctx.strokeStyle = "#5EEAD4";
    ctx.lineWidth = 3;
    CONNECTIONS.forEach(([a, b]) => {
      const p1 = landmarks[a], p2 = landmarks[b];
      if (!p1 || !p2) return;
      ctx.beginPath();
      ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
      ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
      ctx.stroke();
    });
    ctx.fillStyle = "#FBBF24";
    landmarks.forEach((lm) => {
      if (lm.visibility != null && lm.visibility < 0.4) return;
      ctx.beginPath();
      ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  async function loadExerciseCfg() {
    try {
      const res = await apiFetch("/api/exercises");
      const data = await res.json();
      if (!data.ok || !data.exercises[exerciseName]) {
        els.title.textContent = data.error || "Unknown exercise";
        return null;
      }
      return data.exercises[exerciseName];
    } catch (error) {
      els.title.textContent = "Workout service unavailable";
      setTip(error.message, "incorrect");
      return null;
    }
  }

  function setupUiForType(cfg) {
    els.title.textContent = `${cfg.icon} ${cfg.display_name}`;
    if (cfg.type === "reps") {
      els.metricPrimaryLabel.textContent = "Reps";
    } else {
      els.metricPrimaryLabel.textContent = "Hold time";
    }
    if (!cfg.trained) {
      setTip(`'${cfg.display_name}' hasn't been trained yet. Visit the Train page first.`, "incorrect");
      els.startBtn.disabled = true;
    }
  }

  els.timerSelect.addEventListener("click", (e) => {
    const chip = e.target.closest(".timer-chip");
    if (!chip) return;
    [...els.timerSelect.children].forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    selectedTimerSeconds = parseInt(chip.dataset.secs, 10);
  });

  async function startCamera() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    els.video.srcObject = stream;
    els.statusPill.textContent = "Camera on";
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    els.statusPill.textContent = "Camera off";
  }

  function captureFrameBase64() {
    const video = els.video;
    captureCanvas.width = video.videoWidth || 640;
    captureCanvas.height = video.videoHeight || 480;
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    return captureCanvas.toDataURL("image/jpeg", 0.6);
  }

  async function captureLoop() {
    if (!sessionId) return;
    try {
      const image = captureFrameBase64();
      const res = await apiFetch("/api/live/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, image }),
      });
      const data = await res.json();
      if (!data.ok) {
        setTip(data.error || "Something went wrong.", "incorrect");
        return;
      }
      handleFrameResult(data);
      if (data.timerExpired) {
        await stopSession();
        return;
      }
    } catch (err) {
      setTip("Lost connection to the server.", "incorrect");
    }
  }

  let lastReps = 0;
  function handleFrameResult(data) {
    drawSkeleton(data.landmarks);

    const status = data.status || (data.correct === true ? "correct" : (data.correct === false ? (data.confidence >= 0.6 ? "warning" : "wrong") : "wrong"));
    if (!data.personDetected) {
      setTip("No person detected — step into frame.", null);
      setFeedbackText(data.feedback || "No person detected — step into frame.");
      setRing(0, null);
    } else if (!data.modelAvailable) {
      setTip(data.feedback || data.tips[0] || "Model not trained yet.", "incorrect");
      setFeedbackText(data.feedback || data.tips[0] || "Model not trained yet.");
    } else {
      const kind = data.correct ? "correct" : "incorrect";
      setTip(data.feedback || data.tips.join(" "), kind);
      setFeedbackText(data.feedback || data.tips.join(" "));
      setRing((data.confidence || 0) * 100, data.correct);
    }
    setCameraFeedbackStatus(status);

    if (exerciseCfg.type === "reps") {
      els.metricPrimaryValue.textContent = data.reps;
      if (data.reps !== lastReps) {
        pulse(els.metricPrimary);
        lastReps = data.reps;
      }
    } else {
      els.metricPrimaryValue.textContent = data.holdSeconds + "s";
    }

    els.elapsedValue.textContent = data.elapsedSeconds + "s";

    if (data.remainingSeconds != null) {
      els.timerPill.style.display = "inline-block";
      els.timerPill.textContent = `${data.remainingSeconds}s left`;
    }

    if (data.features) {
      els.featureList.innerHTML = Object.entries(data.features)
        .map(([k, v]) => `<div><span class="k">${k}</span>: ${v.toFixed(1)}°</div>`)
        .join("");
    }
  }

  async function startSession() {
    els.startBtn.disabled = true;
    try {
      await startCamera();
    } catch (e) {
      setTip("Could not access the camera. Check browser permissions.", "incorrect");
      els.startBtn.disabled = false;
      return;
    }

    try {
      const res = await apiFetch("/api/live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exercise: exerciseName, timerSeconds: selectedTimerSeconds || null }),
      });
      const data = await res.json();
      if (!data.ok) {
        setTip(data.error, "incorrect");
        stopCamera();
        els.startBtn.disabled = false;
        return;
      }

      sessionId = data.sessionId;
      lastReps = 0;
      els.startBtn.style.display = "none";
      els.stopBtn.style.display = "inline-flex";
      captureTimer = setInterval(captureLoop, FRAME_INTERVAL_MS);
    } catch (error) {
      setTip(`Could not start workout: ${error.message}`, "incorrect");
      stopCamera();
      els.startBtn.disabled = false;
    }
  }

  async function stopSession() {
    if (captureTimer) clearInterval(captureTimer);
    captureTimer = null;
    els.startBtn.disabled = false;
    els.startBtn.style.display = "inline-flex";
    els.stopBtn.style.display = "none";
    els.timerPill.style.display = "none";

    if (sessionId) {
      const res = await apiFetch("/api/live/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      sessionId = null;
      stopCamera();
      if (data.ok) showSummary(data.summary);
    } else {
      stopCamera();
    }
  }

  function showSummary(summary) {
    els.summaryExercise.textContent = `${exerciseCfg.icon} ${exerciseCfg.display_name}`;
    const metricLabel = summary.type === "reps" ? "Reps completed" : "Time held (good form)";
    const metricValue = summary.type === "reps" ? summary.reps : summary.holdSeconds + "s";
    els.summaryGrid.innerHTML = `
      <div class="metric"><div class="value">${metricValue}</div><div class="label">${metricLabel}</div></div>
      <div class="metric"><div class="value">${summary.durationSeconds}s</div><div class="label">Duration</div></div>
      <div class="metric"><div class="value">${summary.avgAccuracy.toFixed(0)}%</div><div class="label">Avg accuracy</div></div>
      <div class="metric"><div class="value">${summary.bestAccuracy.toFixed(0)}%</div><div class="label">Best accuracy</div></div>
    `;
    els.summaryModal.classList.add("show");
  }

  els.closeSummaryBtn.addEventListener("click", () => {
    window.location.href = "index.html";
  });

  els.startBtn.addEventListener("click", startSession);
  els.stopBtn.addEventListener("click", stopSession);

  els.logoutBtn.addEventListener("click", async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  window.addEventListener("beforeunload", () => {
    if (sessionId) navigator.sendBeacon?.(apiUrl("/api/live/stop"), JSON.stringify({ sessionId }));
  });

  (async () => {
    const me = await (await apiFetch("/api/auth/me")).json();
    if (!me.loggedIn) {
      window.location.href = "/login.html";
      return;
    }
    els.usernameLabel.textContent = me.username;

    if (!exerciseName) {
      els.title.textContent = "No exercise selected";
      return;
    }
    exerciseCfg = await loadExerciseCfg();
    if (exerciseCfg) setupUiForType(exerciseCfg);
  })();
})();
