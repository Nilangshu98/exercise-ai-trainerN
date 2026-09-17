const ML_SERVICE_URL = (process.env.ML_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");
const ML_SERVICE_KEY = process.env.ML_SERVICE_KEY;

let cache = null;

async function getExercises({ forceRefresh = false } = {}) {
    if (cache && !forceRefresh) return cache;
    const headers = ML_SERVICE_KEY ? { "X-ML-Service-Key": ML_SERVICE_KEY } : {};
    const response = await fetch(`${ML_SERVICE_URL}/exercises`, { headers });
    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || `ML service returned HTTP ${response.status}`);
    }
    cache = data.exercises;
    return cache;
}

function invalidateCache() {
    cache = null;
}

module.exports = { getExercises, invalidateCache };
