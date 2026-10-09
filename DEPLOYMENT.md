# Deployment

Deploy the frontend and Node API together to Vercel. Keep the existing Python
ML service on Render. PostgreSQL is required because Vercel's filesystem and
in-memory process state are temporary.

## 1. Create a PostgreSQL database

Create a PostgreSQL database with a provider such as Neon or Supabase. Copy its
PostgreSQL connection string. Use the provider's TLS-enabled URL for production.
The app creates its user, workout history, and active workout tables at runtime;
the session store creates its own table.

Existing SQLite users and workout history are not automatically copied to this
new database.

## 2. Deploy to Vercel

1. Push the latest project changes to GitHub, then import the repository into
   Vercel.
2. Use the repository root as the project root. The included `vercel.json`
   runs `npm run build` and publishes `dist`; the `api/` directory contains
   the serverless Node API.
3. In **Project Settings → Environment Variables**, add these server-side
   variables for Production (and Preview too if you use preview deployments):
   - `DATABASE_URL`: the hosted PostgreSQL connection string.
   - `SESSION_SECRET`: a long, random secret used to sign login sessions.
   - `ML_SERVICE_URL`: the base URL of the already-deployed Render ML service,
     with no trailing slash.
   - `ML_SERVICE_KEY`: the same key configured on the Render ML service. If
     the ML service does not require a key, leave this variable unset.
4. Save the variables and deploy or redeploy. No `BACKEND_URL` or
   `FRONTEND_URLS` is needed: browser requests use the same Vercel origin as
   the frontend.
5. Verify `https://<your-vercel-domain>/api/health` returns
   `{"ok":true,"service":"backend"}`. Then register/sign in and test a workout.

For Vercel Preview deployments, each preview uses the same configured database,
session secret, and Render ML service unless you assign different environment
values.

## Vercel runtime limits

Vercel's serverless request-body limit restricts training-sample uploads to
about 3 MB in this deployment. The live-camera frames are sent as small JSON
requests. Long model-training requests can exceed the function-duration limit
on lower Vercel plans; use a plan with a suitable function duration or train
models through another workflow on the Render ML service.

## Local development

Set `DATABASE_URL` and `SESSION_SECRET` in `.env`; for a local PostgreSQL
instance, set `DATABASE_SSL=false`. Set `ML_SERVICE_URL` to the local or
deployed ML service URL. Start the Python ML service if running it locally,
then run `npm start`. The frontend and API are served from
`http://localhost:3000`.
