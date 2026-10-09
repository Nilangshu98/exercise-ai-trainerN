# Deployment

The project runs as two Render backend services and one Vercel static frontend.
The root `render.yaml` is a Render Blueprint for both backend services.

## Render

1. In Render, create a Blueprint instance from this repository and apply
   `render.yaml`. It creates:
   - `exercise-ai-trainer-api`, the Node/Express API with a persistent SQLite disk.
   - `exercise-ai-trainer-ml`, the Dockerized Python/MediaPipe inference service
     with a persistent disk for models and training data.
2. Set `SESSION_SECRET` on the Node service to a long, random secret.
3. Set the same strong, random `ML_SERVICE_KEY` on both services. The Node
   service uses it for authenticated calls to the Python service.
4. Copy the Node service's public URL for the Vercel configuration below.
   The Blueprint wires `ML_SERVICE_URL` to the ML service automatically.

The ML service seeds its persistent disk with the repository's bundled models
and sample dataset the first time it starts. Model training and uploaded samples
are then retained across redeploys.

## Vercel

1. Import this repository as a Vercel project. The included `vercel.json`
   publishes the static site from `dist`, built with `npm run build`.
2. Add `BACKEND_URL` as a Vercel environment variable containing the public
   Node service URL from Render (for example,
   `https://exercise-ai-trainer-api.onrender.com`).
3. Redeploy after setting the variable so the frontend build embeds the API URL.

Set `FRONTEND_URLS` on the Render Node service to the Vercel production URL
without a trailing slash. Add comma-separated preview URLs only if those
previews need to sign in. `BACKEND_URL` must point to the Node API service,
not the Python ML service.

Check the deployed services:

- `https://<render-api>/health` should return `{"ok":true,"service":"backend"}`.
- `https://<render-ml>/health` should return `{"ok":true,"service":"ml"}`.
- The Vercel site should be able to register/sign in, load exercises, and start a
  workout.
