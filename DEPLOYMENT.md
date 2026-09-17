# Deployment

The repository is split into three services.

## Railway ML service

Deploy the repository to Railway. Railway uses `Dockerfile`, which runs `python python/ml_service.py`. Set `ML_SERVICE_KEY` to a secret and copy the public Railway URL.

Add a Railway volume mounted at `/app/models` and `/app/dataset` (or otherwise persist those directories). Training writes model files there, and container redeploys should not erase them.

## Render backend

Deploy the repository to Render as a Node web service:

- Build command: `npm ci`
- Start command: `npm start`
- `ML_SERVICE_URL`: the Railway URL
- `ML_SERVICE_KEY`: the same secret used on Railway
- `SESSION_SECRET`: a long random secret
- `FRONTEND_URLS`: the final Vercel URL

The included `render.yaml` adds a persistent disk for SQLite. Dataset uploads and training are proxied to Railway, where the ML files live.

## Vercel frontend

Deploy the repository to Vercel as a static site. Set `BACKEND_URL` to the Render URL. The included `vercel.json` uses `npm run build` and publishes `dist`.
