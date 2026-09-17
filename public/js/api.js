(function () {
  const base = (window.APP_CONFIG?.apiBase || "").replace(/\/$/, "");
  window.apiUrl = (path) => `${base}${path}`;
  window.apiFetch = (path, options = {}) => fetch(window.apiUrl(path), {
    credentials: "include",
    ...options,
  });
})();