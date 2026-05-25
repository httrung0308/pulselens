# Demo Capture Guide

Use this checklist to create portfolio assets for the README, GitHub profile, and LinkedIn posts.

## Setup

Start the backend:

```bash
cd backend
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend:

```bash
cd frontend
npm run dev
```

Open http://127.0.0.1:3000.

## Capture Sequence

1. Click **Start replay** and stay on **War Room**.
2. Wait until the replay reaches 100% and the top hypothesis appears.
3. Capture `docs/screenshots/war-room.png`.
4. Open **Evidence**, filter to `payment-service`, and capture `docs/screenshots/evidence.png`.
5. Open **Services** and capture `docs/screenshots/services.png`.
6. Open **Postmortem**, click **Generate**, and capture `docs/screenshots/postmortem.png`.

## Recommended 60-Second Video

- 0-10s: show empty dashboard, click **Start replay**.
- 10-25s: show realtime timeline, progress bar, latency chart, and SEV banner.
- 25-40s: show root-cause hypothesis with evidence IDs.
- 40-50s: show Evidence and Services tabs.
- 50-60s: generate the postmortem and show citation coverage.

## Narration

Short script:

> PulseLens replays a checkout outage and streams OpenTelemetry-style telemetry into an incident war room. The backend correlates payment latency, checkout errors, and retry queue growth, then ranks root-cause hypotheses with cited evidence. The postmortem writer only summarizes claims backed by evidence IDs, so the demo shows AI as an investigation workflow rather than a generic chatbot.
