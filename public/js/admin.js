document.getElementById("load").addEventListener("click", load);
document.getElementById("refresh").addEventListener("click", load);
document.getElementById("login").addEventListener("click", login);
document.getElementById("logout").addEventListener("click", logout);

async function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) {
        document.getElementById('status').textContent = 'Username and password required';
        return;
    }
    document.getElementById('status').textContent = 'Logging in...';
    try {
        const res = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            cache: 'no-store',
        });
        const data = await res.json();
        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
        if (data && data.ok) {
            document.getElementById('status').textContent = `Authenticated as ${data.username}`;
        } else {
            document.getElementById('status').textContent = data.error || 'Login failed';
        }
    } catch (e) {
        document.getElementById('status').textContent = e.message;
    }
}

async function logout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    document.getElementById('status').textContent = 'Logged out';
}

async function load() {
    const secret = document.getElementById("secret").value.trim();

    document.getElementById("status").textContent = "Loading...";
    try {
        const headers = {};
        if (secret) headers['x-admin-secret'] = secret;

        const res = await fetch(`/api/admin/stats`, {
            headers,
            cache: "no-store",
        });
        const data = await res.json();
        document.getElementById("raw").textContent = JSON.stringify(data, null, 2);
        if (data && data.ok) {
            document.getElementById("status").innerHTML = `
        <strong>Total users:</strong> ${data.totalUsers}<br/>
        <strong>Logged-in sessions:</strong> ${data.loggedInSessions ?? 'N/A'}<br/>
        <strong>Active live sessions:</strong> ${data.activeLiveSessions ?? 'N/A'}<br/>
        <strong>Recent workouts total:</strong> ${data.recentWorkouts ?? 'N/A'}`;
        } else {
            document.getElementById("status").textContent = data.error || 'Error';
        }
    } catch (e) {
        document.getElementById("status").textContent = e.message;
        document.getElementById("raw").textContent = String(e);
    }
}
