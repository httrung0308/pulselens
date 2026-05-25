# Deployment Guide

PulseLens has two deployment modes: a fast local SQLite mode and a Postgres mode for portfolio demos.

## Local Mode

Backend:

```bash
cd backend
python -m pip install -e ".[dev]"
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

This creates `backend/pulselens.db` automatically. Delete that file when you want a clean local demo.

Playwright browser tests need Chromium once:

```bash
cd frontend
npx playwright install chromium
```

On slow networks this download can time out. PulseLens still runs without Playwright; only `npm run test:e2e` depends on that browser binary.

## Docker Compose

```bash
docker compose up --build
```

Services:

- Frontend: http://localhost:3000
- Backend: http://localhost:8000
- Postgres: localhost:5432

The compose stack uses `pgvector/pgvector:pg16`, enables the `vector` extension, and points the backend at Postgres through `PULSELENS_DATABASE_URL`.

## Vercel + Render/Fly + Supabase

Recommended hosted setup:

- Deploy `frontend/` to Vercel.
- Deploy `backend/` to Render, Fly.io, or Railway.
- Use Supabase Postgres and enable the `vector` extension.

Backend environment variables:

```bash
PULSELENS_AI_MODE=mock
PULSELENS_DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/postgres
PULSELENS_CORS_ORIGINS=https://your-vercel-app.vercel.app
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

Frontend environment variable:

```bash
NEXT_PUBLIC_API_URL=https://your-backend.example.com
```

Keep `PULSELENS_AI_MODE=mock` for free public demos. Switch it away from `mock` only when you have an API key and want real model-generated postmortems.
