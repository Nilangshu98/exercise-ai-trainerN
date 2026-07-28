(function () {
  const trainList = document.getElementById("trainList");
  const usernameLabel = document.getElementById("usernameLabel");
  const logoutBtn = document.getElementById("logoutBtn");

  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  function cardHtml(ex) {
    const statusText = ex.trained
      ? `Trained · ${(ex.accuracy * 100).toFixed(0)}% validation accuracy · ${ex.n_samples} samples · ${ex.trained_at || ""}`
      : "Not trained yet";
    return `
      <div class="train-card" data-exercise="${ex.name}">
        <div class="info">
          <h3>${ex.icon} ${ex.display_name}</h3>
          <div class="meta">${statusText}</div>
        </div>
        <div class="actions">
          <div class="upload-row">
            <select class="uploadLabel">
              <option value="correct">Correct sample</option>
              <option value="incorrect">Incorrect sample</option>
            </select>
            <input type="file" class="uploadFile" accept="image/*,video/*" />
          </div>
          <button class="btn btn-ghost retrainBtn">Retrain</button>
        </div>
        <div class="train-log"></div>
      </div>
    `;
  }

  async function loadList() {
    const res = await fetch("/api/exercises");
    const data = await res.json();
    if (!data.ok) {
      trainList.innerHTML = `<div class="empty-note">${data.error}</div>`;
      return;
    }
    trainList.innerHTML = Object.values(data.exercises).map(cardHtml).join("");
    attachHandlers();
  }

  function attachHandlers() {
    document.querySelectorAll(".train-card").forEach((card) => {
      const exercise = card.dataset.exercise;
      const retrainBtn = card.querySelector(".retrainBtn");
      const fileInput = card.querySelector(".uploadFile");
      const labelSelect = card.querySelector(".uploadLabel");
      const log = card.querySelector(".train-log");

      retrainBtn.addEventListener("click", async () => {
        retrainBtn.disabled = true;
        const original = retrainBtn.textContent;
        retrainBtn.innerHTML = '<span class="spinner"></span> Training…';
        log.classList.add("show");
        log.textContent = "Extracting pose features and training model — this can take a minute for larger datasets...";
        try {
          const res = await fetch(`/api/train/${exercise}`, { method: "POST" });
          const data = await res.json();
          if (!data.ok) {
            log.textContent = "Error: " + data.error;
          } else if (!data.result.success) {
            log.textContent = "Training failed: " + data.result.error;
          } else {
            log.textContent = data.log;
            await loadList();
          }
        } catch (e) {
          log.textContent = "Error: " + e.message;
        }
        retrainBtn.disabled = false;
        retrainBtn.textContent = original;
      });

      fileInput.addEventListener("change", async () => {
        if (!fileInput.files.length) return;
        const file = fileInput.files[0];
        const fd = new FormData();
        fd.append("file", file);
        fd.append("label", labelSelect.value);
        log.classList.add("show");
        log.textContent = `Uploading ${file.name}...`;
        try {
          const res = await fetch(`/api/dataset/${exercise}/upload`, { method: "POST", body: fd });
          const data = await res.json();
          log.textContent = data.ok
            ? `Saved as ${data.saved}. Click Retrain to include it in the model.`
            : "Upload failed: " + data.error;
        } catch (e) {
          log.textContent = "Upload failed: " + e.message;
        }
        fileInput.value = "";
      });
    });
  }

  (async () => {
    const me = await (await fetch("/api/auth/me")).json();
    if (!me.loggedIn) {
      window.location.href = "/login.html";
      return;
    }
    usernameLabel.textContent = me.username;
    loadList();
  })();
})();
