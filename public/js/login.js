let mode = "login"; // "login" | "register"

const formTitle = document.getElementById("formTitle");
const formSubtitle = document.getElementById("formSubtitle");
const submitBtn = document.getElementById("submitBtn");
const toggleLabel = document.getElementById("toggleLabel");
const toggleModeBtn = document.getElementById("toggleModeBtn");
const formError = document.getElementById("formError");
const authForm = document.getElementById("authForm");

// If already logged in, skip straight to the dashboard.
apiFetch("/api/auth/me")
  .then((r) => r.json())
  .then((data) => {
    if (data.loggedIn) window.location.href = "index.html";
  });

toggleModeBtn.addEventListener("click", () => {
  mode = mode === "login" ? "register" : "login";
  formError.textContent = "";
  if (mode === "register") {
    formTitle.textContent = "Create your account";
    formSubtitle.textContent = "Set a username and password to save your workout history";
    submitBtn.textContent = "Create account";
    toggleLabel.textContent = "Already have an account?";
    toggleModeBtn.textContent = "Sign in";
  } else {
    formTitle.textContent = "Welcome back";
    formSubtitle.textContent = "Sign in to start your AI-coached workout";
    submitBtn.textContent = "Sign in";
    toggleLabel.textContent = "Don't have an account?";
    toggleModeBtn.textContent = "Create one";
  }
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";
  submitBtn.disabled = true;

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";

  try {
    const res = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      formError.textContent = data.error || "Something went wrong";
      submitBtn.disabled = false;
      return;
    }
    window.location.href = "index.html";
  } catch (err) {
    formError.textContent = "Could not reach the server";
    submitBtn.disabled = false;
  }
});
