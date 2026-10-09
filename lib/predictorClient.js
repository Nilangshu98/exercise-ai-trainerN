const mlServiceUrl = process.env.ML_SERVICE_URL || "http://localhost:8000";
const ML_SERVICE_URL = (mlServiceUrl.match(/^https?:\/\//i)
    ? mlServiceUrl
    : `https://${mlServiceUrl}`).replace(/\/$/, "");
const ML_SERVICE_KEY = process.env.ML_SERVICE_KEY;

class PredictorClient {
    async _post(path, payload = {}) {
        const headers = { "Content-Type": "application/json" };
        if (ML_SERVICE_KEY) headers["X-ML-Service-Key"] = ML_SERVICE_KEY;

        const response = await fetch(`${ML_SERVICE_URL}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `ML service returned HTTP ${response.status}`);
        }
        return result;
    }

    call(requestObj) {
        return this._post("/predict", requestObj);
    }

    reloadModels() {
        return this._post("/reload");
    }

    uploadDataset(payload) {
        return this._post("/dataset", payload);
    }

    train(payload) {
        return this._post("/train", payload);
    }
}

module.exports = PredictorClient;
